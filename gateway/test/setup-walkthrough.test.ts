/**
 * The guided installation end to end, against scripted tools: a fresh machine
 * gets everything; a configured one is recognised and left alone; a bad
 * pasted credential is caught before it is written; nothing ever puts the
 * secret on screen or in the log.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { REPO_ROOT, parseEnvFile } from '../src/config.js';
import { ENV_FILE_MODE } from '../src/setup/env-file.js';
import {
  DEPLOY_DEFAULTS,
  SetupAbort,
  isDeployed,
  nodeVersionSatisfies,
  runWalkthrough,
  type WalkthroughDeps,
} from '../src/setup/walkthrough.js';
import {
  FakePrompter,
  FakeRunner,
  collectingLogger,
  rule,
  type CommandRule,
} from './setup-fakes.js';

const SECRET = 'ws-0123456789abcdef';
const KEY = 'wk-abcdef123456';
const SYNTH_URL = 'https://ws--breeze-tts-breezeservice-serve.modal.run';
const ASR_URL = 'https://ws--breeze-tts-asr-asrservice-serve.modal.run';

const TOKEN_JSON = JSON.stringify({ 'Modal-Key': KEY, 'Modal-Secret': SECRET, Authorization: 'x' });
const NAMES_JSON = JSON.stringify(['breeze-tts', 'breeze-tts-asr']);

function appList(...deployed: string[]): string {
  return JSON.stringify(deployed.map((name) => ({ description: name, state: 'deployed' })));
}

/** Rules for a machine where every tool works and nothing is deployed. */
function baseRules(overrides: { deployed?: string[] } = {}): CommandRule[] {
  return [
    rule('uv', ['--version'], { code: 0, stdout: 'uv 0.5.0\n', stderr: '' }),
    rule('uv', [], 0),
    rule('python', ['-c'], (call) => {
      const source = call.args[1] ?? '';
      if (source.includes('infra.config')) return { code: 0, stdout: `${NAMES_JSON}\n`, stderr: '' };
      if (source.includes('get_web_url')) {
        const url = call.args[2] === 'breeze-tts' ? SYNTH_URL : ASR_URL;
        return { code: 0, stdout: `${url}\n`, stderr: '' };
      }
      if (source.includes('modal.__version__')) return { code: 0, stdout: '1.5.5\n', stderr: '' };
      return 0;
    }),
    rule('python', ['-m'], 0),
    rule('modal', ['app', 'list'], {
      code: 0,
      stdout: appList(...(overrides.deployed ?? [])),
      stderr: '',
    }),
    rule('modal', ['workspace', 'proxy-tokens', 'create'], { code: 0, stdout: TOKEN_JSON, stderr: '' }),
    rule('modal', ['run'], 0),
    rule('modal', ['deploy'], 0),
    rule('npm', [], 0),
  ];
}

describe('setup walkthrough', () => {
  let repoRoot: string;
  let out: string[];

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'setup-walk-'));
    await copyFile(join(REPO_ROOT, '.env.example'), join(repoRoot, '.env.example'));
    out = [];
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  function deps(
    runner: FakeRunner,
    prompter: FakePrompter,
    extra: Partial<WalkthroughDeps> = {},
  ): WalkthroughDeps & { lines: string[] } {
    const { logger, lines } = collectingLogger();
    return {
      repoRoot,
      runner,
      prompter,
      out: (line) => out.push(line),
      logger,
      nodeVersion: 'v20.19.5',
      probeFfmpeg: async () => ({ available: true, version: 'ffmpeg version 7.1', remedy: null }),
      options: { start: false },
      lines,
      ...extra,
    };
  }

  it('takes a fresh machine to a configured, built demo', async () => {
    let pythonProbes = 0;
    const runner = new FakeRunner(baseRules());
    // The venv does not exist yet: the first import probe fails, the one
    // after installation succeeds.
    runner.prepend({
      match: (bin, args) => bin === 'python' && (args[1] ?? '').includes('modal.__version__'),
      answer: () => {
        pythonProbes += 1;
        return pythonProbes === 1 ? 1 : { code: 0, stdout: '1.5.5\n', stderr: '' };
      },
    });
    // Unauthenticated the first time `modal app list` runs; signed in after `modal setup`.
    let listings = 0;
    runner.prepend(
      rule('modal', ['app', 'list'], () => {
        listings += 1;
        return listings === 1
          ? { code: 1, stdout: '', stderr: 'run `modal token new`' }
          : { code: 0, stdout: appList(), stderr: '' };
      }),
    );
    runner.prepend(rule('modal', ['setup'], 0));

    const prompter = new FakePrompter([
      0, // create the pair with the CLI
      true, // deploy synthesis
      'L40S', // GPU
      '300', // warm window
      false, // no transcription
      false, // no measurements
    ]);
    const d = deps(runner, prompter, {
      probeFfmpeg: async () => ({ available: false, version: null, remedy: 'brew install ffmpeg' }),
    });

    await runWalkthrough(d);

    // Tooling was installed in order.
    const uvCalls = runner.find('uv').map((c) => c.args[0]);
    expect(uvCalls).toEqual(['--version', 'venv', 'pip']);
    expect(runner.find('modal', 'setup')).toHaveLength(1);

    // Deployment carried the chosen environment, and the gateway's window matches.
    const deploy = runner.find('modal', 'deploy', 'infra/service.py')[0];
    expect(deploy?.options.env).toMatchObject({ BREEZE_GPU: 'L40S', BREEZE_SCALEDOWN_WINDOW_S: '300' });
    expect(runner.find('modal', 'run', 'infra/weights.py')).toHaveLength(1);
    expect(runner.find('modal', 'run', 'infra/asr_weights.py')).toHaveLength(0);
    expect(runner.find('python', '-m')).toHaveLength(0);

    // The env file is complete, owner-only, and still carries the template's comments.
    const envPath = join(repoRoot, '.env');
    const env = parseEnvFile(envPath);
    expect(env).toMatchObject({
      MODAL_KEY: KEY,
      MODAL_SECRET: SECRET,
      MODAL_ENDPOINT_URL: SYNTH_URL,
      GATEWAY_SCALEDOWN_WINDOW_S: '300',
      MODAL_ASR_URL: '',
    });
    expect((await stat(envPath)).mode & 0o777).toBe(ENV_FILE_MODE);
    expect(await readFile(envPath, 'utf8')).toContain('# ── Modal endpoint and proxy auth');

    // The build ran; the gateway did not start.
    expect(runner.find('npm', '--prefix', 'ui', 'install')).toHaveLength(1);
    expect(runner.find('npm', '--prefix', 'ui', 'run', 'build')).toHaveLength(1);
    expect(runner.find('npm', 'run', 'typecheck')).toHaveLength(1);
    expect(runner.find('npm', '--prefix', 'gateway', 'start')).toHaveLength(0);

    // ffmpeg's absence was reported, not fatal.
    expect(out.some((l) => l.includes('ffmpeg: not found'))).toBe(true);

    // The secret reached the file and nowhere else.
    expect(out.join('\n')).not.toContain(SECRET);
    expect(d.lines.join('\n')).not.toContain(SECRET);
    expect(prompter.remaining).toBe(0);
  });

  it('recognises a configured machine and only fills what is missing', async () => {
    await mkdir(join(repoRoot, '.venv', 'bin'), { recursive: true });
    await writeFile(join(repoRoot, '.venv', 'bin', 'python'), '');
    const original = [
      '# hand-written',
      `MODAL_ENDPOINT_URL=${SYNTH_URL}`,
      `MODAL_KEY=${KEY}`,
      `MODAL_SECRET=${SECRET}`,
      'GATEWAY_PORT=9000',
      '',
    ].join('\n');
    await writeFile(join(repoRoot, '.env'), original);

    const runner = new FakeRunner(baseRules({ deployed: ['breeze-tts', 'breeze-tts-asr'] }));
    const prompter = new FakePrompter([
      '', // keep the pair (default yes)
      '', // do not redeploy synthesis (default no)
      '', // do not redeploy transcription (default no)
      '', // no measurements (default no)
    ]);

    await runWalkthrough(deps(runner, prompter));

    expect(runner.find('uv').map((c) => c.args[0])).toEqual(['--version']);
    expect(runner.find('modal', 'run')).toHaveLength(0);
    expect(runner.find('modal', 'deploy')).toHaveLength(0);
    expect(runner.find('modal', 'workspace')).toHaveLength(0);

    // Only the transcription URL was missing, so only it was resolved.
    const lookups = runner.calls.filter((c) => (c.args[1] ?? '').includes('get_web_url'));
    expect(lookups.map((c) => c.args[2])).toEqual(['breeze-tts-asr']);

    const text = await readFile(join(repoRoot, '.env'), 'utf8');
    expect(text.startsWith(original.trimEnd())).toBe(true);
    expect(parseEnvFile(join(repoRoot, '.env'))).toMatchObject({
      MODAL_KEY: KEY,
      MODAL_ASR_URL: ASR_URL,
      GATEWAY_PORT: '9000',
    });
    expect(out.some((l) => l.includes('http://127.0.0.1:9000'))).toBe(true);
    expect(out.some((l) => l.includes('npm --prefix gateway start'))).toBe(true);
  });

  it('rejects a pasted API token in place and accepts the corrected pair', async () => {
    const runner = new FakeRunner(baseRules({ deployed: ['breeze-tts'] }));
    const prompter = new FakePrompter([
      1, // paste
      'ak-not-a-proxy-token',
      'as-not-a-proxy-secret',
      KEY,
      SECRET,
      false, // do not redeploy
      false, // no transcription
      false, // no measurements
    ]);

    await runWalkthrough(deps(runner, prompter));

    expect(out.some((l) => l.includes('ak-/as- prefixes of a workspace API token'))).toBe(true);
    expect(parseEnvFile(join(repoRoot, '.env'))).toMatchObject({
      MODAL_KEY: KEY,
      MODAL_SECRET: SECRET,
      MODAL_ENDPOINT_URL: SYNTH_URL,
    });
    expect(out.join('\n')).not.toContain('as-not-a-proxy-secret');
  });

  it('stops with a remedy on an old Node', async () => {
    const runner = new FakeRunner(baseRules());
    const prompter = new FakePrompter([]);
    await expect(
      runWalkthrough(deps(runner, prompter, { nodeVersion: 'v18.20.0' })),
    ).rejects.toMatchObject({ name: 'SetupAbort', remedy: expect.stringContaining('nvm install 20') });
    expect(runner.calls).toHaveLength(0);
  });

  it('stops when synthesis is not deployed and the operator declines', async () => {
    const runner = new FakeRunner(baseRules());
    const prompter = new FakePrompter([0, false]);
    const promise = runWalkthrough(deps(runner, prompter));
    await expect(promise).rejects.toBeInstanceOf(SetupAbort);
    await expect(promise).rejects.toMatchObject({
      remedy: expect.stringContaining('modal deploy infra/service.py'),
    });
    // The credential was already saved, so the rerun resumes past it.
    expect(parseEnvFile(join(repoRoot, '.env')).MODAL_KEY).toBe(KEY);
  });

  it('reports a failed measurement probe and keeps going', async () => {
    const runner = new FakeRunner(baseRules({ deployed: ['breeze-tts'] }));
    runner.prepend(rule('python', ['-m', 'bench.harness'], 2));
    const prompter = new FakePrompter([0, false, false, true]);

    await runWalkthrough(deps(runner, prompter, { options: { start: true } }));

    expect(runner.find('python', '-m').map((c) => c.args[1])).toEqual([
      'bench.harness',
      'bench.cfg_probe',
      'bench.reference_probe',
    ]);
    expect(runner.find('python', '-m')[0]?.options.env).toMatchObject({ PYTHONPATH: repoRoot });
    expect(out.some((l) => l.includes('bench.harness exited with 2'))).toBe(true);
    expect(runner.find('npm', '--prefix', 'gateway', 'start')).toHaveLength(1);
  });

  it('offers the documented deployment defaults', async () => {
    const runner = new FakeRunner(baseRules());
    const prompter = new FakePrompter([0, true, '', 'abc', '', false, false]);

    await runWalkthrough(deps(runner, prompter));

    const deploy = runner.find('modal', 'deploy', 'infra/service.py')[0];
    expect(deploy?.options.env).toMatchObject({
      BREEZE_GPU: DEPLOY_DEFAULTS.gpu,
      BREEZE_SCALEDOWN_WINDOW_S: DEPLOY_DEFAULTS.scaledownWindowS,
    });
    expect(out.some((l) => l.includes('positive whole number'))).toBe(true);
  });
});

describe('nodeVersionSatisfies', () => {
  it('compares against the engines floor', () => {
    expect(nodeVersionSatisfies('v20.11.0')).toBe(true);
    expect(nodeVersionSatisfies('v22.0.0')).toBe(true);
    expect(nodeVersionSatisfies('v20.10.9')).toBe(false);
    expect(nodeVersionSatisfies('garbage')).toBe(false);
  });
});

describe('isDeployed', () => {
  it('requires the deployed state, not merely a listing', () => {
    const apps = [
      { name: 'breeze-tts', state: 'stopped' },
      { name: 'breeze-tts-asr', state: 'deployed' },
    ];
    expect(isDeployed(apps, 'breeze-tts')).toBe(false);
    expect(isDeployed(apps, 'breeze-tts-asr')).toBe(true);
  });
});
