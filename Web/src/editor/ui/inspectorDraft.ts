/**
 * The reseed rule every inspector field shares. The comparison is against the **departing**
 * value's rendering, because that
 * is what tells a draft the user typed into apart from one that merely hasn't caught up:
 * reseed an untouched focused draft too eagerly and nothing breaks; reseed a typed-into one
 * and the edit is lost mid-keystroke; skip an untouched one and a post-commit undo leaves
 * the reverted value on screen, then re-commits the stale draft on blur.
 *
 * Values arrive pre-rendered to strings so the rule stays generic over field types (a
 * non-integer field must compare renderings, not raw text).
 */
export function reseeded(draft: string, isFocused: boolean, from: string, to: string): string | undefined {
  if (isFocused && draft !== from) return undefined
  return to
}
