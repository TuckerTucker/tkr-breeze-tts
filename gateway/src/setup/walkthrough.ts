/**
 * The guided installation, phase by phase.
 *
 * Each phase first looks at what already exists — a working virtualenv, a
 * valid pair in `.env`, a deployed app — and reports it before asking anything,
 * so a rerun after a failure resumes rather than starting over. Progress is
 * saved to `.env` as soon as each value is known; a run that stops halfway
 * leaves a file the gateway can already partly validate.
 *
 * The two phases that spend GPU time (deploying and measuring) wait for an
 * explicit yes. Everything else states what it will do and does it.
 *
 * Credentials never reach the logger: the proxy pair is written to `.env` and
 * otherwise only passes through {@link validateProxyTokenPair}.
 *
 * @module
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { Logger } from 'pino';

import { ConfigError, parseEnvFile, validateProxyTokenPair } from '../config.js';
import { checkFfmpeg, type FfmpegStatus } from '../reference.js';
import { writeEnvFile } from './env-file.js';
import { ModalCli, ModalOutputError, type ModalAppSummary, type ProxyTokenPair } from './modal.js';
import type { Prompter } from './prompter.js';
import type { CommandRunner } from './runner.js';

/** Oldest Node the gateway declares in `engines`. */
export const MIN_NODE = { major: 20, minor: 11 } as const;

/**
 * Everything the Python side of the repo imports: the infra and bench runtime
 * dependencies plus their dev extras, so measuring and `npm run test:python`
 * both work from the environment this creates.
 */
export const PYTHON_PACKAGES: readonly string[] = [
  'modal',
  'huggingface_hub',
  'structlog',
  'httpx',
  'pytest',
];

/** The serving class and method behind each `@modal.asgi_app`. */
const SYNTHESIS_ENDPOINT = { className: 'BreezeService', methodName: 'serve' } as const;
const TRANSCRIPTION_ENDPOINT = { className: 'AsrService', methodName: 'serve' } as const;

/** Defaults offered for the deployment-time environment. */
export const DEPLOY_DEFAULTS = { gpu: 'H100', scaledownWindowS: '600' } as const;

/** Raised to stop the walkthrough with a remedy the operator can act on. */
export class SetupAbort extends Error {
  /** What the operator should do before running setup again. */
  readonly remedy: string;

  constructor(message: string, remedy: string) {
    super(message);
    this.name = 'SetupAbort';
    this.remedy = remedy;
  }
}

/** Switches from the command line. */
export interface WalkthroughOptions {
  /** Start the gateway at the end, with the terminal attached. */
  readonly start: boolean;
}

/** What the walkthrough needs injected. */
export interface WalkthroughDeps {
  readonly repoRoot: string;
  readonly runner: CommandRunner;
  readonly prompter: Prompter;
  /** Where operator-facing lines go. */
  readonly out: (line: string) => void;
  readonly logger: Logger;
  readonly options?: Partial<WalkthroughOptions>;
  /** Override for `process.version`, used by tests. */
  readonly nodeVersion?: string;
  /** Override for the ffmpeg probe, used by tests. */
  readonly probeFfmpeg?: () => Promise<FfmpegStatus>;
}

/**
 * Decide whether a Node version satisfies {@link MIN_NODE}.
 *
 * @param version - A `process.version` string such as `v20.19.5`.
 * @returns Whether it is new enough.
 */
export function nodeVersionSatisfies(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)/.exec(version);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > MIN_NODE.major || (major === MIN_NODE.major && minor >= MIN_NODE.minor);
}

/**
 * Whether an app is currently deployed under a given name.
 *
 * @param apps - The workspace listing.
 * @param name - The app to look for.
 * @returns True for a deployed app of that name.
 */
export function isDeployed(apps: readonly ModalAppSummary[], name: string): boolean {
  return apps.some((app) => app.name === name && app.state === 'deployed');
}

/** The walkthrough as one object, so phases share their context. */
class Walkthrough {
  private readonly repoRoot: string;
  private readonly runner: CommandRunner;
  private readonly prompter: Prompter;
  private readonly out: (line: string) => void;
  private readonly logger: Logger;
  private readonly options: WalkthroughOptions;
  private readonly nodeVersion: string;
  private readonly probeFfmpeg: () => Promise<FfmpegStatus>;

  private readonly envPath: string;
  private readonly examplePath: string;
  private readonly venvDir: string;
  private readonly modal: ModalCli;

  private apps: readonly ModalAppSummary[] = [];
  private appNames: { synthesis: string; transcription: string } | null = null;

  constructor(deps: WalkthroughDeps) {
    this.repoRoot = deps.repoRoot;
    this.runner = deps.runner;
    this.prompter = deps.prompter;
    this.out = deps.out;
    this.logger = deps.logger;
    this.options = { start: true, ...deps.options };
    this.nodeVersion = deps.nodeVersion ?? process.version;
    this.probeFfmpeg = deps.probeFfmpeg ?? (() => checkFfmpeg());

    this.envPath = join(this.repoRoot, '.env');
    this.examplePath = join(this.repoRoot, '.env.example');
    this.venvDir = join(this.repoRoot, '.venv');
    this.modal = new ModalCli({
      runner: this.runner,
      repoRoot: this.repoRoot,
      logger: this.logger,
      venvDir: this.venvDir,
    });
  }

  async run(): Promise<void> {
    await this.phase('Preflight', () => this.preflight());
    await this.phase('Python environment', () => this.pythonEnvironment());
    await this.phase('Modal account', () => this.modalAccount());
    await this.phase('Credentials', () => this.credentials());
    await this.phase('Synthesis service', () => this.synthesisService());
    await this.phase('Transcription service', () => this.transcriptionService());
    await this.phase('Measurements', () => this.measurements());
    await this.phase('Build', () => this.build());
    await this.finish();
  }

  private async phase(title: string, body: () => Promise<void>): Promise<void> {
    this.out('');
    this.out(`── ${title} ──`);
    this.logger.info({ phase: title }, 'phase start');
    await body();
    this.logger.info({ phase: title }, 'phase end');
  }

  private env(): Record<string, string> {
    return parseEnvFile(this.envPath);
  }

  private save(values: Readonly<Record<string, string>>): void {
    writeEnvFile(this.envPath, values, this.examplePath);
    this.logger.info({ keys: Object.keys(values) }, 'wrote .env');
  }

  private async streamOrAbort(
    label: string,
    command: string,
    args: readonly string[],
    remedy: string,
    env: Readonly<Record<string, string>> = {},
  ): Promise<void> {
    this.out(`$ ${[command, ...args].join(' ')}`);
    const code = await this.runner.stream(command, args, { cwd: this.repoRoot, env });
    if (code !== 0) {
      throw new SetupAbort(`${label} failed (exit ${code})`, remedy);
    }
  }

  // ── Phase 1 ────────────────────────────────────────────────────────────────

  private async preflight(): Promise<void> {
    if (!nodeVersionSatisfies(this.nodeVersion)) {
      throw new SetupAbort(
        `Node ${this.nodeVersion} is older than the ${MIN_NODE.major}.${MIN_NODE.minor} the gateway requires`,
        'Install Node 20.11 or newer, for example: nvm install 20',
      );
    }
    this.out(`Node ${this.nodeVersion}: ok`);

    const uv = await this.runner.capture('uv', ['--version']);
    if (uv.code !== 0) {
      throw new SetupAbort('uv is not installed', 'Install it with: brew install uv');
    }
    this.out(`${uv.stdout.trim()}: ok`);

    const ffmpeg = await this.probeFfmpeg();
    if (ffmpeg.available) {
      this.out(`${ffmpeg.version ?? 'ffmpeg'}: ok`);
    } else {
      this.out(
        `ffmpeg: not found. Recorded audio and non-WAV uploads will not convert until it is installed (${ffmpeg.remedy ?? 'brew install ffmpeg'}). Continuing.`,
      );
    }
  }

  // ── Phase 2 ────────────────────────────────────────────────────────────────

  private async pythonEnvironment(): Promise<void> {
    const probe = ['-c', `import ${PYTHON_PACKAGES.join(', ')}; print(modal.__version__)`];
    const existing = await this.runner.capture(this.modal.pythonBin, probe);
    if (existing.code === 0) {
      this.out(`.venv ready (modal ${existing.stdout.trim()}).`);
      return;
    }

    if (!existsSync(this.modal.pythonBin)) {
      this.out('Creating .venv with Python 3.12.');
      await this.streamOrAbort(
        'Creating the virtualenv',
        'uv',
        ['venv', this.venvDir, '--python', '3.12'],
        'Check that uv can find or download Python 3.12, then run setup again.',
      );
    }

    this.out(`Installing ${PYTHON_PACKAGES.join(', ')} into .venv.`);
    await this.streamOrAbort(
      'Installing Python packages',
      'uv',
      ['pip', 'install', '--python', this.modal.pythonBin, ...PYTHON_PACKAGES],
      'Check network access to PyPI, then run setup again.',
    );

    const after = await this.runner.capture(this.modal.pythonBin, probe);
    if (after.code !== 0) {
      throw new SetupAbort(
        'the Python environment still does not import its packages',
        `Inspect the error and run setup again:\n${after.stderr.trim()}`,
      );
    }
    this.out(`.venv ready (modal ${after.stdout.trim()}).`);
  }

  // ── Phase 3 ────────────────────────────────────────────────────────────────

  private async modalAccount(): Promise<void> {
    let listing = await this.modal.listApps();
    if (!listing.ok && listing.authFailure) {
      this.out('The Modal CLI is not signed in. Starting Modal setup in this terminal.');
      const code = await this.modal.setup();
      if (code !== 0) {
        throw new SetupAbort(
          `modal setup exited with ${code}`,
          `Sign in by hand, then run setup again:\n  ${this.modal.modalBin} setup`,
        );
      }
      listing = await this.modal.listApps();
    }
    if (!listing.ok) {
      throw new SetupAbort(
        'the Modal CLI could not list apps',
        `Inspect the error and run setup again:\n${listing.stderr.trim()}`,
      );
    }
    this.apps = listing.apps;
    try {
      this.appNames = await this.modal.appNames();
    } catch (error) {
      if (error instanceof ModalOutputError) {
        throw new SetupAbort(error.message, 'Check that .venv imports infra/config.py, then run setup again.');
      }
      throw error;
    }
    this.out('Modal account: signed in.');
  }

  private names(): { synthesis: string; transcription: string } {
    if (!this.appNames) throw new Error('app names are read in the Modal account phase');
    return this.appNames;
  }

  // ── Phase 4 ────────────────────────────────────────────────────────────────

  private async credentials(): Promise<void> {
    const env = this.env();
    let existingValid = false;
    try {
      validateProxyTokenPair(env.MODAL_KEY, env.MODAL_SECRET);
      existingValid = true;
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      if (env.MODAL_KEY || env.MODAL_SECRET) {
        this.out(`The pair in .env is not usable: ${error.message}`);
      }
    }

    if (existingValid) {
      const keep = await this.prompter.confirm(
        'A proxy token pair is already in .env. Keep it?',
        true,
      );
      if (keep) {
        this.out('Keeping the existing pair.');
        return;
      }
    }

    const choice = await this.prompter.choose(
      'How should the proxy token pair be provided?',
      [
        'Create a new pair now with the Modal CLI (recommended)',
        'Paste an existing wk-/ws- pair',
      ],
      0,
    );

    const pair = choice === 0 ? await this.createPair() : await this.pastePair();
    this.save({ MODAL_KEY: pair.key, MODAL_SECRET: pair.secret });
    this.out('Proxy token pair written to .env (owner-only).');
  }

  private async createPair(): Promise<ProxyTokenPair> {
    let pair: ProxyTokenPair;
    try {
      pair = await this.modal.createProxyToken();
    } catch (error) {
      if (error instanceof ModalOutputError) {
        throw new SetupAbort(error.message, 'Create the pair by hand and paste it on the next run:\n  modal workspace proxy-tokens create --json');
      }
      throw error;
    }
    try {
      validateProxyTokenPair(pair.key, pair.secret);
    } catch (error) {
      if (error instanceof ConfigError) {
        throw new SetupAbort(`the created pair failed validation: ${error.message}`, error.remedy);
      }
      throw error;
    }
    return pair;
  }

  private async pastePair(): Promise<ProxyTokenPair> {
    for (;;) {
      const key = await this.prompter.ask('Modal-Key (wk-…)');
      const secret = await this.prompter.askSecret('Modal-Secret (ws-…, hidden)');
      try {
        validateProxyTokenPair(key, secret);
        return { key, secret };
      } catch (error) {
        if (!(error instanceof ConfigError)) throw error;
        this.out(`${error.message}`);
        this.out(error.remedy);
      }
    }
  }

  // ── Phase 5 ────────────────────────────────────────────────────────────────

  private async askDeployEnvironment(): Promise<Record<string, string>> {
    const gpu = await this.prompter.ask('GPU type for synthesis', DEPLOY_DEFAULTS.gpu);
    let window: string;
    for (;;) {
      window = await this.prompter.ask(
        'Warm window in seconds (the gateway reads readiness from the same value)',
        DEPLOY_DEFAULTS.scaledownWindowS,
      );
      if (/^[1-9]\d*$/.test(window)) break;
      this.out('Enter a positive whole number of seconds.');
    }
    this.save({ GATEWAY_SCALEDOWN_WINDOW_S: window });
    return { BREEZE_GPU: gpu, BREEZE_SCALEDOWN_WINDOW_S: window };
  }

  private async synthesisService(): Promise<void> {
    const { synthesis } = this.names();
    const env = this.env();
    const deployed = isDeployed(this.apps, synthesis);

    let deployNow: boolean;
    if (deployed) {
      this.out(`"${synthesis}" is already deployed.`);
      deployNow = await this.prompter.confirm(
        'Redeploy it now? The image is rebuilt only if its definition changed.',
        false,
      );
    } else {
      this.out(`"${synthesis}" is not deployed yet. Deploying fills the weights Volume and builds the GPU image.`);
      deployNow = await this.prompter.confirm('Deploy the synthesis service now?', true);
      if (!deployNow) {
        throw new SetupAbort(
          'the demo cannot run without the synthesis service',
          'Run setup again when you are ready to deploy, or deploy by hand:\n  modal run infra/weights.py && modal deploy infra/service.py',
        );
      }
    }

    if (deployNow) {
      const deployEnv = await this.askDeployEnvironment();
      this.out('$ modal run infra/weights.py');
      const weights = await this.modal.run('infra/weights.py', deployEnv);
      if (weights !== 0) {
        throw new SetupAbort(
          `filling the weights Volume failed (exit ${weights})`,
          'Inspect the output above, then run setup again; downloaded files are kept.',
        );
      }
      this.out('$ modal deploy infra/service.py');
      const deploy = await this.modal.deploy('infra/service.py', deployEnv);
      if (deploy !== 0) {
        throw new SetupAbort(
          `deploying the synthesis service failed (exit ${deploy})`,
          'Inspect the output above, then run setup again.',
        );
      }
    }

    if (deployNow || !env.MODAL_ENDPOINT_URL) {
      const url = await this.resolveUrl(synthesis, SYNTHESIS_ENDPOINT);
      this.save({ MODAL_ENDPOINT_URL: url });
      this.out(`MODAL_ENDPOINT_URL set to ${url}`);
    } else {
      this.out('MODAL_ENDPOINT_URL is already set.');
    }
  }

  private async resolveUrl(
    appName: string,
    endpoint: { className: string; methodName: string },
  ): Promise<string> {
    try {
      return await this.modal.webUrl(appName, endpoint.className, endpoint.methodName);
    } catch (error) {
      if (error instanceof ModalOutputError) {
        throw new SetupAbort(
          error.message,
          `Copy the URL that "modal deploy" printed into .env by hand, then run setup again.`,
        );
      }
      throw error;
    }
  }

  // ── Phase 6 ────────────────────────────────────────────────────────────────

  private async transcriptionService(): Promise<void> {
    const { transcription } = this.names();
    const env = this.env();
    const deployed = isDeployed(this.apps, transcription);

    let deployNow: boolean;
    if (deployed) {
      this.out(`"${transcription}" is already deployed.`);
      deployNow = await this.prompter.confirm('Redeploy it now?', false);
    } else {
      this.out('Transcription is optional. Without it, reference intake still works and the transcript is typed by hand.');
      deployNow = await this.prompter.confirm(
        'Deploy the transcription service (a separate app on an L4)?',
        false,
      );
    }

    if (deployNow) {
      this.out('$ modal run infra/asr_weights.py');
      const weights = await this.modal.run('infra/asr_weights.py');
      if (weights !== 0) {
        throw new SetupAbort(
          `filling the transcription weights failed (exit ${weights})`,
          'Inspect the output above, then run setup again; downloaded files are kept.',
        );
      }
      this.out('$ modal deploy infra/asr.py');
      const deploy = await this.modal.deploy('infra/asr.py');
      if (deploy !== 0) {
        throw new SetupAbort(
          `deploying the transcription service failed (exit ${deploy})`,
          'Inspect the output above, then run setup again.',
        );
      }
    }

    if (deployNow || (deployed && !env.MODAL_ASR_URL)) {
      const url = await this.resolveUrl(transcription, TRANSCRIPTION_ENDPOINT);
      this.save({ MODAL_ASR_URL: url });
      this.out(`MODAL_ASR_URL set to ${url}`);
    } else if (env.MODAL_ASR_URL) {
      this.out('MODAL_ASR_URL is already set.');
    } else {
      this.out('Skipping transcription. MODAL_ASR_URL stays empty.');
    }
  }

  // ── Phase 7 ────────────────────────────────────────────────────────────────

  private async measurements(): Promise<void> {
    const go = await this.prompter.confirm(
      'Refresh deployment measurements now? This wakes the GPU and pays a full cold start.',
      false,
    );
    if (!go) {
      this.out('Keeping the recorded findings in bench/findings/.');
      return;
    }
    const probes: readonly (readonly string[])[] = [
      ['-m', 'bench.harness', '--warm-runs', '5'],
      ['-m', 'bench.cfg_probe', '--repeats', '5'],
      ['-m', 'bench.reference_probe'],
    ];
    for (const args of probes) {
      this.out(`$ .venv/bin/python ${args.join(' ')}`);
      const code = await this.runner.stream(this.modal.pythonBin, args, {
        cwd: this.repoRoot,
        env: { PYTHONPATH: this.repoRoot },
      });
      if (code !== 0) {
        // A failed probe leaves the previous findings in place; the demo
        // still runs on them, so this is reported rather than fatal.
        this.out(`${args[1]} exited with ${code}; its previous findings are kept.`);
        this.logger.warn({ probe: args[1], code }, 'measurement probe failed');
      }
    }
  }

  // ── Phase 8 ────────────────────────────────────────────────────────────────

  private async build(): Promise<void> {
    await this.streamOrAbort(
      'Installing UI dependencies',
      'npm',
      ['--prefix', 'ui', 'install'],
      'Check network access to the npm registry, then run setup again.',
    );
    await this.streamOrAbort(
      'Building the UI',
      'npm',
      ['--prefix', 'ui', 'run', 'build'],
      'Fix the build error above, then run setup again.',
    );
    await this.streamOrAbort(
      'Typechecking',
      'npm',
      ['run', 'typecheck'],
      'Fix the type error above, then run setup again.',
    );
  }

  private async finish(): Promise<void> {
    const env = this.env();
    const port = env.GATEWAY_PORT || '8787';
    this.out('');
    this.out('── Ready ──');
    this.out(`Synthesis endpoint: configured${env.MODAL_ASR_URL ? '; transcription endpoint: configured' : ''}.`);
    this.out(`The demo will be at http://127.0.0.1:${port}`);
    if (!this.options.start) {
      this.out('Start it with: npm --prefix gateway start');
      return;
    }
    this.out('Starting the gateway. Its startup log reports whether proxy auth is enforced. Press Ctrl-C to stop.');
    this.out('');
    await this.runner.stream('npm', ['--prefix', 'gateway', 'start'], { cwd: this.repoRoot });
  }
}

/**
 * Run the walkthrough to completion.
 *
 * @param deps - Injected boundaries and options.
 * @throws {SetupAbort} With a remedy, when a phase cannot continue.
 */
export async function runWalkthrough(deps: WalkthroughDeps): Promise<void> {
  await new Walkthrough(deps).run();
}
