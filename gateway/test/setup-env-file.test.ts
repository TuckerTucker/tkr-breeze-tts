/**
 * Editing `.env` in place: the template's comments survive, a credential file
 * ends up owner-only, and nothing the operator wrote by hand is lost.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ENV_FILE_MODE, upsertEnvValues, writeEnvFile } from '../src/setup/env-file.js';

const TEMPLATE = [
  '# Breeze-TTS demo — environment template.',
  '',
  '# The deployed web endpoint.',
  'MODAL_ENDPOINT_URL=',
  '',
  '# Proxy auth token pair.',
  'MODAL_KEY=',
  'MODAL_SECRET=',
  '',
  'GATEWAY_PORT=8787',
  '',
  '# Not an assignment, a commented-out example:',
  '#   BREEZE_GPU=H100',
  '',
].join('\n');

describe('upsertEnvValues', () => {
  it('replaces an existing assignment on its own line and keeps every comment', () => {
    const text = upsertEnvValues(TEMPLATE, { MODAL_KEY: 'wk-abc', GATEWAY_PORT: '9000' });
    const lines = text.split('\n');
    expect(lines).toContain('MODAL_KEY=wk-abc');
    expect(lines).toContain('GATEWAY_PORT=9000');
    expect(lines).toContain('# Proxy auth token pair.');
    expect(lines).toContain('MODAL_SECRET=');
    // The commented-out example is not an assignment and is untouched.
    expect(lines).toContain('#   BREEZE_GPU=H100');
    expect(text.match(/^MODAL_KEY=/gm)).toHaveLength(1);
  });

  it('appends a key the file does not have under a marker', () => {
    const text = upsertEnvValues(TEMPLATE, { MODAL_ASR_URL: 'https://x.modal.run' });
    expect(text.endsWith('MODAL_ASR_URL=https://x.modal.run\n')).toBe(true);
    expect(text).toContain('# ── Added by `npm run setup`');
    expect(text.startsWith(TEMPLATE)).toBe(true);
  });

  it('starts from nothing without a leading blank line', () => {
    const text = upsertEnvValues('', { A: '1', B: '2' });
    expect(text.startsWith('# ── Added by')).toBe(true);
    expect(text).toBe(`${text.split('\n')[0]}\nA=1\nB=2\n`);
  });

  it('replaces a quoted or space-padded assignment', () => {
    const text = upsertEnvValues('  KEY = "old"\nOTHER=x\n', { KEY: 'new' });
    expect(text).toBe('KEY=new\nOTHER=x\n');
  });

  it('is a no-op on the text when given nothing to change', () => {
    expect(upsertEnvValues(TEMPLATE, {})).toBe(TEMPLATE);
  });
});

describe('writeEnvFile', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'setup-env-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('creates the file from the template, owner-only', async () => {
    const template = join(dir, '.env.example');
    const target = join(dir, '.env');
    await writeFile(template, TEMPLATE);

    writeEnvFile(target, { MODAL_KEY: 'wk-1', MODAL_SECRET: 'ws-1' }, template);

    const text = await readFile(target, 'utf8');
    expect(text).toContain('MODAL_KEY=wk-1');
    expect(text).toContain('MODAL_SECRET=ws-1');
    expect(text).toContain('# Breeze-TTS demo — environment template.');
    const mode = (await stat(target)).mode & 0o777;
    expect(mode).toBe(ENV_FILE_MODE);
  });

  it('tightens the mode of a file the operator created loosely', async () => {
    const target = join(dir, '.env');
    await writeFile(target, 'MODAL_KEY=wk-old\n', { mode: 0o644 });

    writeEnvFile(target, { MODAL_ENDPOINT_URL: 'https://x.modal.run' });

    const text = await readFile(target, 'utf8');
    expect(text).toContain('MODAL_KEY=wk-old');
    expect(text).toContain('MODAL_ENDPOINT_URL=https://x.modal.run');
    expect((await stat(target)).mode & 0o777).toBe(ENV_FILE_MODE);
  });

  it('starts empty when neither file nor template exists', async () => {
    const target = join(dir, '.env');
    writeEnvFile(target, { A: '1' }, join(dir, 'missing'));
    expect(await readFile(target, 'utf8')).toContain('A=1');
  });
});
