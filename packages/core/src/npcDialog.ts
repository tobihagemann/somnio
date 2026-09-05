/**
 * Splits a dialog script on the literal `---` separator. A single leading `\n` and a single
 * trailing `\n` are trimmed from each step; other whitespace is preserved verbatim. The `$name`
 * token is left intact — substitution happens at emit time on the AI tick. An empty script
 * yields `[]`.
 */
export function dialogSteps(dialogScript: string): string[] {
  if (dialogScript.length === 0) return [];
  return dialogScript.split('---').map((step) => {
    let trimmed = step;
    if (trimmed.startsWith('\n')) trimmed = trimmed.slice(1);
    if (trimmed.endsWith('\n')) trimmed = trimmed.slice(0, -1);
    return trimmed;
  });
}
