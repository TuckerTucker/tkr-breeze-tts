/**
 * Child-process boundary for the setup walkthrough.
 *
 * Every external tool the walkthrough drives — uv, the Modal CLI, npm — goes
 * through this interface so the phase logic can be exercised in tests with a
 * scripted runner, the same way the gateway's upstream boundary is injected.
 *
 * Two shapes are enough: `capture` for commands whose output is parsed, and
 * `stream` for long-running ones whose progress the operator should watch.
 *
 * @module
 */

import { spawn } from 'node:child_process';

/** Options common to both shapes. */
export interface CommandOptions {
  /** Working directory. Defaults to the current process's. */
  readonly cwd?: string;
  /** Extra environment, layered over the process environment. */
  readonly env?: Readonly<Record<string, string>>;
}

/** What a captured command produced. */
export interface CommandResult {
  /** Exit code; 127 when the binary could not be started at all. */
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** The injected process boundary. */
export interface CommandRunner {
  /**
   * Run a command and collect its output.
   *
   * @param command - Binary to run.
   * @param args - Arguments.
   * @param options - Working directory and extra environment.
   * @returns Exit code and both streams. Never rejects for a non-zero exit;
   *   the caller decides what a failure means.
   */
  capture(
    command: string,
    args: readonly string[],
    options?: CommandOptions,
  ): Promise<CommandResult>;

  /**
   * Run a command with the terminal attached, so its progress is visible and
   * it can prompt the operator itself.
   *
   * @param command - Binary to run.
   * @param args - Arguments.
   * @param options - Working directory and extra environment.
   * @returns Exit code; 127 when the binary could not be started at all.
   */
  stream(
    command: string,
    args: readonly string[],
    options?: CommandOptions,
  ): Promise<number>;
}

/** Exit code reported when a binary is absent or not executable. */
export const SPAWN_FAILURE_CODE = 127;

/** The real boundary: `child_process.spawn`. */
export class ProcessRunner implements CommandRunner {
  async capture(
    command: string,
    args: readonly string[],
    options: CommandOptions = {},
  ): Promise<CommandResult> {
    return new Promise((resolve) => {
      const child = spawn(command, [...args], {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });
      child.on('error', (error) => {
        resolve({ code: SPAWN_FAILURE_CODE, stdout, stderr: `${stderr}${error.message}` });
      });
      child.on('close', (code) => {
        resolve({ code: code ?? SPAWN_FAILURE_CODE, stdout, stderr });
      });
    });
  }

  async stream(
    command: string,
    args: readonly string[],
    options: CommandOptions = {},
  ): Promise<number> {
    return new Promise((resolve) => {
      const child = spawn(command, [...args], {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        stdio: 'inherit',
      });
      child.on('error', () => resolve(SPAWN_FAILURE_CODE));
      child.on('close', (code) => resolve(code ?? SPAWN_FAILURE_CODE));
    });
  }
}
