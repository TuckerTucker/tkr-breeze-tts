/**
 * The real prompter on a pipe: answers that arrive together are not lost
 * between questions, defaults apply to empty lines, and end of input is an
 * error rather than a silent exit — the failure a scripted run first hit.
 */

import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';

import { PromptClosed, TerminalPrompter } from '../src/setup/prompter.js';

function pipedPrompter(): {
  prompter: TerminalPrompter;
  input: PassThrough;
  written: () => string;
} {
  const input = new PassThrough();
  const chunks: string[] = [];
  const output = new PassThrough();
  output.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));
  const prompter = new TerminalPrompter(input, output);
  return { prompter, input, written: () => chunks.join('') };
}

describe('TerminalPrompter on a pipe', () => {
  it('queues answers that arrive in one chunk ahead of their questions', async () => {
    const { prompter, input, written } = pipedPrompter();
    input.write('\nn\nL40S\n2\n');

    expect(await prompter.confirm('Keep?', true)).toBe(true);
    expect(await prompter.confirm('Redeploy?', true)).toBe(false);
    expect(await prompter.ask('GPU', 'H100')).toBe('L40S');
    expect(await prompter.choose('Which?', ['a', 'b'])).toBe(1);
    expect(written()).toContain('Keep? [Y/n]: ');
    expect(written()).toContain('GPU [H100]: ');
    prompter.dispose();
  });

  it('waits for an answer that has not arrived yet', async () => {
    const { prompter, input } = pipedPrompter();
    const pending = prompter.ask('Later');
    input.write('eventually\n');
    expect(await pending).toBe('eventually');
    prompter.dispose();
  });

  it('applies the fallback to an empty line and re-asks on a bad yes/no', async () => {
    const { prompter, input, written } = pipedPrompter();
    input.write('\nmaybe\ny\n');
    expect(await prompter.ask('Window', '600')).toBe('600');
    expect(await prompter.confirm('Sure?', false)).toBe(true);
    expect(written()).toContain('Please answer y or n.');
    prompter.dispose();
  });

  it('rejects a pending question when input ends', async () => {
    const { prompter, input } = pipedPrompter();
    input.write('only one\n');
    expect(await prompter.ask('First')).toBe('only one');
    const pending = prompter.ask('Second');
    input.end();
    await expect(pending).rejects.toBeInstanceOf(PromptClosed);
    await expect(prompter.ask('Third')).rejects.toBeInstanceOf(PromptClosed);
  });

  it('keeps queued answers across a suspend for a child process', async () => {
    const { prompter, input } = pipedPrompter();
    input.write('first\nsecond\n');
    expect(await prompter.ask('One')).toBe('first');
    prompter.suspend();
    expect(await prompter.ask('Two')).toBe('second');
    const pending = prompter.ask('Three');
    input.write('third\n');
    expect(await pending).toBe('third');
    prompter.dispose();
  });

  it('reads a secret as a plain line when there is no terminal to silence', async () => {
    const { prompter, input, written } = pipedPrompter();
    input.write('ws-secret\n');
    expect(await prompter.askSecret('Secret')).toBe('ws-secret');
    expect(written()).not.toContain('ws-secret');
    prompter.dispose();
  });
});
