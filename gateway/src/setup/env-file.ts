/**
 * Editing the repo-root `.env` without losing what the operator already wrote.
 *
 * The template's comments are the only place the meaning of each value is
 * explained beside the value itself, so the walkthrough edits the file in
 * place rather than regenerating it: an existing assignment is replaced on its
 * own line, a new one is appended, and every other line is left untouched.
 *
 * Pure text manipulation lives here so it can be tested without a filesystem;
 * the write itself is in {@link writeEnvFile}.
 *
 * @module
 */

import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

/** Mode for a file holding a credential: readable by its owner only. */
export const ENV_FILE_MODE = 0o600;

/**
 * Replace or add `KEY=value` assignments in dotenv text.
 *
 * The first uncommented assignment of a key is replaced where it stands so the
 * template's explanatory comment stays beside it. A key with no assignment is
 * appended under a marker line. Comments, blank lines and unrelated keys are
 * preserved byte for byte.
 *
 * @param text - Existing dotenv content. May be empty.
 * @param values - Assignments to apply.
 * @returns The updated text, ending in a newline.
 */
export function upsertEnvValues(
  text: string,
  values: Readonly<Record<string, string>>,
): string {
  const lines = text.length === 0 ? [] : text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const pending = new Map(Object.entries(values));

  const updated = lines.map((line) => {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (!match) return line;
    const key = match[1]!;
    if (!pending.has(key)) return line;
    const value = pending.get(key)!;
    pending.delete(key);
    return `${key}=${value}`;
  });

  if (pending.size > 0) {
    if (updated.length > 0) updated.push('');
    updated.push('# ── Added by `npm run setup` ─────────────────────────────────────────────────');
    for (const [key, value] of pending) updated.push(`${key}=${value}`);
  }

  return `${updated.join('\n')}\n`;
}

/**
 * Apply assignments to a dotenv file, creating it from a template when absent.
 *
 * The file is written owner-read-only because it holds the proxy credential;
 * the mode is applied on every write, not only on creation, so a file the
 * operator created by hand with a looser mode is tightened the first time the
 * walkthrough touches it.
 *
 * @param path - The dotenv file to update.
 * @param values - Assignments to apply.
 * @param templatePath - Text to start from when `path` does not exist yet. A
 *   missing template yields an empty starting point rather than an error.
 */
export function writeEnvFile(
  path: string,
  values: Readonly<Record<string, string>>,
  templatePath?: string,
): void {
  const existing = existsSync(path)
    ? readFileSync(path, 'utf8')
    : templatePath && existsSync(templatePath)
      ? readFileSync(templatePath, 'utf8')
      : '';
  writeFileSync(path, upsertEnvValues(existing, values), { mode: ENV_FILE_MODE });
  chmodSync(path, ENV_FILE_MODE);
}
