import { SOMNIO_CONSTANTS } from '@somnio/core';

/**
 * Speech-bubble line breaking. The measurement is injected so the greedy wrap is testable without
 * font metrics.
 */

/** How far a line keeps from each side of the bubble, so no letter touches its outline. */
export const BUBBLE_TEXT_INSET = 5;
/** The widest a line may be. */
export const BUBBLE_TEXT_WIDTH = SOMNIO_CONSTANTS.speechBubbleWidthPixels - 2 * BUBBLE_TEXT_INSET;
const BUBBLE_FONT_SIZE = SOMNIO_CONSTANTS.speechBubbleFontSize;
/** The font lines are wrapped, sized, and drawn in. */
export const BUBBLE_FONT = `${BUBBLE_FONT_SIZE}px system-ui, sans-serif`;

const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * Greedy word wrap against `BUBBLE_TEXT_WIDTH`, breaking at spaces. A word wider than a line on its
 * own is broken across lines between its graphemes, so it is not squeezed onto one line. Every line
 * is kept, however many the text wraps to.
 */
export function wrapSpeech(text: string, widthOf: (line: string) => number): string[] {
  const words = text.split(' ').flatMap((word) => breakWord(word, widthOf));
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current === '' ? word : `${current} ${word}`;
    if (widthOf(candidate) <= BUBBLE_TEXT_WIDTH) {
      current = candidate;
    } else {
      if (current !== '') lines.push(current);
      current = word;
    }
  }
  if (current !== '') lines.push(current);
  return lines;
}

/** A word cut into pieces that each fit a line, between graphemes so no letter or emoji is split. */
function breakWord(word: string, widthOf: (line: string) => number): string[] {
  if (widthOf(word) <= BUBBLE_TEXT_WIDTH) return [word];
  const pieces: string[] = [];
  let piece = '';
  for (const { segment } of GRAPHEME_SEGMENTER.segment(word)) {
    if (piece !== '' && widthOf(piece + segment) > BUBBLE_TEXT_WIDTH) {
      pieces.push(piece);
      piece = '';
    }
    piece += segment;
  }
  if (piece !== '') pieces.push(piece);
  return pieces;
}

/** Canvas-backed measurement for the browser, in the font the balloon is sized and drawn in. */
export function canvasWidthMeasurer(): (line: string) => number {
  const context = document.createElement('canvas').getContext('2d');
  if (context === null) return (line) => line.length * BUBBLE_FONT_SIZE * 0.5;
  context.font = BUBBLE_FONT;
  return (line) => context.measureText(line).width;
}
