import { describe, expect, it } from 'vitest';
import { SOMNIO_PROTOCOL_CONSTANTS, utf8ByteLength } from '@somnio/protocol';
import { crumble, speechClarity } from '../src/speech.ts';

const TEN_WORDS = 'one two three four five six seven eight nine ten';

/** The words of a crumbled line a listener still heard. */
function heard(line: string): string[] {
  return line.split(' ').filter((word) => word !== '...');
}

/** A roll that walks through `[0, 1)` and comes round again, so the dropped words spread over the line. */
function cycling(): () => number {
  let step = 0;
  return () => {
    step += 1;
    return (step * 0.37) % 1;
  };
}

describe('speechClarity', () => {
  it.each([
    ['whisper', 1.5, 2.25, 3],
    ['say', 6, 9, 12],
    ['yell', 40, 60, 80],
  ] as const)('hears a %s clearly to %f m, half at %f m, and not at all from %f m', (kind, clear, half, reach) => {
    expect(speechClarity(kind, 0)).toBe(1);
    expect(speechClarity(kind, clear)).toBe(1);
    expect(speechClarity(kind, half)).toBeCloseTo(0.5, 12);
    expect(speechClarity(kind, reach)).toBeUndefined();
  });
});

describe('crumble', () => {
  it('leaves a clear line as it is', () => {
    expect(crumble('ja  gut', 1, () => 0)).toBe('ja  gut');
  });

  /** A roll this high would keep every word if each word were rolled for on its own. */
  it('drops a word even just past the clear radius', () => {
    expect(crumble('Hilfe!', 0.99, () => 0.999)).toBe('...');
    expect(heard(crumble(TEN_WORDS, 0.99, () => 0.999))).toHaveLength(9);
  });

  it('drops a share of the words that grows as the clarity falls', () => {
    expect(heard(crumble(TEN_WORDS, 0.5, cycling()))).toHaveLength(5);
    expect(heard(crumble(TEN_WORDS, 0.2, cycling()))).toHaveLength(2);
  });

  it('reads each run of missed words as one mark', () => {
    expect(crumble(TEN_WORDS, 0.5, () => 0)).toBe('... six seven eight nine ten');
  });

  it('marks no gap where the line had two spaces', () => {
    for (const roll of [0, 0.5, 0.99]) expect(['... gut', 'ja ...']).toContain(crumble('ja  gut', 0.5, () => roll));
  });

  it('leaves a line of nothing but spaces as it is', () => {
    expect(crumble('   ', 0.5, () => 0)).toBe('   ');
  });

  /** A dropped one-letter word grows to a three-byte mark. */
  it('fits a line its marks grew past the say cap, ending in a whole mark', () => {
    const line = Array.from({ length: 128 }, () => 'a').join(' ');
    expect(utf8ByteLength(line)).toBeLessThanOrEqual(SOMNIO_PROTOCOL_CONSTANTS.maxSayUTF8Bytes);
    const crumbled = crumble(line, 0.5, cycling());
    expect(utf8ByteLength(crumbled)).toBeLessThanOrEqual(SOMNIO_PROTOCOL_CONSTANTS.maxSayUTF8Bytes);
    expect(crumbled.endsWith(' ...')).toBe(true);
    expect(crumbled.split(' ').every((word) => word === 'a' || word === '...')).toBe(true);
  });

  it('cuts at a word rather than leaving a stray dot', () => {
    const crumbled = crumble(`${'x'.repeat(254)} a`, 0.9, () => 0.99);
    expect(utf8ByteLength(crumbled)).toBeLessThanOrEqual(SOMNIO_PROTOCOL_CONSTANTS.maxSayUTF8Bytes);
    expect(crumbled.split(' ').every((word) => word === '...' || word === 'x'.repeat(254))).toBe(true);
  });
});
