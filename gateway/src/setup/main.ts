/**
 * Entry point for `npm run setup`: the guided installation.
 *
 * Wires the real terminal, process runner and a file logger into the
 * walkthrough. Operator-facing text goes to stdout; structured events go to
 * `.cache/setup.log` so a failed run can be read back without the log lines
 * having competed with the prompts. The credential is redacted there as a
 * second line of defence, though nothing writes it in the first place.
 *
 * Flags:
 *   --no-start   configure and build, but do not start the gateway at the end.
 *
 * @module
 */

import { join } from 'node:path';

import pino from 'pino';

import { REPO_ROOT } from '../config.js';
import { PromptClosed, PromptInterrupted, TerminalPrompter } from './prompter.js';
import { ProcessRunner, type CommandOptions } from './runner.js';
import { SetupAbort, runWalkthrough } from './walkthrough.js';

/** Where the structured log of a setup run is written. */
export const SETUP_LOG_PATH: string = join(REPO_ROOT, '.cache', 'setup.log');

/**
 * A process runner that hands the terminal to each streamed child.
 *
 * The prompter's readline holds stdin (and, on a terminal, raw mode) while it
 * is open. A child that prompts on the same stdin — Modal's sign-in, for one —
 * needs both released first; the prompter reopens on its next question.
 */
class TerminalHandoffRunner extends ProcessRunner {
  private readonly prompter: TerminalPrompter;

  constructor(prompter: TerminalPrompter) {
    super();
    this.prompter = prompter;
  }

  override async stream(
    command: string,
    args: readonly string[],
    options?: CommandOptions,
  ): Promise<number> {
    this.prompter.suspend();
    return super.stream(command, args, options);
  }
}

/**
 * Run the walkthrough and translate its outcome into an exit code.
 *
 * @param argv - Command-line arguments after the script name.
 * @returns The exit code: 0 on success, 1 for an abort with a remedy, 130
 *   when the operator interrupted a prompt.
 */
export async function main(argv: readonly string[]): Promise<number> {
  const logger = pino(
    {
      level: process.env.LOG_LEVEL ?? 'info',
      redact: { paths: ['*.key', '*.secret', 'MODAL_KEY', 'MODAL_SECRET'], censor: '[redacted]' },
    },
    pino.destination({ dest: SETUP_LOG_PATH, mkdir: true, sync: true }),
  );
  const out = (line: string): void => {
    process.stdout.write(`${line}\n`);
  };

  out('Breeze TTS 2 — guided setup');
  out(`Structured log: ${SETUP_LOG_PATH}`);

  const prompter = new TerminalPrompter();
  try {
    await runWalkthrough({
      repoRoot: REPO_ROOT,
      runner: new TerminalHandoffRunner(prompter),
      prompter,
      out,
      logger,
      options: { start: !argv.includes('--no-start') },
    });
    return 0;
  } catch (error) {
    if (error instanceof SetupAbort) {
      logger.error({ remedy: error.remedy }, error.message);
      out('');
      out(`Setup stopped: ${error.message}`);
      out(error.remedy);
      out('Run "npm run setup" again to resume; completed phases are detected and skipped.');
      return 1;
    }
    if (error instanceof PromptInterrupted) {
      out('');
      out('Interrupted. Run "npm run setup" again to resume.');
      return 130;
    }
    if (error instanceof PromptClosed) {
      logger.error(error.message);
      out('');
      out(`Setup stopped: ${error.message}`);
      out('Run "npm run setup" from a terminal, or pipe one answer line per question.');
      return 1;
    }
    logger.error({ err: error }, 'setup failed unexpectedly');
    throw error;
  } finally {
    prompter.dispose();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
