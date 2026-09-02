/**
 * Scripted boundaries for the setup walkthrough: a runner that answers each
 * command from a table and records what was asked, a prompter that replays
 * queued answers, and a logger whose output can be searched for leaks.
 */

import pino, { type Logger } from 'pino';

import type { Prompter } from '../src/setup/prompter.js';
import type {
  CommandOptions,
  CommandResult,
  CommandRunner,
} from '../src/setup/runner.js';

/** One recorded invocation. */
export interface RecordedCommand {
  readonly mode: 'capture' | 'stream';
  readonly command: string;
  readonly args: readonly string[];
  readonly options: CommandOptions;
}

/** What a scripted rule answers with: a full result, or just an exit code. */
export type ScriptedAnswer = CommandResult | number;

/** A rule: matches a command line and answers it. */
export interface CommandRule {
  /** Called with the binary name (last path segment) and the arguments. */
  readonly match: (command: string, args: readonly string[]) => boolean;
  readonly answer: ScriptedAnswer | ((call: RecordedCommand) => ScriptedAnswer);
}

/** Basename of a command path, so rules can match `python` not `/x/.venv/bin/python`. */
function binary(command: string): string {
  return command.split('/').pop() ?? command;
}

/** A runner that answers from rules, first match wins; unmatched commands fail loudly. */
export class FakeRunner implements CommandRunner {
  readonly calls: RecordedCommand[] = [];
  private readonly rules: CommandRule[];

  constructor(rules: readonly CommandRule[]) {
    this.rules = [...rules];
  }

  /** Add a rule ahead of the existing ones. */
  prepend(rule: CommandRule): void {
    this.rules.unshift(rule);
  }

  private resolve(call: RecordedCommand): CommandResult {
    const rule = this.rules.find((r) => r.match(binary(call.command), call.args));
    if (!rule) {
      throw new Error(`unscripted command: ${call.mode} ${call.command} ${call.args.join(' ')}`);
    }
    const answer = typeof rule.answer === 'function' ? rule.answer(call) : rule.answer;
    return typeof answer === 'number' ? { code: answer, stdout: '', stderr: '' } : answer;
  }

  async capture(
    command: string,
    args: readonly string[],
    options: CommandOptions = {},
  ): Promise<CommandResult> {
    const call: RecordedCommand = { mode: 'capture', command, args, options };
    this.calls.push(call);
    return this.resolve(call);
  }

  async stream(
    command: string,
    args: readonly string[],
    options: CommandOptions = {},
  ): Promise<number> {
    const call: RecordedCommand = { mode: 'stream', command, args, options };
    this.calls.push(call);
    return this.resolve(call).code;
  }

  /** Every recorded call whose binary and leading arguments match. */
  find(command: string, ...leading: string[]): RecordedCommand[] {
    return this.calls.filter(
      (c) => binary(c.command) === command && leading.every((a, i) => c.args[i] === a),
    );
  }
}

/** Builds a rule matching a binary name and a leading argument prefix. */
export function rule(
  command: string,
  leading: readonly string[],
  answer: CommandRule['answer'],
): CommandRule {
  return {
    match: (bin, args) => bin === command && leading.every((a, i) => args[i] === a),
    answer,
  };
}

/** A prompter that replays queued answers and records every question. */
export class FakePrompter implements Prompter {
  readonly questions: string[] = [];
  private readonly answers: unknown[];

  constructor(answers: readonly unknown[]) {
    this.answers = [...answers];
  }

  private next(question: string): unknown {
    this.questions.push(question);
    if (this.answers.length === 0) throw new Error(`unanswered prompt: ${question}`);
    return this.answers.shift();
  }

  async ask(question: string, fallback?: string): Promise<string> {
    const answer = this.next(question);
    if (answer === '' || answer === undefined) return fallback ?? '';
    return String(answer);
  }

  async askSecret(question: string): Promise<string> {
    return String(this.next(question));
  }

  async confirm(question: string, fallback: boolean): Promise<boolean> {
    const answer = this.next(question);
    if (answer === '' || answer === undefined) return fallback;
    return Boolean(answer);
  }

  async choose(question: string, _options: readonly string[], fallbackIndex = 0): Promise<number> {
    const answer = this.next(question);
    if (answer === '' || answer === undefined) return fallbackIndex;
    return Number(answer);
  }

  /** Answers not yet consumed — a passing scenario should leave none. */
  get remaining(): number {
    return this.answers.length;
  }
}

/** A logger writing JSON lines into an array. */
export function collectingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const logger = pino(
    { level: 'info' },
    {
      write(line: string) {
        lines.push(line);
      },
    },
  );
  return { logger, lines };
}
