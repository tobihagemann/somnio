import { SOMNIO_CONSTANTS } from '@/core'
import type { WorldEntityKind } from '@/core'
import { PROTOCOL_BYTE_CAPS, truncateToUTF8Bytes } from '@/protocol'

/**
 * Canvas ports of `SpeechBubbleArt` and `NamePlaqueArt` (SomnioScene3D).
 *
 * The Swift originals draw through `OverlayRaster`, which flips CoreGraphics into a top-left-origin
 * legacy-pixel space and supersamples by 8. Canvas 2D is already top-left-origin, so every
 * coordinate below transfers verbatim except the text baseline, and that one is worth stating
 * carefully: `NSAttributedString.draw(at:)` in a flipped context positions the top of the **line
 * box** (ascent + descent + leading), while canvas `textBaseline: 'top'` and `'middle'` work from the
 * **em box**. The two differ by the font's internal leading, which is what put every bubble line and
 * every plaque a pixel or two off vertically. Both now compute an explicit alphabetic baseline from
 * `fontBoundingBox*` metrics, so the line-box model matches on both sides.
 */

/** Texture pixels per legacy pixel, matching `OverlayRaster.scale`. */
export const OVERLAY_RASTER_SCALE = 8

export const SPEECH_BUBBLE = {
  widthPixels: SOMNIO_CONSTANTS.speechBubbleWidthPixels,
  fontSize: SOMNIO_CONSTANTS.speechBubbleFontSize,
  lineHeight: 12,
  tailHeight: 10,
  tailHalfBase: 7,
  bodyPadding: 5,
  cornerRadius: 8,
} as const

export const NAME_PLAQUE = {
  fontSize: 11,
  playerBackground: 'rgb(221, 221, 221)',
  npcBackground: 'rgb(204, 255, 255)',
} as const

export interface RasterArt {
  canvas: HTMLCanvasElement
  /** Footprint in legacy pixels; the scene scales it into world metres. */
  widthPixels: number
  heightPixels: number
}

export function speechBubbleFrameSize(lineCount: number): { width: number; height: number } {
  return {
    width: SPEECH_BUBBLE.widthPixels,
    height:
      Math.max(lineCount, 1) * SPEECH_BUBBLE.lineHeight +
      SPEECH_BUBBLE.tailHeight +
      2 * SPEECH_BUBBLE.bodyPadding,
  }
}

/** A supersampled canvas whose drawing context works in legacy-pixel units. */
function rasterCanvas(
  widthPixels: number,
  heightPixels: number
): {
  canvas: HTMLCanvasElement
  context: CanvasRenderingContext2D | null
} {
  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil(widthPixels * OVERLAY_RASTER_SCALE)
  canvas.height = Math.ceil(heightPixels * OVERLAY_RASTER_SCALE)
  const context = canvas.getContext('2d')
  context?.scale(OVERLAY_RASTER_SCALE, OVERLAY_RASTER_SCALE)
  return { canvas, context }
}

/**
 * How far the Swift tail's base sits above the body's bottom edge: the triangle is declared at
 * `bodyHeight - 2` while the rounded body's bottom edge is at `bodyHeight - 0.5`, so 1.5px of the
 * triangle lies inside the body and the union hides it.
 */
const TAIL_BODY_TUCK = 1.5

/**
 * Rounded body plus downward tail as **one** outline, inset half a stroke so the 1px border
 * survives the bitmap edge.
 *
 * Authored as a single traversal rather than a rounded rect plus a triangle. Swift can take that
 * shortcut because `CGPath.union` welds the two and drops the body edge across the tail mouth;
 * canvas has no boolean op, so two subpaths would stroke that edge and the balloon would read as a
 * rectangle with a separate pennant hanging off it. Walking the union directly needs no boolean.
 */
function balloonPath(width: number, height: number): Path2D {
  const radius = SPEECH_BUBBLE.cornerRadius
  const half = SPEECH_BUBBLE.tailHalfBase
  const left = 0.5
  const right = width - 0.5
  const top = 0.5
  const bottom = height - SPEECH_BUBBLE.tailHeight - 0.5
  const centerX = width / 2

  const path = new Path2D()
  path.moveTo(left + radius, top)
  path.lineTo(right - radius, top)
  path.arcTo(right, top, right, top + radius, radius)
  path.lineTo(right, bottom - radius)
  path.arcTo(right, bottom, right - radius, bottom, radius)
  // The tail interrupts the bottom edge, which is exactly what the union expresses.
  //
  // `half` is the triangle's half-base where it is *declared*, and Swift declares it 2px above the
  // body's bottom edge ("the tail base tucks 2 px into the body so the union has no seam"). Walking
  // the outline directly means the mouth has to be the width of the union at the crossing, not at
  // the declaration — the upper 1.5px of the triangle is inside the body and never drawn. Using the
  // full `half` here draws a mouth ~0.9px wider per side than the native bubble.
  const mouthHalf = half * (1 - TAIL_BODY_TUCK / (SPEECH_BUBBLE.tailHeight + TAIL_BODY_TUCK))
  path.lineTo(centerX + mouthHalf, bottom)
  path.lineTo(centerX, height - 0.5)
  path.lineTo(centerX - mouthHalf, bottom)
  path.lineTo(left + radius, bottom)
  path.arcTo(left, bottom, left, bottom - radius, radius)
  path.lineTo(left, top + radius)
  path.arcTo(left, top, left + radius, top, radius)
  path.closePath()
  return path
}

/**
 * The comic balloon: white body, 1px black outline, centred black text.
 *
 * Drawn as a transparent-background path fill rather than the Swift pair of a full-bleed colour
 * image and a separate opacity mask — a canvas texture carries its own alpha, so the silhouette
 * and the artwork are one pass.
 */
export function renderSpeechBubble(lines: readonly string[]): RasterArt {
  const { width, height } = speechBubbleFrameSize(lines.length)
  const { canvas, context } = rasterCanvas(width, height)
  if (context !== null) {
    const balloon = balloonPath(width, height)
    context.fillStyle = '#ffffff'
    context.fill(balloon)
    context.strokeStyle = '#000000'
    context.lineWidth = 1
    context.stroke(balloon)
    context.fillStyle = '#000000'
    context.font = `${SPEECH_BUBBLE.fontSize}px system-ui, sans-serif`
    context.textBaseline = 'alphabetic'
    context.textAlign = 'center'
    lines.forEach((line, index) => {
      const boxTop = SPEECH_BUBBLE.bodyPadding + index * SPEECH_BUBBLE.lineHeight
      context.fillText(line, width / 2, baselineBelowBoxTop(boxTop, SPEECH_BUBBLE.fontSize))
    })
  }
  return { canvas, widthPixels: width, heightPixels: height }
}

/**
 * The name label under a player or NPC: black text on a filled box with a 1px black border.
 *
 * The name is byte-clamped before measuring, so a hostile server cannot drive an enormous
 * supersampled bitmap off a pathological nickname.
 */
export function renderNamePlaque(name: string, background: string, bold: boolean): RasterArt {
  // `maxRenderedNameUTF8Bytes` is the protocol's identifier cap, which honest servers already
  // enforce at registration; the clamp is what stops a hostile one driving a giant bitmap.
  const clamped = truncateToUTF8Bytes(name, PROTOCOL_BYTE_CAPS.identifier)
  const font = `${bold ? 'bold ' : ''}${NAME_PLAQUE.fontSize}px system-ui, sans-serif`
  const textWidth = measureTextWidth(clamped, font)
  // The Swift original sizes the box from `NSAttributedString.size()`, whose height is the font's
  // line box rather than the glyph extent. Reading `fontBoundingBoxDescent` here lands 1px short —
  // AppKit rounds its line height up past the font's own descent — and the box being a pixel
  // shallower is what leaves the centred text riding half a pixel high against the native plaque.
  const width = Math.max(Math.ceil(textWidth + 6), 1)
  const height = Math.max(Math.ceil(nativeLineBoxHeight(NAME_PLAQUE.fontSize) + 4), 1)
  const { canvas, context } = rasterCanvas(width, height)
  if (context !== null) {
    context.fillStyle = background
    context.fillRect(0, 0, width, height)
    context.strokeStyle = '#000000'
    context.lineWidth = 1
    context.strokeRect(0.5, 0.5, width - 1, height - 1)
    context.fillStyle = '#000000'
    context.font = font
    context.textBaseline = 'alphabetic'
    context.textAlign = 'center'
    context.fillText(clamped, width / 2, baselineInCenteredBox(height, NAME_PLAQUE.fontSize))
  }
  return { canvas, widthPixels: width, heightPixels: height }
}

/** Shared measuring canvas: creating one per plaque would allocate a context per name change. */
let measuringContext: CanvasRenderingContext2D | null | undefined

function measuringContextFor(font: string): CanvasRenderingContext2D | null {
  if (measuringContext === undefined) {
    measuringContext = document.createElement('canvas').getContext('2d')
  }
  if (measuringContext !== null) measuringContext.font = font
  return measuringContext
}

function measureTextWidth(text: string, font: string): number {
  const context = measuringContextFor(font)
  if (context === null) return text.length * NAME_PLAQUE.fontSize * 0.6
  return context.measureText(text).width
}

/**
 * `NSAttributedString`'s line box for the system font, recorded rather than read from canvas.
 *
 * Both numbers come from rasterizing through `OverlayRaster`'s exact pipeline and reading the ink
 * rows, at System-8 through System-13:
 *
 * - the baseline sits exactly `fontSize` below the line-box top. Chrome's `fontBoundingBoxAscent`
 *   reports the same value, so the two already agree — stating it here makes Firefox and Safari agree
 *   too, rather than trusting each engine's metric selection.
 * - the line box extends **3px** below that baseline, where `fontBoundingBoxDescent` reports 2. The
 *   extra pixel is AppKit rounding its default line height up past the font's own descent
 *   (`NSFont.descender` is -2.32 at 11pt), and there is nothing in canvas to derive it from.
 *
 * Recorded rather than derived because AppKit's line-height rounding is not a published formula —
 * the same reason `float.ts` carries `FLOAT_PI` as a literal instead of computing it.
 * `NativeLineBoxTests` re-measures both on the Swift side, so a macOS font change fails a test
 * instead of silently drifting the two clients apart.
 */
export const NATIVE_LINE_BOX = { descentBelowBaseline: 3 } as const

/** Baseline offset below a line box's top edge, as `NSAttributedString.draw(at:)` places it. */
function nativeBaselineOffset(fontSize: number): number {
  return fontSize
}

/** `NSAttributedString.size().height` — the quantity the plaque sizes its box from. */
export function nativeLineBoxHeight(fontSize: number): number {
  return fontSize + NATIVE_LINE_BOX.descentBelowBaseline
}

/**
 * Baseline for a line box whose top edge sits at `boxTop`.
 *
 * `NSAttributedString.draw(at:)` in a flipped context takes the top-left of the **line box**, not of
 * the glyphs. Canvas `textBaseline: 'top'` measures from the top of the em box instead — short by the
 * font's internal leading — which drew every bubble line high against the native one.
 */
export function baselineBelowBoxTop(boxTop: number, fontSize: number): number {
  return boxTop + nativeBaselineOffset(fontSize)
}

/**
 * Baseline for a line box centred in `height`, which is what the plaque's
 * `(size.height - textSize.height) / 2` origin produces.
 *
 * Not canvas `textBaseline: 'middle'` at `height / 2`: that centres the em box, leaving the text low
 * by half the difference between the two boxes.
 */
export function baselineInCenteredBox(height: number, fontSize: number): number {
  return (height - nativeLineBoxHeight(fontSize)) / 2 + nativeBaselineOffset(fontSize)
}

/** Background for an entity's plaque, or `undefined` for kinds that get none. */
export function namePlaqueBackground(kind: WorldEntityKind): string | undefined {
  if (kind === 'player' || kind === 'peer') return NAME_PLAQUE.playerBackground
  if (kind === 'npc') return NAME_PLAQUE.npcBackground
  // Monsters get no plaque, as natively.
  return undefined
}
