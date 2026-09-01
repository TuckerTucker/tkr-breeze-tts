/**
 * Naming a voice at the moment the operator decides they like it.
 *
 * The name is pre-filled from the instruction that produced the clip and left
 * editable in place, rather than asked for later from memory — by which point
 * the operator has to reconstruct what made this one worth keeping.
 *
 * @module
 */

/**
 * Suggest a voice name from an instruction.
 *
 * @param instruction - The voice description, when there was one.
 * @param fallback - Used when there is nothing to draw on.
 * @returns A short, editable suggestion.
 */
export function suggestName(instruction: string | undefined, fallback = 'New voice'): string {
  const source = (instruction ?? '').trim();
  if (!source) return fallback;
  const firstClause = source.split(/[,.;]/)[0]?.trim() ?? source;
  const words = firstClause.split(/\s+/).slice(0, 5).join(' ');
  const cleaned = words.replace(/^(a|an|the)\s+/i, '');
  if (!cleaned) return fallback;
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}
