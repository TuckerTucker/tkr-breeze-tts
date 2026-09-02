/**
 * Terminal questions for the setup walkthrough.
 *
 * Injected so the phase logic can be driven by a scripted prompter in tests.
 * The real one keeps a single readline interface for as long as it is asking,
 * and queues every line it emits until a question consumes it: answers typed
 * ahead on a terminal, or piped in as one chunk, are never dropped between
 * questions. End of input with a question pending is an error, not a silent
 * exit, and Ctrl-C is reported rather than swallowed.
 *
 * The interface is closed — the terminal handed back in cooked mode — whenever
 * a child process needs stdin ({@link TerminalPrompter.suspend}) and whenever a
 * secret is read with echo off; the next question opens it again, with any
 * queued lines intact.
 *
 * @module
 */

import { createInterface, type Interface } from 'node:readline';
import type { ReadStream, WriteStream } from 'node:tty';

/** The injected question boundary. */
export interface Prompter {
  /**
   * Ask for a line of text.
   *
   * @param question - Shown before the input, without a trailing colon.
   * @param fallback - Used when the operator presses Enter on an empty line.
   * @returns The trimmed answer, or the fallback, or an empty string.
   */
  ask(question: string, fallback?: string): Promise<string>;

  /**
   * Ask for a value that must not be echoed.
   *
   * @param question - Shown before the input, without a trailing colon.
   * @returns The answer, untrimmed apart from the line ending.
   */
  askSecret(question: string): Promise<string>;

  /**
   * Ask a yes/no question.
   *
   * @param question - Shown before the `[Y/n]` or `[y/N]` hint.
   * @param fallback - The answer an empty line means.
   * @returns The decision.
   */
  confirm(question: string, fallback: boolean): Promise<boolean>;

  /**
   * Ask the operator to pick one of a short list.
   *
   * @param question - Shown above the numbered options.
   * @param options - The choices, in display order.
   * @param fallbackIndex - Zero-based index an empty line means.
   * @returns The zero-based index chosen.
   */
  choose(
    question: string,
    options: readonly string[],
    fallbackIndex?: number,
  ): Promise<number>;
}

/** Raised when the operator presses Ctrl-C at a prompt. */
export class PromptInterrupted extends Error {
  constructor() {
    super('interrupted');
    this.name = 'PromptInterrupted';
  }
}

/** Raised when input ended while a question was still waiting for an answer. */
export class PromptClosed extends Error {
  constructor() {
    super('input ended before the question was answered');
    this.name = 'PromptClosed';
  }
}

/** The subset of a readable stream the prompter needs, TTY or pipe. */
export type PromptInput = NodeJS.ReadableStream & {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?: (mode: boolean) => unknown;
};

/** The subset of a writable stream the prompter needs. */
export type PromptOutput = NodeJS.WritableStream;

type LineWaiter = (line: string | null, error?: Error) => void;

/** Questions on a real terminal, or on a pipe of prepared answers. */
export class TerminalPrompter implements Prompter {
  private readonly input: PromptInput;
  private readonly output: PromptOutput;
  private readonly interactive: boolean;

  private rl: Interface | null = null;
  private readonly queued: string[] = [];
  private readonly waiting: LineWaiter[] = [];
  private ended = false;
  private suspending = false;

  constructor(
    input: PromptInput = process.stdin as ReadStream,
    output: PromptOutput = process.stdout as WriteStream,
  ) {
    this.input = input;
    this.output = output;
    this.interactive = Boolean(input.isTTY);
  }

  /**
   * Close the readline interface so a child process can own stdin and, on a
   * terminal, find it in cooked mode. Lines already read stay queued. The next
   * question reopens the interface.
   */
  suspend(): void {
    if (!this.rl) return;
    this.suspending = true;
    try {
      this.rl.close();
    } finally {
      this.suspending = false;
      this.rl = null;
    }
  }

  /** Release the input stream so the process can exit. Safe to call twice. */
  dispose(): void {
    this.suspend();
  }

  private open(): Interface | null {
    if (this.rl) return this.rl;
    if (this.ended) return null;
    const rl = createInterface({
      input: this.input,
      output: this.output,
      terminal: this.interactive,
    });
    rl.on('line', (line) => {
      const waiter = this.waiting.shift();
      if (waiter) waiter(line);
      else this.queued.push(line);
    });
    rl.on('SIGINT', () => {
      // Without a listener readline would merely pause on Ctrl-C and the
      // process would sit there; report it so the caller can exit.
      const waiters = this.waiting.splice(0);
      this.suspend();
      for (const waiter of waiters) waiter(null, new PromptInterrupted());
    });
    rl.on('close', () => {
      if (this.suspending) return;
      this.ended = true;
      this.rl = null;
      for (const waiter of this.waiting.splice(0)) waiter(null);
    });
    this.rl = rl;
    return rl;
  }

  private readLine(prompt: string): Promise<string> {
    const ready = this.queued.shift();
    if (ready !== undefined) {
      this.output.write(`${prompt}\n`);
      return Promise.resolve(ready);
    }
    const rl = this.open();
    if (!rl) return Promise.reject(new PromptClosed());
    rl.setPrompt(prompt);
    rl.prompt();
    return new Promise((resolve, reject) => {
      this.waiting.push((line, error) => {
        if (error) reject(error);
        else if (line === null) reject(new PromptClosed());
        else resolve(line);
      });
    });
  }

  async ask(question: string, fallback?: string): Promise<string> {
    const hint = fallback !== undefined && fallback !== '' ? ` [${fallback}]` : '';
    const answer = (await this.readLine(`${question}${hint}: `)).trim();
    return answer !== '' ? answer : (fallback ?? '');
  }

  async askSecret(question: string): Promise<string> {
    const input = this.input;
    const rawMode = input.setRawMode;
    if (!this.interactive || rawMode === undefined) {
      // No terminal to silence; a pipe has nothing to echo anyway.
      return this.readLine(`${question}: `);
    }
    const ready = this.queued.shift();
    if (ready !== undefined) {
      this.output.write(`${question}: \n`);
      return ready;
    }
    // Readline would echo; take the terminal over for this one line.
    this.suspend();
    this.output.write(`${question}: `);
    const setRawMode = rawMode.bind(input);
    const wasRaw = Boolean(input.isRaw);
    setRawMode(true);
    input.setEncoding('utf8');
    input.resume();
    return new Promise((resolve, reject) => {
      let buffer = '';
      const finish = () => {
        input.off('data', onData);
        setRawMode(wasRaw);
        input.pause();
        this.output.write('\n');
      };
      const onData = (chunk: string | Buffer) => {
        for (const ch of chunk.toString()) {
          if (ch === '\u0003') {
            finish();
            reject(new PromptInterrupted());
            return;
          }
          if (ch === '\r' || ch === '\n') {
            finish();
            resolve(buffer);
            return;
          }
          if (ch === '\u007f' || ch === '\b') {
            buffer = buffer.slice(0, -1);
            continue;
          }
          buffer += ch;
        }
      };
      input.on('data', onData);
    });
  }

  async confirm(question: string, fallback: boolean): Promise<boolean> {
    const hint = fallback ? 'Y/n' : 'y/N';
    for (;;) {
      const answer = (await this.readLine(`${question} [${hint}]: `)).trim().toLowerCase();
      if (answer === '') return fallback;
      if (answer === 'y' || answer === 'yes') return true;
      if (answer === 'n' || answer === 'no') return false;
      this.output.write('Please answer y or n.\n');
    }
  }

  async choose(
    question: string,
    options: readonly string[],
    fallbackIndex = 0,
  ): Promise<number> {
    this.output.write(`${question}\n`);
    options.forEach((option, index) => {
      this.output.write(`  ${index + 1}) ${option}\n`);
    });
    for (;;) {
      const answer = await this.ask('Choice', String(fallbackIndex + 1));
      const index = Number(answer) - 1;
      if (Number.isInteger(index) && index >= 0 && index < options.length) return index;
      this.output.write(`Enter a number from 1 to ${options.length}.\n`);
    }
  }
}
