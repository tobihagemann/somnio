import { SOMNIO_PROTOCOL_CONSTANTS, utf8ByteLength } from '@somnio/protocol';

/** Where a step names the player the NPC speaks to. */
const NAME_TOKEN = '$name';

/**
 * Splits a dialog script on the literal `---` separator. A single leading `\n` and a single
 * trailing `\n` are trimmed from each step; other whitespace is preserved verbatim. The `$name`
 * token is left intact — substitution happens at emit time. An empty script
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

/** The line a step becomes when spoken to `targetName`. */
export function dialogLine(step: string, targetName: string): string {
  // A replacer function, so a `$&` in the name is inserted as written rather than expanded.
  return step.replaceAll(NAME_TOKEN, () => targetName);
}

/**
 * Whether every line the step can become fits the say cap, which a client refuses a line past:
 * the worst case is each `$name` replaced by a name at the identifier cap, the longest nickname
 * the server accepts.
 */
export function dialogLineFits(step: string): boolean {
  const names = step.split(NAME_TOKEN).length - 1;
  const longest = utf8ByteLength(step) + names * (SOMNIO_PROTOCOL_CONSTANTS.maxIdentifierUTF8Bytes - utf8ByteLength(NAME_TOKEN));
  return longest <= SOMNIO_PROTOCOL_CONSTANTS.maxSayUTF8Bytes;
}
