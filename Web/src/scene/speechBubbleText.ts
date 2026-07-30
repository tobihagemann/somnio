import { SOMNIO_CONSTANTS } from '@/core/constants'

/**
 * Mirror of `Sources/SomnioUI/SpeechBubbleText.swift`. The measurement is injected so the greedy
 * wrap is testable without font metrics, exactly as the Swift `widthOf` seam allows.
 */

export const BUBBLE_WIDTH = SOMNIO_CONSTANTS.speechBubbleWidthPixels
export const BUBBLE_FONT_SIZE = SOMNIO_CONSTANTS.speechBubbleFontSize

/** ASCII, matching the project-wide rule — never the Unicode ellipsis. */
export const TRUNCATION_GLYPH = '...'

/** Returns at most `maxLines` lines, marking truncation on the last surviving line. */
export function capLines(lines: string[], maxLines = 4, glyph = TRUNCATION_GLYPH): string[] {
  if (maxLines <= 0) return []
  if (lines.length <= maxLines) return lines
  const capped = lines.slice(0, maxLines)
  capped[capped.length - 1] += glyph
  return capped
}

/**
 * Greedy word wrap against `BUBBLE_WIDTH`.
 *
 * Respects existing whitespace boundaries only: a single unbreakable word wider than the bubble
 * is emitted as its own line and left for the renderer to truncate at draw time, rather than
 * being split mid-word.
 */
export function wrapSpeech(
  text: string,
  widthOf: (line: string) => number,
  maxLines = 4,
  glyph = TRUNCATION_GLYPH
): string[] {
  const words = text.split(' ')
  if (words.length === 0) return []
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    const candidate = current === '' ? word : `${current} ${word}`
    if (widthOf(candidate) <= BUBBLE_WIDTH) {
      current = candidate
    } else {
      if (current !== '') lines.push(current)
      current = word
    }
  }
  if (current !== '') lines.push(current)
  return capLines(lines, maxLines, glyph)
}

/**
 * Canvas-backed measurement for the browser, at the same metrics the balloon is drawn with —
 * both sides must resolve to `SomnioConstants` or wrapped lines overflow the balloon body.
 */
export function canvasWidthMeasurer(): (line: string) => number {
  const context = document.createElement('canvas').getContext('2d')
  if (context === null) return (line) => line.length * BUBBLE_FONT_SIZE * 0.5
  context.font = `${BUBBLE_FONT_SIZE}px system-ui, sans-serif`
  return (line) => context.measureText(line).width
}

/** Lifetime rule from the legacy client: 2 s plus a second per line. */
export function bubbleLifetimeMs(lineCount: number): number {
  return 2000 + lineCount * 1000
}
