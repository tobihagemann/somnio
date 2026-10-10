import { SOMNIO_PROTOCOL_CONSTANTS, utf8ByteLength } from '@somnio/protocol';
import type { SpeechKind } from '@somnio/protocol';

/**
 * How far speech carries. Each kind is heard whole within its clear radius, crumbles across the
 * band out to its reach, and is not heard at all past it.
 */
export const SPEECH = {
  whisper: { clearMetres: 1.5, reachMetres: 3 },
  say: { clearMetres: 6, reachMetres: 12 },
  yell: { clearMetres: 40, reachMetres: 80 },
  /** What a door adds to a yell's way through it. Larger than a yell's clear radius, so a voice through a door always crumbles. */
  doorMuffleMetres: 44,
} as const;

/** What stands in for each run of words a listener missed. */
const MISSED = '...';

/** 1 within the clear radius, falling to 0 across the band, and `undefined` from the reach on: nothing is heard. */
export function speechClarity(kind: SpeechKind, metres: number): number | undefined {
  const { clearMetres, reachMetres } = SPEECH[kind];
  if (metres >= reachMetres) return undefined;
  if (metres <= clearMetres) return 1;
  return (reachMetres - metres) / (reachMetres - clearMetres);
}

/**
 * The line as a listener at `clarity` hears it. Below 1 at least one word is always missing, so a
 * line in the band is never heard whole. The share of words dropped grows as the clarity falls,
 * `roll` (in `[0, 1)`) picks which, and each run of missed words reads as one `...`. The same rolls
 * at a lower clarity drop every word they drop at a higher one. A dropped short word can grow the
 * line, so the result is cut back at a word to fit the say cap.
 */
export function crumble(text: string, clarity: number, roll: () => number): string {
  if (clarity >= 1) return text;
  const words = text.split(/\s+/).filter((word) => word !== '');
  if (words.length === 0) return text;
  const order = words.map((_, index) => index);
  const dropping = Math.min(words.length, Math.max(1, Math.round((1 - clarity) * words.length)));
  for (let index = 0; index < dropping; index += 1) {
    const pick = Math.min(order.length - 1, index + Math.floor(roll() * (order.length - index)));
    [order[index], order[pick]] = [order[pick]!, order[index]!];
  }
  const dropped = new Set(order.slice(0, dropping));
  const heard: string[] = [];
  words.forEach((word, index) => {
    if (!dropped.has(index)) heard.push(word);
    else if (heard.at(-1) !== MISSED) heard.push(MISSED);
  });
  return fitWithinSayCap(heard);
}

/** Joins the words, cutting the line back at a word, and ending it in a whole `...`, when it would pass the say cap. */
function fitWithinSayCap(words: readonly string[]): string {
  const cap = SOMNIO_PROTOCOL_CONSTANTS.maxSayUTF8Bytes;
  const line = words.join(' ');
  if (utf8ByteLength(line) <= cap) return line;
  const kept: string[] = [];
  for (const word of words) {
    const ending = word === MISSED ? [] : [MISSED];
    if (utf8ByteLength([...kept, word, ...ending].join(' ')) > cap) break;
    kept.push(word);
  }
  if (kept.at(-1) !== MISSED) kept.push(MISSED);
  return kept.join(' ');
}
