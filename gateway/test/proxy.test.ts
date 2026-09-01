/**
 * The credential-holding proxy: what never leaves, and what is typed.
 */

import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ConfigError,
  loadConfig,
  parseEnvFile,
  redact,
  validateProxyTokenPair,
} from '../src/config.js';
import { GatewayError, ModalProxy } from '../src/proxy.js';
import { silentLogger, stubConfig, stubFetch } from './helpers.js';

const validEnv = {
  MODAL_ENDPOINT_URL: 'https://example--breeze-tts-serve.modal.run',
  MODAL_KEY: 'wk-abc123',
  MODAL_SECRET: 'ws-def456',
};

describe('startup validation', () => {
  it('fails with the remedy named when a variable is absent', () => {
    expect(() => loadConfig({ ...validEnv, MODAL_KEY: '' })).toThrowError(ConfigError);
    try {
      loadConfig({ ...validEnv, MODAL_KEY: '' });
    } catch (error) {
      expect((error as ConfigError).message).toContain('MODAL_KEY');
      expect((error as ConfigError).remedy).toContain('modal workspace proxy-tokens create');
    }
  });

  it('names the deploy command when the endpoint is missing', () => {
    try {
      loadConfig({ ...validEnv, MODAL_ENDPOINT_URL: '' });
      expect.unreachable();
    } catch (error) {
      expect((error as ConfigError).remedy).toContain('modal deploy infra/service.py');
    }
  });

  it('refuses an ak-/as- API token pair with the distinction named', () => {
    expect(() => validateProxyTokenPair('ak-nope', 'as-nope')).toThrowError(
      /API token/,
    );
  });

  it('accepts a wk-/ws- proxy pair', () => {
    expect(() => validateProxyTokenPair('wk-ok', 'ws-ok')).not.toThrow();
  });

  it('rejects a transport value that is neither mode', () => {
    expect(() =>
      loadConfig({ ...validEnv, GATEWAY_TRANSPORT: 'fast' }),
    ).toThrowError(/streaming/);
  });

  it('defaults to the streaming transport', () => {
    expect(loadConfig(validEnv).transport).toBe('streaming');
  });

  it('keeps ASR optional while declaring bounded reference storage', () => {
    const config = loadConfig(validEnv);
    expect(config.asrEndpoint).toBeNull();
    expect(config.referenceStoreDir).toContain('.cache/references');
    expect(config.referenceMaxAgeMs).toBe(86_400_000);
  });

  it('validates and normalises the optional ASR endpoint', () => {
    expect(
      loadConfig({
        ...validEnv,
        MODAL_ASR_URL: 'https://example--breeze-asr.modal.run///',
      }).asrEndpoint,
    ).toBe('https://example--breeze-asr.modal.run');
    expect(() =>
      loadConfig({ ...validEnv, MODAL_ASR_URL: 'not-a-url' }),
    ).toThrowError(/MODAL_ASR_URL/);
  });

  it('rejects an invalid reference retention window rather than disabling eviction', () => {
    expect(() =>
      loadConfig({ ...validEnv, REFERENCE_MAX_AGE_MS: '0' }),
    ).toThrowError(/REFERENCE_MAX_AGE_MS/);
  });

  it('parses a dotenv file, ignoring comments and stripping quotes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'breeze-env-'));
    const path = join(dir, '.env');
    await writeFile(path, '# comment\n\nMODAL_KEY="wk-quoted"\nBROKEN\nGATEWAY_PORT=9999\n');
    const parsed = parseEnvFile(path);
    expect(parsed.MODAL_KEY).toBe('wk-quoted');
    expect(parsed.GATEWAY_PORT).toBe('9999');
    expect(parsed.BROKEN).toBeUndefined();
  });
});

describe('the credential never reaches the browser', () => {
  const config = stubConfig();

  it('scrubs the token and the upstream URL from any text', () => {
    const leak = `failed calling ${config.endpoint} with ${config.key}/${config.secret}`;
    const scrubbed = redact(leak, config);
    expect(scrubbed).not.toContain(config.key);
    expect(scrubbed).not.toContain(config.secret);
    expect(scrubbed).not.toContain(config.endpoint);
  });

  it('scrubs the optional ASR URL too', () => {
    const withAsr = stubConfig({
      asrEndpoint: 'https://example--breeze-asr.modal.run',
    });
    expect(redact(`failed at ${withAsr.asrEndpoint}`, withAsr)).not.toContain(
      withAsr.asrEndpoint,
    );
  });

  it('scrubs anything token-shaped even when it is not the configured pair', () => {
    expect(redact('leaked wk-someoneelses123', config)).not.toContain('wk-someoneelses123');
  });

  it('never puts the token in a typed error', async () => {
    const proxy = new ModalProxy({
      config,
      logger: silentLogger(),
      fetchImpl: stubFetch([{ status: 500, body: `upstream exploded at ${config.endpoint}` }]),
    });
    await expect(proxy.speech({ text: 'hi', instruction: 'x', cfgScale: 1, seed: 42 }))
      .rejects.toSatisfy((error: unknown) => {
        const serialised = JSON.stringify((error as GatewayError).toJSON());
        return (
          !serialised.includes(config.key) &&
          !serialised.includes(config.secret) &&
          !serialised.includes(config.endpoint)
        );
      });
  });

  it('attaches the pair as headers on every forwarded request', async () => {
    const fetchImpl = stubFetch([{}]);
    const proxy = new ModalProxy({ config, logger: silentLogger(), fetchImpl });
    await proxy.speech({ text: 'hello', instruction: 'x', cfgScale: 1, seed: 42 });

    const headers = fetchImpl.calls[0]!.init.headers as Record<string, string>;
    expect(headers['Modal-Key']).toBe(config.key);
    expect(headers['Modal-Secret']).toBe(config.secret);
    expect(fetchImpl.calls[0]!.url).toBe(`${config.endpoint}/v1/audio/speech`);
  });
});

describe('upstream failures are typed, not passed through', () => {
  const config = stubConfig();

  const proxyWith = (spec: Parameters<typeof stubFetch>[0]): ModalProxy =>
    new ModalProxy({ config, logger: silentLogger(), fetchImpl: stubFetch(spec) });

  it('turns a 409 into a busy state rather than an error', async () => {
    const proxy = proxyWith([{ status: 409 }]);
    await expect(
      proxy.speech({ text: 'hi', instruction: 'x', cfgScale: 1, seed: 42 }),
    ).rejects.toMatchObject({ type: 'busy', statusCode: 409 });
  });

  it('says a busy state re-enables rather than suggesting a fix', async () => {
    try {
      await proxyWith([{ status: 409 }]).speech({
        text: 'hi',
        instruction: 'x',
        cfgScale: 1,
        seed: 42,
      });
      expect.unreachable();
    } catch (error) {
      expect((error as GatewayError).remedy).toMatch(/re-enables/);
    }
  });

  it('types a 401 as a configuration problem, distinct from a synthesis failure', async () => {
    try {
      await proxyWith([{ status: 401 }]).speech({
        text: 'hi',
        instruction: 'x',
        cfgScale: 1,
        seed: 42,
      });
      expect.unreachable();
    } catch (error) {
      expect((error as GatewayError).type).toBe('auth');
      expect((error as GatewayError).remedy).toContain('proxy-tokens create');
    }
  });

  it('types a 503 as still loading rather than as a failure', async () => {
    await expect(
      proxyWith([{ status: 503 }]).health(),
    ).rejects.toMatchObject({ type: 'unavailable' });
  });

  it('types an unreachable endpoint distinctly from a timeout', async () => {
    const proxy = new ModalProxy({
      config,
      logger: silentLogger(),
      fetchImpl: (async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch,
    });
    await expect(
      proxy.speech({ text: 'hi', instruction: 'x', cfgScale: 1, seed: 42 }),
    ).rejects.toMatchObject({ type: 'unavailable' });
  });
});

describe('readiness is inferred, never polled', () => {
  const config = stubConfig({ scaledownWindowMs: 300_000 });

  it('is unknown before any successful request, never warm', () => {
    // A wrong warm claim is the one that misleads, so absence of evidence is
    // reported as absence of evidence.
    const proxy = new ModalProxy({ config, logger: silentLogger(), fetchImpl: stubFetch([{}]) });
    expect(proxy.readiness()).toBe('unknown');
  });

  it('defaults its window to the service’s, so readiness cannot disagree', () => {
    // infra/config.py defaults scaledown_window_s to 600 after the measured
    // 166s cold start; a gateway defaulting to 300 would report cold while the
    // container was still warm.
    expect(loadConfig(validEnv).scaledownWindowMs).toBe(600_000);
  });

  it('is warm inside the scaledown window and cold beyond it', async () => {
    let now = 1_000_000;
    const proxy = new ModalProxy({
      config,
      logger: silentLogger(),
      fetchImpl: stubFetch([{}]),
      now: () => now,
    });

    await proxy.speech({ text: 'hi', instruction: 'x', cfgScale: 1, seed: 42 });
    expect(proxy.readiness()).toBe('warm');

    now += 299_000;
    expect(proxy.readiness()).toBe('warm');

    now += 2_000;
    expect(proxy.readiness()).toBe('cold');
  });
});
