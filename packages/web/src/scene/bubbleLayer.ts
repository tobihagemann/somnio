import type { SpeechKind } from '@somnio/protocol';
import type { BubbleMode, ScreenPoint, ScreenSize } from './bubbleLayout';
import { OVERLAY_METRES_PER_PIXEL, paintSpeechBubble } from './overlayArt';
import type { OverlayPoint } from './overlayArt';

/** A speech bubble as the scene placed it, in metres on the screen, `x` right and `y` up from its middle. */
export interface PlacedBubble {
  centre: ScreenPoint;
  size: ScreenSize;
  /** Where its tail ends; `undefined` draws none. */
  tail: ScreenPoint | undefined;
  lines: readonly string[];
  kind: SpeechKind;
  opacity: number;
  mode: BubbleMode;
}

export interface PlacedBubbles {
  /** Half the screen's width and height. */
  halfSize: ScreenPoint;
  /** In the order they were placed. */
  bubbles: readonly PlacedBubble[];
}

/** How far, in overlay pixels, an outline's stroke and its round join reach past the tail's tip. */
const STROKE_REACH = 4;

/** A rect of whole canvas pixels. */
interface PixelRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Paints the bubbles on the layer over the world. Each bubble is painted opaque on `scratch`, a
 * canvas kept as large as the layer, and copied onto the layer at its opacity. So a faint bubble
 * fades as one picture, rather than its fill, outline, and text each showing the one under it
 * through.
 *
 * Each is copied through two complementary clips on its frame. First every bubble's tail is copied,
 * which is all that lies outside its frame. Then every bubble's frame is copied. So a tail may pass
 * behind another bubble but never through its text. The clips fall on whole canvas pixels, so the
 * two halves of one bubble meet exactly and no pixel is copied twice.
 */
export function paintBubbles(
  context: CanvasRenderingContext2D | null,
  scratch: CanvasRenderingContext2D | null,
  placed: PlacedBubbles,
  pixelSize: { width: number; height: number },
): void {
  if (context === null) return;
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, pixelSize.width, pixelSize.height);
  const { halfSize } = placed;
  if (scratch === null || halfSize.x <= 0 || halfSize.y <= 0) return;
  if (scratch.canvas.width !== pixelSize.width || scratch.canvas.height !== pixelSize.height) {
    scratch.canvas.width = pixelSize.width;
    scratch.canvas.height = pixelSize.height;
  }
  const perMetre = { x: pixelSize.width / (2 * halfSize.x), y: pixelSize.height / (2 * halfSize.y) };
  const topLeft = (bubble: PlacedBubble): ScreenPoint => ({ x: bubble.centre.x - bubble.size.width / 2, y: bubble.centre.y + bubble.size.height / 2 });
  /** The rect from `from` to `to`, in metres on the screen, grown out to whole canvas pixels. */
  const pixelRect = (from: ScreenPoint, to: ScreenPoint): PixelRect => ({
    left: Math.floor((Math.min(from.x, to.x) + halfSize.x) * perMetre.x),
    top: Math.floor((halfSize.y - Math.max(from.y, to.y)) * perMetre.y),
    right: Math.ceil((Math.max(from.x, to.x) + halfSize.x) * perMetre.x),
    bottom: Math.ceil((halfSize.y - Math.min(from.y, to.y)) * perMetre.y),
  });
  const frameOf = (bubble: PlacedBubble): PixelRect => {
    const corner = topLeft(bubble);
    return pixelRect(corner, { x: corner.x + bubble.size.width, y: corner.y - bubble.size.height });
  };
  /** Everything the bubble paints: its frame, and its tail with the outline's reach past the tip. */
  const extentOf = (bubble: PlacedBubble): PixelRect => {
    const corner = topLeft(bubble);
    const reach = STROKE_REACH * OVERLAY_METRES_PER_PIXEL;
    const tail = bubble.tail ?? bubble.centre;
    const from = { x: Math.min(corner.x, tail.x - reach), y: Math.max(corner.y, tail.y + reach) };
    const to = { x: Math.max(corner.x + bubble.size.width, tail.x + reach), y: Math.min(corner.y - bubble.size.height, tail.y - reach) };
    const extent = pixelRect(from, to);
    return {
      left: Math.max(extent.left, 0),
      top: Math.max(extent.top, 0),
      right: Math.min(extent.right, pixelSize.width),
      bottom: Math.min(extent.bottom, pixelSize.height),
    };
  };
  const tailOf = (bubble: PlacedBubble): OverlayPoint | undefined => {
    if (bubble.tail === undefined) return undefined;
    const corner = topLeft(bubble);
    return { x: (bubble.tail.x - corner.x) / OVERLAY_METRES_PER_PIXEL, y: (corner.y - bubble.tail.y) / OVERLAY_METRES_PER_PIXEL };
  };
  /** Paints the bubble opaque on the scratch canvas, then copies it onto the layer through `clip`, set in canvas pixels. */
  const copyThrough = (bubble: PlacedBubble, clip: Path2D, rule: CanvasFillRule): void => {
    const extent = extentOf(bubble);
    const width = extent.right - extent.left;
    const height = extent.bottom - extent.top;
    if (width <= 0 || height <= 0) return;
    const corner = topLeft(bubble);
    scratch.setTransform(1, 0, 0, 1, 0, 0);
    scratch.clearRect(extent.left, extent.top, width, height);
    // Overlay pixels to canvas pixels, with the frame's top-left corner at the origin.
    scratch.setTransform(
      perMetre.x * OVERLAY_METRES_PER_PIXEL,
      0,
      0,
      perMetre.y * OVERLAY_METRES_PER_PIXEL,
      (corner.x + halfSize.x) * perMetre.x,
      (halfSize.y - corner.y) * perMetre.y,
    );
    paintSpeechBubble(scratch, bubble.lines, bubble.kind, tailOf(bubble));
    context.save();
    context.clip(clip, rule);
    context.globalAlpha = bubble.opacity;
    context.drawImage(scratch.canvas, extent.left, extent.top, width, height, extent.left, extent.top, width, height);
    context.restore();
  };
  const frameClip = (bubble: PlacedBubble, path: Path2D): Path2D => {
    const frame = frameOf(bubble);
    path.rect(frame.left, frame.top, frame.right - frame.left, frame.bottom - frame.top);
    return path;
  };
  for (const bubble of placed.bubbles) {
    if (bubble.tail === undefined) continue;
    const outside = new Path2D();
    outside.rect(0, 0, pixelSize.width, pixelSize.height);
    copyThrough(bubble, frameClip(bubble, outside), 'evenodd');
  }
  for (const bubble of placed.bubbles) copyThrough(bubble, frameClip(bubble, new Path2D()), 'nonzero');
}
