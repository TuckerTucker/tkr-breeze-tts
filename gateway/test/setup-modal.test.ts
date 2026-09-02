/**
 * Modal's output shapes, pinned against samples of the real CLI (client 1.5.5)
 * so a format change fails here rather than at an operator's terminal.
 */

import { describe, expect, it } from 'vitest';

import {
  ModalCli,
  ModalOutputError,
  isAuthFailure,
  lastLine,
  parseAppList,
  parseProxyTokenJson,
} from '../src/setup/modal.js';
import { FakeRunner, collectingLogger, rule } from './setup-fakes.js';

const TOKEN_JSON = `{
  "Modal-Key": "wk-abcdef123456",
  "Modal-Secret": "ws-0123456789abcdef",
  "Authorization": "Bearer wk-abcdef123456.ws-0123456789abcdef"
}
`;

const APP_LIST_JSON = `[
  {
    "app_id": "ap-EMSSEPt76YZrYXecPOpz7Z",
    "description": "visionary",
    "state": "deployed",
    "tasks": "0",
    "created_at": "2026-08-31 19:17:26-06:00",
    "stopped_at": null
  },
  {
    "app_id": "ap-3e2n5JCL3ThfOTLD82t353",
    "description": "breeze-tts",
    "state": "deployed",
    "tasks": "0",
    "created_at": "2026-08-31 19:29:51-06:00",
    "stopped_at": null
  },
  {
    "app_id": "ap-old",
    "description": "breeze-tts-asr",
    "state": "stopped",
    "tasks": "0",
    "created_at": "2026-09-01 12:21:08-06:00",
    "stopped_at": "2026-09-01 13:00:00-06:00"
  }
]
`;

const UNAUTHENTICATED_STDERR = `╭─ Error ──────────────────────────────────────────────────────────────────────╮
│ Token missing. Could not authenticate client. If you have token credentials, │
│ see modal.com/docs/sdk/py/latest/config for setup help. If you are a new     │
│ user, register an account at modal.com, then run \`modal token new\`.          │
╰──────────────────────────────────────────────────────────────────────────────╯
`;

describe('parseProxyTokenJson', () => {
  it('reads the header values the gateway sends', () => {
    expect(parseProxyTokenJson(TOKEN_JSON)).toEqual({
      key: 'wk-abcdef123456',
      secret: 'ws-0123456789abcdef',
    });
  });

  it('ignores decoration around the object', () => {
    expect(parseProxyTokenJson(`✓ Created.\n${TOKEN_JSON}\n`).key).toBe('wk-abcdef123456');
  });

  it('refuses output without a pair', () => {
    expect(() => parseProxyTokenJson('nothing here')).toThrow(ModalOutputError);
    expect(() => parseProxyTokenJson('{"Authorization": "Bearer x"}')).toThrow(ModalOutputError);
    expect(() => parseProxyTokenJson('{not json}')).toThrow(ModalOutputError);
  });
});

describe('lastLine', () => {
  it('returns the final non-blank line, trimmed', () => {
    expect(lastLine('a\n  b  \n\n')).toBe('b');
    expect(lastLine('')).toBe('');
  });
});

describe('parseAppList', () => {
  it('keeps each app name and state', () => {
    expect(parseAppList(APP_LIST_JSON)).toEqual([
      { name: 'visionary', state: 'deployed' },
      { name: 'breeze-tts', state: 'deployed' },
      { name: 'breeze-tts-asr', state: 'stopped' },
    ]);
  });

  it('refuses a non-array', () => {
    expect(() => parseAppList('{}')).toThrow(ModalOutputError);
    expect(() => parseAppList('')).toThrow(ModalOutputError);
  });
});

describe('isAuthFailure', () => {
  it('recognises the token-missing box', () => {
    expect(isAuthFailure(UNAUTHENTICATED_STDERR)).toBe(true);
  });

  it('does not mistake an unrelated failure for one', () => {
    expect(isAuthFailure('ConnectionError: name resolution failed')).toBe(false);
  });
});

describe('ModalCli', () => {
  const venvDir = '/repo/.venv';

  it('reports an unauthenticated CLI distinctly', async () => {
    const runner = new FakeRunner([
      rule('modal', ['app', 'list'], { code: 1, stdout: '', stderr: UNAUTHENTICATED_STDERR }),
    ]);
    const cli = new ModalCli({ runner, repoRoot: '/repo', logger: collectingLogger().logger, venvDir });
    const result = await cli.listApps();
    expect(result).toMatchObject({ ok: false, authFailure: true });
    expect(runner.calls[0]?.command).toBe('/repo/.venv/bin/modal');
  });

  it('lists deployed apps', async () => {
    const runner = new FakeRunner([
      rule('modal', ['app', 'list'], { code: 0, stdout: APP_LIST_JSON, stderr: '' }),
    ]);
    const cli = new ModalCli({ runner, repoRoot: '/repo', logger: collectingLogger().logger, venvDir });
    const result = await cli.listApps();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.apps.map((a) => a.name)).toContain('breeze-tts');
  });

  it('resolves a web url through the SDK and refuses a blank one', async () => {
    const runner = new FakeRunner([
      rule('python', ['-c'], (call) =>
        call.args[2] === 'breeze-tts'
          ? { code: 0, stdout: 'https://ws--breeze-tts-breezeservice-serve.modal.run\n', stderr: '' }
          : { code: 0, stdout: '\n', stderr: '' },
      ),
    ]);
    const cli = new ModalCli({ runner, repoRoot: '/repo', logger: collectingLogger().logger, venvDir });
    await expect(cli.webUrl('breeze-tts', 'BreezeService', 'serve')).resolves.toBe(
      'https://ws--breeze-tts-breezeservice-serve.modal.run',
    );
    await expect(cli.webUrl('other', 'X', 'serve')).rejects.toThrow(ModalOutputError);
    expect(runner.calls[0]?.args.slice(2)).toEqual(['breeze-tts', 'BreezeService', 'serve']);
  });

  it('reads app names past structlog output on stdout', async () => {
    const stdout = [
      '2026-09-01 23:17:40 [info     ] service_config.resolved        gpu=H100!',
      '2026-09-01 23:17:40 [info     ] asr_config.resolved            gpu=L4',
      '["breeze-tts", "breeze-tts-asr"]',
      '',
    ].join('\n');
    const runner = new FakeRunner([rule('python', ['-c'], { code: 0, stdout, stderr: '' })]);
    const cli = new ModalCli({ runner, repoRoot: '/repo', logger: collectingLogger().logger, venvDir });
    await expect(cli.appNames()).resolves.toEqual({
      synthesis: 'breeze-tts',
      transcription: 'breeze-tts-asr',
    });
    expect(runner.calls[0]?.options.env).toMatchObject({ PYTHONPATH: '/repo' });
  });

  it('refuses app names that are not JSON', async () => {
    const runner = new FakeRunner([rule('python', ['-c'], { code: 0, stdout: 'oops\n', stderr: '' })]);
    const cli = new ModalCli({ runner, repoRoot: '/repo', logger: collectingLogger().logger, venvDir });
    await expect(cli.appNames()).rejects.toThrow(ModalOutputError);
  });

  it('never logs the created pair', async () => {
    const runner = new FakeRunner([
      rule('modal', ['workspace', 'proxy-tokens', 'create'], { code: 0, stdout: TOKEN_JSON, stderr: '' }),
    ]);
    const { logger, lines } = collectingLogger();
    const cli = new ModalCli({ runner, repoRoot: '/repo', logger, venvDir });
    const pair = await cli.createProxyToken();
    expect(pair.secret).toBe('ws-0123456789abcdef');
    expect(lines.join('\n')).not.toContain('ws-0123456789abcdef');
  });
});
