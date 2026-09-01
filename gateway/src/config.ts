/**
 * Gateway configuration, read once at startup and validated before any traffic
 * is accepted.
 *
 * The startup validation is the point. A missing or malformed credential that
 * surfaces on the operator's first synthesis attempt has already cost them a
 * typed line, a chosen voice and their attention; the same failure at startup
 * costs a restart and names the remedy.
 *
 * @module
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repo root, resolved from this file so the gateway can start from anywhere. */
export const REPO_ROOT: string = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

/** Which playback transport the gateway serves. */
export type Transport = 'streaming' | 'buffered';

/**
 * Proxy auth token pairs are prefixed `wk-`/`ws-`. A workspace API token uses
 * `ak-`/`as-` and authenticates to nothing against a proxy-auth endpoint, so
 * the distinction is checked rather than discovered as a 401.
 */
export const PROXY_KEY_PREFIX = 'wk-';
export const PROXY_SECRET_PREFIX = 'ws-';
export const API_TOKEN_KEY_PREFIX = 'ak-';
export const API_TOKEN_SECRET_PREFIX = 'as-';

/** Raised for any configuration problem that must stop startup. */
export class ConfigError extends Error {
  /** What the operator should do about it. */
  readonly remedy: string;

  constructor(message: string, remedy: string) {
    super(message);
    this.name = 'ConfigError';
    this.remedy = remedy;
  }
}

/** The validated gateway configuration. */
export interface GatewayConfig {
  /** Port the gateway listens on. The UI is served from the same origin. */
  readonly port: number;
  /** Deployed Modal web endpoint. The browser never learns this. */
  readonly endpoint: string;
  /** `Modal-Key` header value. Never leaves this process. */
  readonly key: string;
  /** `Modal-Secret` header value. Never leaves this process. */
  readonly secret: string;
  /** Buffered WAV or unbuffered PCM pass-through. */
  readonly transport: Transport;
  /** Where raw PCM clips and their sidecars are written. */
  readonly clipCacheDir: string;
  /** Cache ceiling, enforced by oldest-first eviction. */
  readonly clipCacheMaxBytes: number;
  /** Where named voices keep their own copy of the audio. */
  readonly voiceStoreDir: string;
  /** Where scripts are persisted. */
  readonly scriptStoreDir: string;
  /**
   * Mirrors the service's `scaledown_window`. The gateway infers readiness
   * from idle time rather than polling upstream health — a poll after
   * scale-down would itself trigger the cold start it was checking for.
   */
  readonly scaledownWindowMs: number;
  /** Directory holding recorded measurements from `bench`. */
  readonly findingsDir: string;
  /** Built UI assets to serve, when present. */
  readonly uiDir: string;
  /** Upstream request ceiling. Generous: a cold start happens inside it. */
  readonly upstreamTimeoutMs: number;
}

/**
 * Parse a dotenv file into a plain mapping.
 *
 * @param path - File to read. A missing file yields an empty mapping, because
 *   the process environment alone is a legitimate way to configure this.
 * @returns The parsed key/value pairs.
 */
export function parseEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    out[key] = value;
  }
  return out;
}

/**
 * Merge the repo-root `.env` with the process environment.
 *
 * One file at the root, not one per capability: the gateway and the bench
 * harness authenticate to the same endpoint, and a second copy of a credential
 * is a second thing to leak and to rotate.
 *
 * @param envPath - Override for the dotenv path, used by tests.
 * @param processEnv - Override for `process.env`, used by tests.
 * @returns The merged mapping, with the process environment winning.
 */
export function readEnv(
  envPath: string = resolve(REPO_ROOT, '.env'),
  processEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const fromFile = parseEnvFile(envPath);
  const merged: Record<string, string> = { ...fromFile };
  for (const [key, value] of Object.entries(processEnv)) {
    if (value !== undefined && value !== '') merged[key] = value;
  }
  return merged;
}

function requirePositiveInt(
  raw: string | undefined,
  fallback: number,
  name: string,
): number {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new ConfigError(
      `${name} must be a positive integer, got ${JSON.stringify(raw)}`,
      `Set ${name} to a positive integer in .env, or remove it to use ${fallback}.`,
    );
  }
  return value;
}

function resolveFromRoot(value: string): string {
  return isAbsolute(value) ? value : resolve(REPO_ROOT, value);
}

/**
 * Validate a Modal proxy token pair before it is used to authenticate.
 *
 * @param key - Intended `Modal-Key` value.
 * @param secret - Intended `Modal-Secret` value.
 * @throws {ConfigError} When either half is absent, or the pair carries the
 *   `ak-`/`as-` prefixes of a workspace API token.
 */
export function validateProxyTokenPair(
  key: string | undefined,
  secret: string | undefined,
): asserts key is string {
  const create = 'modal workspace proxy-tokens create --json';
  const missing = [
    ...(key ? [] : ['MODAL_KEY']),
    ...(secret ? [] : ['MODAL_SECRET']),
  ];
  if (missing.length > 0) {
    throw new ConfigError(
      `missing ${missing.join(' and ')}`,
      `Create a proxy token pair and write it into .env:\n  ${create}`,
    );
  }
  if (
    key!.startsWith(API_TOKEN_KEY_PREFIX) ||
    secret!.startsWith(API_TOKEN_SECRET_PREFIX)
  ) {
    throw new ConfigError(
      'MODAL_KEY/MODAL_SECRET carry the ak-/as- prefixes of a workspace API token. ' +
        'A proxy-auth endpoint does not accept API tokens — this pair authenticates to nothing.',
      `Create a proxy token pair instead:\n  ${create}`,
    );
  }
  if (
    !key!.startsWith(PROXY_KEY_PREFIX) ||
    !secret!.startsWith(PROXY_SECRET_PREFIX)
  ) {
    throw new ConfigError(
      `expected MODAL_KEY to start with "${PROXY_KEY_PREFIX}" and MODAL_SECRET with "${PROXY_SECRET_PREFIX}"`,
      `These come from:\n  ${create}`,
    );
  }
}

/**
 * Build the validated gateway configuration.
 *
 * @param env - Environment mapping. Defaults to the merged `.env` plus process
 *   environment.
 * @returns The configuration.
 * @throws {ConfigError} With a remedy named, for any invalid value.
 */
export function loadConfig(env: Record<string, string> = readEnv()): GatewayConfig {
  const endpoint = (env.MODAL_ENDPOINT_URL ?? '').replace(/\/+$/, '');
  if (!endpoint) {
    throw new ConfigError(
      'missing MODAL_ENDPOINT_URL',
      'Deploy the service and copy its URL into .env:\n  modal deploy infra/service.py',
    );
  }
  if (!/^https?:\/\//.test(endpoint)) {
    throw new ConfigError(
      `MODAL_ENDPOINT_URL must be an absolute http(s) URL, got ${JSON.stringify(endpoint)}`,
      'Use the full https://…modal.run URL that `modal deploy` printed.',
    );
  }

  validateProxyTokenPair(env.MODAL_KEY, env.MODAL_SECRET);

  const transportRaw = env.GATEWAY_TRANSPORT ?? 'streaming';
  if (transportRaw !== 'streaming' && transportRaw !== 'buffered') {
    throw new ConfigError(
      `GATEWAY_TRANSPORT must be "streaming" or "buffered", got ${JSON.stringify(transportRaw)}`,
      'Set GATEWAY_TRANSPORT=streaming in .env for the low-latency path.',
    );
  }

  return {
    port: requirePositiveInt(env.GATEWAY_PORT, 8787, 'GATEWAY_PORT'),
    endpoint,
    key: env.MODAL_KEY!,
    secret: env.MODAL_SECRET!,
    transport: transportRaw,
    clipCacheDir: resolveFromRoot(env.CLIP_CACHE_DIR ?? '.cache/clips'),
    clipCacheMaxBytes: requirePositiveInt(
      env.CLIP_CACHE_MAX_BYTES,
      2 * 1024 * 1024 * 1024,
      'CLIP_CACHE_MAX_BYTES',
    ),
    voiceStoreDir: resolveFromRoot(env.VOICE_STORE_DIR ?? '.cache/voices'),
    scriptStoreDir: resolveFromRoot(env.SCRIPT_STORE_DIR ?? '.cache/scripts'),
    scaledownWindowMs:
      requirePositiveInt(
        env.GATEWAY_SCALEDOWN_WINDOW_S,
        // Must track infra/config.py's scaledown_window_s. Readiness is
        // inferred from idle time against this number, so a gateway set
        // shorter than the service reports "cold" while the container is
        // still warm — the UI then promises a wake that will not happen.
        600,
        'GATEWAY_SCALEDOWN_WINDOW_S',
      ) * 1000,
    findingsDir: resolveFromRoot(env.BENCH_FINDINGS_DIR ?? 'bench/findings'),
    uiDir: resolveFromRoot(env.UI_DIST_DIR ?? 'ui/dist'),
    upstreamTimeoutMs: requirePositiveInt(
      env.GATEWAY_UPSTREAM_TIMEOUT_MS,
      900_000,
      'GATEWAY_UPSTREAM_TIMEOUT_MS',
    ),
  };
}

/**
 * Redact anything credential-shaped from a value bound for a log or a response.
 *
 * Belt and braces: the gateway never puts the pair in an outgoing payload, and
 * this makes an accidental one unreadable rather than merely unlikely.
 *
 * @param value - Text to scrub.
 * @param config - The configuration whose secrets should be removed.
 * @returns The text with any credential material replaced.
 */
export function redact(value: string, config: Pick<GatewayConfig, 'key' | 'secret' | 'endpoint'>): string {
  let out = value;
  for (const secret of [config.key, config.secret]) {
    if (secret) out = out.split(secret).join('[redacted]');
  }
  if (config.endpoint) out = out.split(config.endpoint).join('[upstream]');
  return out.replace(/\b(wk|ws|ak|as)-[A-Za-z0-9_-]{4,}/g, '[redacted]');
}
