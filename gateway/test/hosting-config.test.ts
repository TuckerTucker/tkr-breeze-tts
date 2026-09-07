/**
 * Slice 2 — bind host and state locations as configuration.
 *
 * Two paths are covered deliberately: the loopback default the local demo has
 * always had, and the hosted override the Modal image supplies. A default that
 * only one path exercises is a default that drifts, so both are asserted here
 * rather than one being inferred from the other.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ConfigError,
  DEFAULT_HOST,
  isExposedHost,
  loadConfig,
  readEnv,
  resolveHost,
} from '../src/config.js';

/** The minimum a configuration needs before host resolution is even reached. */
function baseEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    MODAL_ENDPOINT_URL: 'https://example--breeze-tts-serve.modal.run',
    MODAL_KEY: 'wk-testkey0123456789',
    MODAL_SECRET: 'ws-testsecret0123456789',
    ...overrides,
  };
}

describe('GATEWAY_HOST', () => {
  it('defaults to loopback, leaving the local demo unreachable from off the machine', () => {
    expect(loadConfig(baseEnv()).host).toBe('127.0.0.1');
    expect(DEFAULT_HOST).toBe('127.0.0.1');
  });

  it('accepts the wildcard the hosted image passes', () => {
    // Modal's proxy cannot reach a loopback-only listener, so this is not a
    // preference — it is the one value that makes hosting work at all.
    expect(loadConfig(baseEnv({ GATEWAY_HOST: '0.0.0.0' })).host).toBe('0.0.0.0');
  });

  it('accepts other literal addresses, v4 and v6', () => {
    expect(resolveHost('192.168.1.10')).toBe('192.168.1.10');
    expect(resolveHost('::1')).toBe('::1');
    expect(resolveHost('localhost')).toBe('localhost');
  });

  it('treats an empty value as absent rather than as an error', () => {
    expect(loadConfig(baseEnv({ GATEWAY_HOST: '' })).host).toBe('127.0.0.1');
  });

  it('refuses a value that is not a literal address, naming the remedy', () => {
    // Binding an unexpected address is worse than refusing to start, and a
    // hostname would let DNS move the listener with no configuration change.
    expect(() => resolveHost('gateway.example.com')).toThrow(ConfigError);
    try {
      resolveHost('gateway.example.com');
    } catch (error) {
      expect((error as ConfigError).remedy).toContain('0.0.0.0');
    }
  });

  it('refuses an out-of-range dotted quad', () => {
    expect(() => resolveHost('999.1.1.1')).toThrow(ConfigError);
  });
});

describe('isExposedHost', () => {
  it.each([
    ['0.0.0.0', true],
    ['::', true],
    ['127.0.0.1', false],
    ['127.0.0.53', false],
    ['localhost', false],
    ['::1', false],
    ['192.168.1.10', true],
  ])('%s -> exposed=%s', (host, expected) => {
    // This drives both the logged mode and whether the session cookie is
    // marked Secure, so the two can never disagree.
    expect(isExposedHost(host)).toBe(expected);
  });
});

describe('store directories as configuration', () => {
  it('passes absolute paths through untouched, so a Volume mount needs no new code', () => {
    const mount = '/mnt/state';
    const config = loadConfig(
      baseEnv({
        CLIP_CACHE_DIR: `${mount}/clips`,
        VOICE_STORE_DIR: `${mount}/voices`,
        SCRIPT_STORE_DIR: `${mount}/scripts`,
        REFERENCE_STORE_DIR: `${mount}/references`,
        BENCH_FINDINGS_DIR: '/opt/breeze/findings',
        UI_DIST_DIR: '/opt/breeze/ui',
      }),
    );

    expect(config.clipCacheDir).toBe(`${mount}/clips`);
    expect(config.voiceStoreDir).toBe(`${mount}/voices`);
    expect(config.scriptStoreDir).toBe(`${mount}/scripts`);
    expect(config.referenceStoreDir).toBe(`${mount}/references`);
    expect(config.findingsDir).toBe('/opt/breeze/findings');
    expect(config.uiDir).toBe('/opt/breeze/ui');
  });

  it('still resolves relative paths against the repo root for the local demo', () => {
    const config = loadConfig(baseEnv());
    expect(config.clipCacheDir.endsWith('/.cache/clips')).toBe(true);
    expect(config.voiceStoreDir.endsWith('/.cache/voices')).toBe(true);
  });
});

describe('credentials from a Secret and from .env', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'breeze-env-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('validates with the process environment alone and no .env file present', () => {
    // This is exactly the hosted shape: a modal.Secret populates the process
    // environment and there is no repo checkout to hold a .env.
    const merged = readEnv(join(dir, 'absent.env'), baseEnv() as NodeJS.ProcessEnv);
    const config = loadConfig(merged);
    expect(config.key).toBe('wk-testkey0123456789');
  });

  it('validates with a .env file alone and nothing in the process environment', async () => {
    const envPath = join(dir, '.env');
    await writeFile(
      envPath,
      [
        'MODAL_ENDPOINT_URL=https://example--breeze-tts-serve.modal.run',
        'MODAL_KEY=wk-testkey0123456789',
        'MODAL_SECRET=ws-testsecret0123456789',
      ].join('\n'),
      'utf8',
    );

    const config = loadConfig(readEnv(envPath, {} as NodeJS.ProcessEnv));
    expect(config.key).toBe('wk-testkey0123456789');
    expect(config.host).toBe('127.0.0.1');
  });

  it('lets the process environment win over the file, which is what a Secret relies on', async () => {
    const envPath = join(dir, '.env');
    await writeFile(envPath, 'GATEWAY_HOST=127.0.0.1\n', 'utf8');

    const merged = readEnv(envPath, baseEnv({ GATEWAY_HOST: '0.0.0.0' }) as NodeJS.ProcessEnv);
    expect(loadConfig(merged).host).toBe('0.0.0.0');
  });
});
