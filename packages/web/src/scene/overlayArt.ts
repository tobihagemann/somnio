import { SOMNIO_CONSTANTS } from '@somnio/core';
import type { WorldEntityKind } from '@somnio/core';
import { PROTOCOL_BYTE_CAPS, truncateToUTF8Bytes } from '@somnio/protocol';
import type { Condition, SpeechKind } from '@somnio/protocol';
import { BUBBLE_TEXT_WIDTH } from './speechBubbleText';

/**
 * The speech bubble and name plaque, rasterized on a canvas in a top-left-origin overlay-pixel
 * space supersampled by 8. Every coordinate is authored in that space; the text baseline is the
 * one that needs care: the bubble and plaque are laid out from the top of the **line box**
 * (ascent + descent + leading), while canvas `textBaseline: 'top'` and `'middle'` work from the
 * **em box**. The two differ by the font's internal leading, which would put every bubble line
 * and every plaque a pixel or two off vertically, so both compute an explicit alphabetic baseline
 * from the recorded line box.
 */

/** Texture pixels per overlay pixel. */
const OVERLAY_RASTER_SCALE = 8;

const SPEECH_BUBBLE = {
  widthPixels: SOMNIO_CONSTANTS.speechBubbleWidthPixels,
  fontSize: SOMNIO_CONSTANTS.speechBubbleFontSize,
  lineHeight: 12,
  tailHeight: 10,
  tailHalfBase: 7,
  bodyPadding: 5,
  cornerRadius: 8,
  /** `casing` is the width of a black edge stroked under the line, so a yellow outline still reads against the world. */
  outline: {
    whisper: { lineWidth: 1, dash: [3, 2], color: '#000000', casing: 0 },
    say: { lineWidth: 1, dash: [], color: '#000000', casing: 0 },
    yell: { lineWidth: 1.6, dash: [], color: 'rgb(255, 222, 0)', casing: 3.6 },
  },
  /** A yell's teeth stand out from the body, tall and short in turn, one every `toothWidth` pixels along an edge. */
  burst: { toothWidth: 6, major: 5, minor: 2.5 },
} as const;

/** The sides of a balloon in the order its outline walks them: each edge runs from one corner to the next, clockwise. */
const BALLOON_SIDES = ['up', 'right', 'down', 'left'] as const;
/** The side a balloon's tail points to: down onto the spot it hangs over, or toward the voice from a bubble placed away from it. */
export type BubbleTail = (typeof BALLOON_SIDES)[number];

export const NAME_PLAQUE = {
  fontSize: 11,
  playerBackground: 'rgb(221, 221, 221)',
  npcBackground: 'rgb(204, 255, 255)',
  /** The plaque of an entity whose health has left the top quarter, by the band it stands in. */
  conditionBackground: { wounded: 'rgb(242, 217, 78)', hurt: 'rgb(242, 154, 58)', failing: 'rgb(229, 83, 61)', fallen: 'rgb(51, 51, 51)' },
  ink: 'rgb(0, 0, 0)',
  /** Text on the dark plaque of a fallen body. */
  fallenInk: 'rgb(255, 255, 255)',
} as const;

export interface RasterArt {
  canvas: HTMLCanvasElement;
  /** Footprint in overlay pixels; the scene scales it into world metres. */
  widthPixels: number;
  heightPixels: number;
}

/** How far past the body the outline reaches on a side: the tail on its own side, and a yell's teeth everywhere. */
function frameMargin(side: BubbleTail, tail: BubbleTail, kind: SpeechKind): number {
  if (side === tail) return SPEECH_BUBBLE.tailHeight;
  return kind === 'yell' ? SPEECH_BUBBLE.burst.major : 0;
}

/** The body, plus the tail on the side it points to and the teeth of a yell. */
export function speechBubbleFrameSize(lineCount: number, tail: BubbleTail, kind: SpeechKind): { width: number; height: number } {
  return {
    width: SPEECH_BUBBLE.widthPixels + frameMargin('left', tail, kind) + frameMargin('right', tail, kind),
    height: Math.max(lineCount, 1) * SPEECH_BUBBLE.lineHeight + 2 * SPEECH_BUBBLE.bodyPadding + frameMargin('up', tail, kind) + frameMargin('down', tail, kind),
  };
}

/** A supersampled canvas whose drawing context works in overlay-pixel units. */
function rasterCanvas(
  widthPixels: number,
  heightPixels: number,
): {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D | null;
} {
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(widthPixels * OVERLAY_RASTER_SCALE);
  canvas.height = Math.ceil(heightPixels * OVERLAY_RASTER_SCALE);
  const context = canvas.getContext('2d');
  context?.scale(OVERLAY_RASTER_SCALE, OVERLAY_RASTER_SCALE);
  return { canvas, context };
}

/**
 * How far inside the body the tail's triangle is taken to start. Only its part outside the body is
 * walked, so the mouth is the triangle's width where it crosses the body's edge.
 */
const TAIL_BODY_TUCK = 1.5;

/** The corners of the body, clockwise from the top left, and the tip of the tail on each side. */
function balloonFrame(width: number, height: number, tail: BubbleTail, kind: SpeechKind, inset: number) {
  const left = inset + frameMargin('left', tail, kind);
  const right = width - inset - frameMargin('right', tail, kind);
  const top = inset + frameMargin('up', tail, kind);
  const bottom = height - inset - frameMargin('down', tail, kind);
  return {
    body: { left, top, right, bottom },
    corners: [
      { x: left, y: top },
      { x: right, y: top },
      { x: right, y: bottom },
      { x: left, y: bottom },
    ],
    tips: {
      up: { x: (left + right) / 2, y: inset },
      right: { x: width - inset, y: (top + bottom) / 2 },
      down: { x: (left + right) / 2, y: height - inset },
      left: { x: inset, y: (top + bottom) / 2 },
    },
  };
}

/**
 * Body plus tail as **one** outline, inset half a stroke so the border survives the bitmap edge.
 *
 * Authored as a single traversal rather than a body plus a triangle: canvas has no boolean path
 * union, so two subpaths would stroke the body edge across the tail mouth and the balloon would
 * read as a rectangle with a separate pennant hanging off it. Walking the union directly needs no
 * boolean. A said or whispered balloon has rounded corners; a yell's bursts into teeth instead.
 */
function balloonPath(width: number, height: number, tail: BubbleTail, kind: SpeechKind, inset: number): Path2D {
  const { corners, tips } = balloonFrame(width, height, tail, kind, inset);
  const bursting = kind === 'yell';
  const radius = bursting ? 0 : SPEECH_BUBBLE.cornerRadius;
  const mouthHalf = SPEECH_BUBBLE.tailHalfBase * (1 - TAIL_BODY_TUCK / (SPEECH_BUBBLE.tailHeight + TAIL_BODY_TUCK));
  const path = new Path2D();
  BALLOON_SIDES.forEach((side, index) => {
    const from = corners[index]!;
    const to = corners[(index + 1) % corners.length]!;
    const after = corners[(index + 2) % corners.length]!;
    const along = { x: Math.sign(to.x - from.x), y: Math.sign(to.y - from.y) };
    const onward = { x: Math.sign(after.x - to.x), y: Math.sign(after.y - to.y) };
    const tip = side === tail ? tips[side] : undefined;
    if (bursting) {
      burstEdge(path, from, to, along, index === 0, tip === undefined ? undefined : { tip, mouthHalf });
      return;
    }
    const start = { x: from.x + along.x * radius, y: from.y + along.y * radius };
    if (index === 0) path.moveTo(start.x, start.y);
    if (tip !== undefined) {
      const middle = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
      path.lineTo(middle.x - along.x * mouthHalf, middle.y - along.y * mouthHalf);
      path.lineTo(tip.x, tip.y);
      path.lineTo(middle.x + along.x * mouthHalf, middle.y + along.y * mouthHalf);
    }
    path.lineTo(to.x - along.x * radius, to.y - along.y * radius);
    path.arcTo(to.x, to.y, to.x + onward.x * radius, to.y + onward.y * radius, radius);
  });
  path.closePath();
  return path;
}

/**
 * One edge of a yell's burst, starting with a tall tooth pointing diagonally out of its corner. Each
 * edge is cut into a multiple of four steps, so the tall-short rhythm meets every corner on a tall
 * tooth. On the tail's edge the tail takes the place of the teeth at its mouth.
 */
function burstEdge(
  path: Path2D,
  from: { x: number; y: number },
  to: { x: number; y: number },
  along: { x: number; y: number },
  first: boolean,
  tail: { tip: { x: number; y: number }; mouthHalf: number } | undefined,
): void {
  const { toothWidth, major, minor } = SPEECH_BUBBLE.burst;
  const out = { x: along.y, y: -along.x };
  const corner = major / Math.SQRT2;
  const peak = { x: from.x + (out.x - along.x) * corner, y: from.y + (out.y - along.y) * corner };
  if (first) path.moveTo(peak.x, peak.y);
  else path.lineTo(peak.x, peak.y);
  const length = Math.hypot(to.x - from.x, to.y - from.y);
  const segments = Math.max(4, 4 * Math.round(length / (2 * toothWidth)));
  const at = (distance: number, height: number) => ({ x: from.x + along.x * distance + out.x * height, y: from.y + along.y * distance + out.y * height });
  let tailDrawn = false;
  for (let index = 1; index < segments; index += 1) {
    const distance = (length * index) / segments;
    if (tail !== undefined && Math.abs(distance - length / 2) < tail.mouthHalf + toothWidth / 2) {
      if (tailDrawn) continue;
      tailDrawn = true;
      for (const point of [at(length / 2 - tail.mouthHalf, 0), tail.tip, at(length / 2 + tail.mouthHalf, 0)]) path.lineTo(point.x, point.y);
      continue;
    }
    const point = at(distance, index % 2 === 1 ? 0 : index % 4 === 0 ? major : minor);
    path.lineTo(point.x, point.y);
  }
}

/**
 * The comic balloon: white body, an outline by kind, centred black text, its tail on `tail`.
 *
 * Drawn as a transparent-background path fill: a canvas texture carries its own alpha, so the
 * silhouette and the artwork are one pass with no separate opacity mask.
 */
export function renderSpeechBubble(lines: readonly string[], tail: BubbleTail, kind: SpeechKind): RasterArt {
  const { width, height } = speechBubbleFrameSize(lines.length, tail, kind);
  const { canvas, context } = rasterCanvas(width, height);
  if (context !== null) {
    const outline = SPEECH_BUBBLE.outline[kind];
    const inset = Math.max(outline.lineWidth, outline.casing) / 2;
    const balloon = balloonPath(width, height, tail, kind, inset);
    context.fillStyle = '#ffffff';
    context.fill(balloon);
    context.lineJoin = 'round';
    context.setLineDash([...outline.dash]);
    if (outline.casing > 0) {
      context.strokeStyle = '#000000';
      context.lineWidth = outline.casing;
      context.stroke(balloon);
    }
    context.strokeStyle = outline.color;
    context.lineWidth = outline.lineWidth;
    context.stroke(balloon);
    context.setLineDash([]);
    const { body } = balloonFrame(width, height, tail, kind, 0);
    context.fillStyle = '#000000';
    context.font = `${SPEECH_BUBBLE.fontSize}px system-ui, sans-serif`;
    context.textBaseline = 'alphabetic';
    context.textAlign = 'center';
    lines.forEach((line, index) => {
      const boxTop = body.top + SPEECH_BUBBLE.bodyPadding + index * SPEECH_BUBBLE.lineHeight;
      context.fillText(line, (body.left + body.right) / 2, baselineBelowBoxTop(boxTop, SPEECH_BUBBLE.fontSize), BUBBLE_TEXT_WIDTH);
    });
  }
  return { canvas, widthPixels: width, heightPixels: height };
}

/**
 * The name label under a player or NPC: black text on a filled box with a 1px black border.
 *
 * The name is byte-clamped before measuring, so a hostile server cannot drive an enormous
 * supersampled bitmap off a pathological nickname.
 */
export function renderNamePlaque(name: string, background: string, bold: boolean, ink: string = NAME_PLAQUE.ink): RasterArt {
  // `maxRenderedNameUTF8Bytes` is the protocol's identifier cap, which honest servers already
  // enforce at registration; the clamp is what stops a hostile one driving a giant bitmap.
  const clamped = truncateToUTF8Bytes(name, PROTOCOL_BYTE_CAPS.identifier);
  const font = `${bold ? 'bold ' : ''}${NAME_PLAQUE.fontSize}px system-ui, sans-serif`;
  const textWidth = measureTextWidth(clamped, font);
  // The box is sized from the recorded line box rather than the glyph extent. Reading
  // `fontBoundingBoxDescent` here lands 1px short, and the box being a pixel shallower leaves
  // the centred text riding half a pixel high.
  const width = Math.max(Math.ceil(textWidth + 6), 1);
  const height = Math.max(Math.ceil(lineBoxHeight(NAME_PLAQUE.fontSize) + 4), 1);
  const { canvas, context } = rasterCanvas(width, height);
  if (context !== null) {
    context.fillStyle = background;
    context.fillRect(0, 0, width, height);
    context.strokeStyle = '#000000';
    context.lineWidth = 1;
    context.strokeRect(0.5, 0.5, width - 1, height - 1);
    context.fillStyle = ink;
    context.font = font;
    context.textBaseline = 'alphabetic';
    context.textAlign = 'center';
    context.fillText(clamped, width / 2, baselineInCenteredBox(height, NAME_PLAQUE.fontSize));
  }
  return { canvas, widthPixels: width, heightPixels: height };
}

/** Shared measuring canvas: creating one per plaque would allocate a context per name change. */
let measuringContext: CanvasRenderingContext2D | null | undefined;

function measuringContextFor(font: string): CanvasRenderingContext2D | null {
  if (measuringContext === undefined) {
    measuringContext = document.createElement('canvas').getContext('2d');
  }
  if (measuringContext !== null) measuringContext.font = font;
  return measuringContext;
}

function measureTextWidth(text: string, font: string): number {
  const context = measuringContextFor(font);
  if (context === null) return text.length * NAME_PLAQUE.fontSize * 0.6;
  return context.measureText(text).width;
}

/**
 * The line box for the system font, recorded rather than read from canvas. Both numbers were
 * measured from rasterized ink rows at sizes 8 through 13, and no formula derives them.
 *
 * - The baseline sits exactly `fontSize` below the line-box top. Chrome's `fontBoundingBoxAscent`
 *   reports the same value. Stating it here makes every engine agree rather than trusting each
 *   one's metric selection.
 * - The line box extends **3px** below that baseline, where `fontBoundingBoxDescent` reports 2.
 *   There is nothing in canvas to derive the extra pixel from.
 */
const LINE_BOX = { descentBelowBaseline: 3 } as const;

/** Baseline offset below a line box's top edge. */
function lineBoxBaselineOffset(fontSize: number): number {
  return fontSize;
}

/** The line-box height the plaque sizes its box from. */
export function lineBoxHeight(fontSize: number): number {
  return fontSize + LINE_BOX.descentBelowBaseline;
}

/**
 * Baseline for a line box whose top edge sits at `boxTop`.
 *
 * A bubble line is positioned by the top of its **line box**, not of its glyphs. Canvas
 * `textBaseline: 'top'` measures from the top of the em box instead — short by the font's
 * internal leading — which would draw every bubble line high.
 */
export function baselineBelowBoxTop(boxTop: number, fontSize: number): number {
  return boxTop + lineBoxBaselineOffset(fontSize);
}

/**
 * Baseline for a line box centred in `height`, which is what the plaque's
 * `(size.height - textSize.height) / 2` origin produces.
 *
 * Not canvas `textBaseline: 'middle'` at `height / 2`: that centres the em box, leaving the text low
 * by half the difference between the two boxes.
 */
export function baselineInCenteredBox(height: number, fontSize: number): number {
  return (height - lineBoxHeight(fontSize)) / 2 + lineBoxBaselineOffset(fontSize);
}

/**
 * Background for an entity's plaque, or `undefined` for one that gets none. A player's plaque is
 * tinted by their condition, the local player's included. An NPC's never changes. A nightmare has
 * a plaque only while it is not hale, so a wounded one stands out from the rest.
 */
export function namePlaqueBackground(kind: WorldEntityKind, condition: Condition): string | undefined {
  if (kind === 'npc') return NAME_PLAQUE.npcBackground;
  if (condition !== 'hale') return NAME_PLAQUE.conditionBackground[condition];
  return kind === 'monster' ? undefined : NAME_PLAQUE.playerBackground;
}
