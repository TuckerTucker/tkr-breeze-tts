/**
 * The Modal CLI and SDK as the setup walkthrough uses them.
 *
 * Everything that parses Modal's output is a pure function here so the exact
 * shapes — the token-creation JSON, the app listing, the unauthenticated
 * failure — are pinned by tests against samples of real output. The
 * {@link ModalCli} class is the thin runner-backed layer over them.
 *
 * The deployed endpoint URL is read back through the SDK after a deploy rather
 * than scraped from the deploy's progress output: the progress format is a
 * presentation detail, the SDK lookup is an API.
 *
 * @module
 */

import { join } from 'node:path';

import type { Logger } from 'pino';

import type { CommandRunner } from './runner.js';

/** A freshly created proxy token pair, straight from the CLI. */
export interface ProxyTokenPair {
  readonly key: string;
  readonly secret: string;
}

/** One deployed or recently stopped app, from `modal app list --json`. */
export interface ModalAppSummary {
  readonly name: string;
  readonly state: string;
}

/** Raised when Modal's output was not the shape the walkthrough expects. */
export class ModalOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModalOutputError';
  }
}

/**
 * Parse the output of `modal workspace proxy-tokens create --json`.
 *
 * The CLI prints one JSON object whose `Modal-Key` and `Modal-Secret` fields
 * are exactly the header values the gateway sends. Anything printed around
 * the object (progress decorations, a trailing newline) is ignored.
 *
 * @param stdout - Captured standard output.
 * @returns The pair.
 * @throws {ModalOutputError} When no such object is present.
 */
export function parseProxyTokenJson(stdout: string): ProxyTokenPair {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new ModalOutputError('proxy token output contained no JSON object');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.slice(start, end + 1));
  } catch {
    throw new ModalOutputError('proxy token output was not valid JSON');
  }
  const record = parsed as Record<string, unknown>;
  const key = record['Modal-Key'];
  const secret = record['Modal-Secret'];
  if (typeof key !== 'string' || typeof secret !== 'string' || !key || !secret) {
    throw new ModalOutputError('proxy token output lacked Modal-Key or Modal-Secret');
  }
  return { key, secret };
}

/**
 * Parse the output of `modal app list --json`.
 *
 * @param stdout - Captured standard output.
 * @returns Each app's display name and state.
 * @throws {ModalOutputError} When the output is not a JSON array of apps.
 */
export function parseAppList(stdout: string): ModalAppSummary[] {
  const start = stdout.indexOf('[');
  const end = stdout.lastIndexOf(']');
  if (start === -1 || end <= start) {
    throw new ModalOutputError('app list output contained no JSON array');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.slice(start, end + 1));
  } catch {
    throw new ModalOutputError('app list output was not valid JSON');
  }
  if (!Array.isArray(parsed)) {
    throw new ModalOutputError('app list output was not an array');
  }
  return parsed.map((entry) => {
    const record = (entry ?? {}) as Record<string, unknown>;
    return {
      name: typeof record.description === 'string' ? record.description : '',
      state: typeof record.state === 'string' ? record.state : '',
    };
  });
}

/**
 * Recognise the Modal CLI refusing to talk to the API for want of a token.
 *
 * @param stderr - Captured standard error of a failed command.
 * @returns Whether the failure was an authentication one.
 */
export function isAuthFailure(stderr: string): boolean {
  return /modal token new|modal setup|token (id|secret)|not authenticated|AuthError/i.test(stderr);
}

/**
 * The last non-empty line of a command's output, trimmed.
 *
 * Python-side helpers may log to stdout before printing their answer, so the
 * answer is always the final line rather than the whole stream.
 *
 * @param stdout - Captured standard output.
 * @returns The last non-blank line, or an empty string.
 */
export function lastLine(stdout: string): string {
  const lines = stdout.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  return lines[lines.length - 1] ?? '';
}

/** Outcome of listing apps. */
export type AppListResult =
  | { readonly ok: true; readonly apps: readonly ModalAppSummary[] }
  | { readonly ok: false; readonly authFailure: boolean; readonly stderr: string };

/** What {@link ModalCli} needs. */
export interface ModalCliDeps {
  readonly runner: CommandRunner;
  readonly repoRoot: string;
  readonly logger: Logger;
  /** The virtualenv holding the pinned Modal client. */
  readonly venvDir: string;
}

/** The Modal CLI and SDK, driven through the injected runner. */
export class ModalCli {
  private readonly runner: CommandRunner;
  private readonly repoRoot: string;
  private readonly logger: Logger;

  /** The `modal` binary inside the project virtualenv. */
  readonly modalBin: string;
  /** The Python interpreter inside the project virtualenv. */
  readonly pythonBin: string;

  constructor(deps: ModalCliDeps) {
    this.runner = deps.runner;
    this.repoRoot = deps.repoRoot;
    this.logger = deps.logger;
    this.modalBin = join(deps.venvDir, 'bin', 'modal');
    this.pythonBin = join(deps.venvDir, 'bin', 'python');
  }

  /**
   * List the workspace's apps, distinguishing an unauthenticated CLI from any
   * other failure so the walkthrough can offer `modal setup` rather than a
   * stack trace.
   */
  async listApps(): Promise<AppListResult> {
    this.logger.info({ command: 'modal app list' }, 'listing modal apps');
    const result = await this.runner.capture(this.modalBin, ['app', 'list', '--json'], {
      cwd: this.repoRoot,
    });
    if (result.code !== 0) {
      const authFailure = isAuthFailure(result.stderr);
      this.logger.warn({ code: result.code, authFailure }, 'modal app list failed');
      return { ok: false, authFailure, stderr: result.stderr };
    }
    return { ok: true, apps: parseAppList(result.stdout) };
  }

  /** Run Modal's interactive authentication in the operator's terminal. */
  async setup(): Promise<number> {
    this.logger.info({ command: 'modal setup' }, 'starting modal authentication');
    return this.runner.stream(this.modalBin, ['setup'], { cwd: this.repoRoot });
  }

  /**
   * Create a proxy token pair. The values are returned, never logged.
   *
   * @throws {ModalOutputError} When the CLI failed or printed an unexpected shape.
   */
  async createProxyToken(): Promise<ProxyTokenPair> {
    this.logger.info({ command: 'modal workspace proxy-tokens create' }, 'creating proxy token');
    const result = await this.runner.capture(
      this.modalBin,
      ['workspace', 'proxy-tokens', 'create', '--json'],
      { cwd: this.repoRoot },
    );
    if (result.code !== 0) {
      throw new ModalOutputError(
        `proxy token creation failed (exit ${result.code}): ${result.stderr.trim()}`,
      );
    }
    return parseProxyTokenJson(result.stdout);
  }

  /**
   * `modal run <script>` with the terminal attached.
   *
   * @param script - Path relative to the repo root.
   * @param env - Deployment-time environment for `infra/config.py`.
   * @returns Exit code.
   */
  async run(script: string, env: Readonly<Record<string, string>> = {}): Promise<number> {
    this.logger.info({ command: 'modal run', script }, 'running modal script');
    return this.runner.stream(this.modalBin, ['run', script], { cwd: this.repoRoot, env });
  }

  /**
   * `modal deploy <script>` with the terminal attached.
   *
   * @param script - Path relative to the repo root.
   * @param env - Deployment-time environment for `infra/config.py`.
   * @returns Exit code.
   */
  async deploy(script: string, env: Readonly<Record<string, string>> = {}): Promise<number> {
    this.logger.info({ command: 'modal deploy', script, env: Object.keys(env) }, 'deploying');
    return this.runner.stream(this.modalBin, ['deploy', script], { cwd: this.repoRoot, env });
  }

  /**
   * Read the app names from `infra/config.py`, the single decoration-time
   * surface, rather than carrying a second copy of them here.
   *
   * @returns The synthesis and transcription app names.
   * @throws {ModalOutputError} When the config module could not be imported.
   */
  async appNames(): Promise<{ synthesis: string; transcription: string }> {
    const result = await this.runner.capture(
      this.pythonBin,
      ['-c', 'import json; from infra.config import APP_NAME, ASR_APP_NAME; print(json.dumps([APP_NAME, ASR_APP_NAME]))'],
      { cwd: this.repoRoot, env: { PYTHONPATH: this.repoRoot } },
    );
    if (result.code !== 0) {
      throw new ModalOutputError(`could not read app names from infra/config.py: ${result.stderr.trim()}`);
    }
    // structlog reports the resolved configs on stdout at import time; the
    // JSON is the final line.
    let names: unknown;
    try {
      names = JSON.parse(lastLine(result.stdout));
    } catch {
      throw new ModalOutputError('infra/config.py app names were not printed as JSON');
    }
    if (!Array.isArray(names) || names.length !== 2 || names.some((n) => typeof n !== 'string')) {
      throw new ModalOutputError('infra/config.py app names had an unexpected shape');
    }
    return { synthesis: names[0] as string, transcription: names[1] as string };
  }

  /**
   * Resolve a deployed web endpoint's URL through the SDK.
   *
   * @param appName - The deployed app.
   * @param className - The serving class inside it.
   * @param methodName - Its `@modal.asgi_app` method.
   * @returns The `https://….modal.run` URL.
   * @throws {ModalOutputError} When the lookup failed or returned no URL.
   */
  async webUrl(appName: string, className: string, methodName: string): Promise<string> {
    this.logger.info({ appName, className, methodName }, 'resolving web endpoint url');
    const result = await this.runner.capture(
      this.pythonBin,
      [
        '-c',
        'import sys, modal; print(getattr(modal.Cls.from_name(sys.argv[1], sys.argv[2])(), sys.argv[3]).get_web_url() or "")',
        appName,
        className,
        methodName,
      ],
      { cwd: this.repoRoot },
    );
    if (result.code !== 0) {
      throw new ModalOutputError(
        `could not resolve the ${appName} endpoint url: ${result.stderr.trim()}`,
      );
    }
    const url = lastLine(result.stdout);
    if (!/^https?:\/\//.test(url)) {
      throw new ModalOutputError(`${appName} is deployed but exposes no web endpoint`);
    }
    return url;
  }
}
