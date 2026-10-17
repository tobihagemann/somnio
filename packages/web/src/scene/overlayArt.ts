import { SOMNIO_CONSTANTS, clamp } from '@somnio/core';
import type { WorldEntityKind } from '@somnio/core';
import { PROTOCOL_BYTE_CAPS, truncateToUTF8Bytes } from '@somnio/protocol';
import type { Condition, SpeechKind } from '@somnio/protocol';
import { BUBBLE_FONT, BUBBLE_TEXT_INSET, BUBBLE_TEXT_WIDTH } from './speechBubbleText';

/**
 * The speech bubble and name plaque, drawn in a top-left-origin overlay-pixel space. The plaque is
 * rasterized on a canvas supersampled by 8, and the bubble is painted on the bubble layer each
 * frame. Every coordinate is authored in that space, and the text baseline is the one that needs
 * care. The bubble and plaque are laid out from the top of the **line box** (ascent + descent +
 * leading), while canvas `textBaseline: 'top'` and `'middle'` work from the **em box**. The two
 * differ by the font's internal leading, which would put every bubble line and every plaque a pixel
 * or two off vertically, so both compute an explicit alphabetic baseline from the recorded line box.
 */

/** Texture pixels per overlay pixel. */
const OVERLAY_RASTER_SCALE = 8;

/** World metres per pixel of overlay artwork. */
export const OVERLAY_METRES_PER_PIXEL = 0.016;

const SPEECH_BUBBLE = {
  widthPixels: SOMNIO_CONSTANTS.speechBubbleWidthPixels,
  fontSize: SOMNIO_CONSTANTS.speechBubbleFontSize,
  lineHeight: 12,
  /** Half the stretch of the body's edge a tail leaves from. */
  tailHalfMouth: 6,
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

export const NAME_PLAQUE = {
  fontSize: 11,
  backgroundOpacity: 0.85,
  playerBackground: 'rgb(221, 221, 221)',
  npcBackground: 'rgb(204, 255, 255)',
  /** The plaque of an entity below its maximum health, by the band it stands in. */
  conditionBackground: {
    grazed: 'rgb(126, 201, 92)',
    wounded: 'rgb(242, 217, 78)',
    hurt: 'rgb(242, 154, 58)',
    failing: 'rgb(229, 83, 61)',
    fallen: 'rgb(51, 51, 51)',
  },
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

/** A point in overlay pixels from a bubble's top-left corner, `y` down. */
export interface OverlayPoint {
  x: number;
  y: number;
}

/** How far a yell's teeth stand out past the body on every side. */
function frameMargin(kind: SpeechKind): number {
  return kind === 'yell' ? SPEECH_BUBBLE.burst.major : 0;
}

/**
 * The body and the teeth of a yell. The body is as wide as its widest line with the text's inset on
 * either side. It is never narrower than three corner radii, which leaves a stretch of edge between
 * the corners for a tail to leave from, and never wider than a full line.
 */
export function speechBubbleFrameSize(lines: readonly string[], kind: SpeechKind): { width: number; height: number } {
  const widest = Math.max(0, ...lines.map((line) => measureTextWidth(line, BUBBLE_FONT)));
  const body = clamp(widest + 2 * BUBBLE_TEXT_INSET, 3 * SPEECH_BUBBLE.cornerRadius, SPEECH_BUBBLE.widthPixels);
  return {
    width: body + 2 * frameMargin(kind),
    height: Math.max(lines.length, 1) * SPEECH_BUBBLE.lineHeight + 2 * SPEECH_BUBBLE.bodyPadding + 2 * frameMargin(kind),
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

/** The corners of the body, clockwise from the top left. */
function balloonFrame(width: number, height: number, kind: SpeechKind, inset: number) {
  const left = inset + frameMargin(kind);
  const right = width - inset - frameMargin(kind);
  const top = inset + frameMargin(kind);
  const bottom = height - inset - frameMargin(kind);
  return {
    body: { left, top, right, bottom },
    corners: [
      { x: left, y: top },
      { x: right, y: top },
      { x: right, y: bottom },
      { x: left, y: bottom },
    ],
  };
}

/** Where a tail leaves the body. */
interface TailMouth {
  /** The edge it leaves, as an index in the order the outline walks them: top, right, bottom, left. */
  edge: number;
  /** The stretch of that edge it takes, measured from where the walk enters the edge and kept off the corners. */
  from: number;
  to: number;
  tip: OverlayPoint;
}

/**
 * `undefined` for a tip on or inside the body, which has no tail to draw. The edge is the one the
 * line from the middle to the tip crosses on the whole frame, which is how the layout's `tailTip`
 * picks the edge it points a tail straight out of. A yell's teeth make the body inside the frame
 * squatter, so judged on the body the tail would leave a neighbouring edge and bend.
 */
function tailMouth(width: number, height: number, kind: SpeechKind, tip: OverlayPoint): TailMouth | undefined {
  const { body } = balloonFrame(width, height, kind, outlineInset(kind));
  const half = { x: (body.right - body.left) / 2, y: (body.bottom - body.top) / 2 };
  const dx = tip.x - width / 2;
  const dy = tip.y - height / 2;
  if (Math.abs(dx) <= half.x && Math.abs(dy) <= half.y) return undefined;
  const crossesSide = Math.abs(dx) * height >= Math.abs(dy) * width;
  const edge = crossesSide ? (dx > 0 ? 1 : 3) : dy < 0 ? 0 : 2;
  const length = crossesSide ? 2 * half.y : 2 * half.x;
  const across = crossesSide ? (dy * half.x) / Math.abs(dx) : (dx * half.y) / Math.abs(dy);
  const crossing = half[crossesSide ? 'y' : 'x'] + (edge === 0 || edge === 1 ? across : -across);
  const corner = kind === 'yell' ? SPEECH_BUBBLE.burst.toothWidth : SPEECH_BUBBLE.cornerRadius;
  const mouth = Math.min(SPEECH_BUBBLE.tailHalfMouth, length / 2 - corner);
  if (mouth <= 0) return undefined;
  const middle = clamp(crossing, corner + mouth, length - corner - mouth);
  return { edge, from: middle - mouth, to: middle + mouth, tip };
}

/**
 * The body's outline and its tail as **one** path, inset half a stroke so the border survives the
 * frame's edge. Canvas has no union of paths, and a tail stroked on its own meets the body's
 * outline as two cut-off lines that never quite join; walking the union directly needs no union.
 * A said or whispered balloon has rounded corners; a yell's bursts into teeth instead.
 */
function balloonPath(width: number, height: number, kind: SpeechKind, mouth: TailMouth | undefined): Path2D {
  const { corners } = balloonFrame(width, height, kind, outlineInset(kind));
  const bursting = kind === 'yell';
  const radius = bursting ? 0 : SPEECH_BUBBLE.cornerRadius;
  const path = new Path2D();
  corners.forEach((from, index) => {
    const to = corners[(index + 1) % corners.length]!;
    const after = corners[(index + 2) % corners.length]!;
    const along = { x: Math.sign(to.x - from.x), y: Math.sign(to.y - from.y) };
    const onward = { x: Math.sign(after.x - to.x), y: Math.sign(after.y - to.y) };
    const edgeMouth = mouth?.edge === index ? mouth : undefined;
    if (bursting) {
      burstEdge(path, from, to, along, index === 0, edgeMouth);
      return;
    }
    if (index === 0) path.moveTo(from.x + along.x * radius, from.y + along.y * radius);
    if (edgeMouth !== undefined) {
      path.lineTo(from.x + along.x * edgeMouth.from, from.y + along.y * edgeMouth.from);
      path.lineTo(edgeMouth.tip.x, edgeMouth.tip.y);
      path.lineTo(from.x + along.x * edgeMouth.to, from.y + along.y * edgeMouth.to);
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
 * tooth. Where the tail leaves the edge, the tail takes the place of the teeth.
 */
function burstEdge(
  path: Path2D,
  from: { x: number; y: number },
  to: { x: number; y: number },
  along: { x: number; y: number },
  first: boolean,
  mouth: TailMouth | undefined,
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
  let mouthDrawn = mouth === undefined;
  const drawMouth = (): void => {
    if (mouthDrawn || mouth === undefined) return;
    mouthDrawn = true;
    for (const point of [at(mouth.from, 0), mouth.tip, at(mouth.to, 0)]) path.lineTo(point.x, point.y);
  };
  for (let index = 1; index < segments; index += 1) {
    const distance = (length * index) / segments;
    if (mouth !== undefined && distance > mouth.from - toothWidth / 2) {
      drawMouth();
      if (distance < mouth.to + toothWidth / 2) continue;
    }
    const point = at(distance, index % 2 === 1 ? 0 : index % 4 === 0 ? major : minor);
    path.lineTo(point.x, point.y);
  }
  drawMouth();
}

function strokeOutline(context: CanvasRenderingContext2D, path: Path2D, kind: SpeechKind): void {
  const outline = SPEECH_BUBBLE.outline[kind];
  context.lineJoin = 'round';
  context.setLineDash([...outline.dash]);
  if (outline.casing > 0) {
    context.strokeStyle = '#000000';
    context.lineWidth = outline.casing;
    context.stroke(path);
  }
  context.strokeStyle = outline.color;
  context.lineWidth = outline.lineWidth;
  context.stroke(path);
  context.setLineDash([]);
}

/** How far the outline is drawn inside the frame, so a stroke survives the frame's edge. */
function outlineInset(kind: SpeechKind): number {
  const outline = SPEECH_BUBBLE.outline[kind];
  return Math.max(outline.lineWidth, outline.casing) / 2;
}

/**
 * The comic balloon, with its frame's top-left corner at the context's origin, in overlay pixels:
 * white, outlined by kind as one shape with its tail ending at `tail`, and centred black text inside
 * it. All but the tail lies inside the frame.
 */
export function paintSpeechBubble(context: CanvasRenderingContext2D, lines: readonly string[], kind: SpeechKind, tail: OverlayPoint | undefined): void {
  const { width, height } = speechBubbleFrameSize(lines, kind);
  const balloon = balloonPath(width, height, kind, tail === undefined ? undefined : tailMouth(width, height, kind, tail));
  context.fillStyle = '#ffffff';
  context.fill(balloon);
  strokeOutline(context, balloon, kind);
  const { body } = balloonFrame(width, height, kind, 0);
  // Marks stacked on a letter can reach far past its line; they end at the balloon's edge.
  context.save();
  context.clip(balloon);
  context.fillStyle = '#000000';
  context.font = BUBBLE_FONT;
  context.textBaseline = 'alphabetic';
  context.textAlign = 'center';
  lines.forEach((line, index) => {
    const boxTop = body.top + SPEECH_BUBBLE.bodyPadding + index * SPEECH_BUBBLE.lineHeight;
    context.fillText(line, (body.left + body.right) / 2, baselineBelowBoxTop(boxTop, SPEECH_BUBBLE.fontSize), BUBBLE_TEXT_WIDTH);
  });
  context.restore();
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
    // Only the fill is translucent, so the ring round the feet shows through the plaque while its name and border stay solid.
    context.globalAlpha = NAME_PLAQUE.backgroundOpacity;
    context.fillStyle = background;
    context.fillRect(0, 0, width, height);
    context.globalAlpha = 1;
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
 * a plaque only while it is not hale or the pointer is over it, so one that has taken harm stands
 * out from the rest.
 */
export function namePlaqueBackground(kind: WorldEntityKind, condition: Condition, hovered: boolean): string | undefined {
  if (kind === 'npc') return NAME_PLAQUE.npcBackground;
  if (condition !== 'hale') return NAME_PLAQUE.conditionBackground[condition];
  return kind === 'monster' && !hovered ? undefined : NAME_PLAQUE.playerBackground;
}
