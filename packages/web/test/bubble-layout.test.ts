import { describe, expect, it } from 'vitest';
import { layoutBubbles, tailTip } from '@/scene/bubbleLayout';
import type { BubbleLayoutInput, BubblePlacement, BubbleRequest, ScreenDisc, ScreenPoint, ScreenRect, ScreenSize } from '@/scene/bubbleLayout';

/** A bubble's body, in metres on the screen. */
const SIZE: ScreenSize = { width: 1.2, height: 0.4 };
const HEAD_RADIUS = 0.15;
/** The layout's own distances: the smallest gap from an anchor's rim, how far every bubble keeps inside the screen's edge, and how far a pinned or fixed bubble's tail reaches out. */
const RIM_GAP = 0.14;
const INSET = 0.06;
const TAIL_LENGTH = 0.16;

function head(x: number, y: number, radius = HEAD_RADIUS): ScreenDisc {
  return { centre: { x, y }, radius };
}

function bubble(overrides: Partial<BubbleRequest> = {}): BubbleRequest {
  return { size: SIZE, anchor: undefined, fixed: undefined, voice: { x: 0, y: 0 }, held: undefined, ...overrides };
}

function hungFrom(anchor: ScreenDisc, overrides: Partial<BubbleRequest> = {}): BubbleRequest {
  return bubble({ anchor, voice: anchor.centre, ...overrides });
}

function layout(bubbles: BubbleRequest[], overrides: Partial<BubbleLayoutInput> = {}): BubblePlacement[] {
  return layoutBubbles({ halfSize: { x: 4, y: 3 }, covered: [], heads: [], player: { x: 0, y: 0 }, bubbles, ...overrides });
}

function boxOf(centre: ScreenPoint, size: ScreenSize = SIZE): ScreenRect {
  return { left: centre.x - size.width / 2, bottom: centre.y - size.height / 2, right: centre.x + size.width / 2, top: centre.y + size.height / 2 };
}

function overlap(a: ScreenRect, b: ScreenRect): boolean {
  return a.left < b.right && b.left < a.right && a.bottom < b.top && b.bottom < a.top;
}

function touchesHead(box: ScreenRect, disc: ScreenDisc): boolean {
  const dx = Math.max(box.left - disc.centre.x, 0, disc.centre.x - box.right);
  const dy = Math.max(box.bottom - disc.centre.y, 0, disc.centre.y - box.top);
  return Math.hypot(dx, dy) < disc.radius;
}

/** How far a body's nearest point lies from an anchor's rim. */
function gapOf(centre: ScreenPoint, anchor: ScreenDisc, size: ScreenSize = SIZE): number {
  const box = boxOf(centre, size);
  const dx = Math.max(box.left - anchor.centre.x, 0, anchor.centre.x - box.right);
  const dy = Math.max(box.bottom - anchor.centre.y, 0, anchor.centre.y - box.top);
  return Math.hypot(dx, dy) - anchor.radius;
}

function insideInset(box: ScreenRect, half: ScreenPoint): boolean {
  const eps = 1e-9;
  return box.left >= -half.x + INSET - eps && box.right <= half.x - INSET + eps && box.bottom >= -half.y + INSET - eps && box.top <= half.y - INSET + eps;
}

describe('a bubble hung round its anchor', () => {
  it('hangs over a lone anchor, its tail on the rim straight above its centre', () => {
    const anchor = head(1, -0.5);

    const [placed] = layout([hungFrom(anchor)]);

    expect(placed!.mode).toBe('anchored');
    expect(placed!.centre.x).toBeCloseTo(1, 9);
    expect(placed!.centre.y).toBeCloseTo(-0.5 + HEAD_RADIUS + RIM_GAP + SIZE.height / 2, 9);
    const tip = tailTip(placed!.centre, SIZE, { anchor })!;
    expect(tip.x).toBeCloseTo(1, 9);
    expect(tip.y).toBeCloseTo(-0.5 + HEAD_RADIUS, 9);
  });

  it('ends the tail of a body below its anchor on the rim underneath, and draws none for a body over the anchor', () => {
    const anchor = head(0, 0);

    const tip = tailTip({ x: 0, y: -0.6 }, SIZE, { anchor })!;
    expect(tip.x).toBeCloseTo(0, 9);
    expect(tip.y).toBeCloseTo(-HEAD_RADIUS, 9);
    expect(tailTip({ x: 0.3, y: 0.1 }, SIZE, { anchor })).toBeUndefined();
  });

  /** A rule that placed each bubble alone would put every one of these over its own head, on top of each other. */
  it('keeps twenty bubbles of a crowd apart, off the corner panels and off every head', () => {
    const half = { x: 5, y: 3.5 };
    const corners: ScreenRect[] = [
      { left: -5, bottom: 1.5, right: -3, top: 3.5 },
      { left: 3, bottom: 1.5, right: 5, top: 3.5 },
      { left: -5, bottom: -3.5, right: -2.5, top: -1.5 },
      { left: 3, bottom: -3.5, right: 5, top: -1.5 },
    ];
    const heads = Array.from({ length: 20 }, (_, index) => head(-0.75 + (index % 5) * 0.375, -0.75 + Math.floor(index / 5) * 0.5));
    const sizes = heads.map((_, index) => ({ width: 0.5 + (index % 4) * 0.25, height: 0.4 + (index % 3) * 0.2 }));

    const placed = layout(
      heads.map((anchor, index) => hungFrom(anchor, { size: sizes[index]! })),
      { halfSize: half, covered: corners, heads },
    );

    const boxes = placed.map((each, index) => boxOf(each.centre, sizes[index]));
    expect(placed.every((each) => each.mode === 'anchored')).toBe(true);
    boxes.forEach((box, index) => {
      expect(insideInset(box, half)).toBe(true);
      for (const other of boxes.slice(index + 1)) expect(overlap(box, other)).toBe(false);
      for (const corner of corners) expect(overlap(box, corner)).toBe(false);
      for (const disc of heads) expect(touchesHead(box, disc)).toBe(false);
    });
  });

  it('takes the nearest spot clear of a panel over its head, nearer than the first one straight above it', () => {
    const anchor = head(0, 0);
    const panel = { left: -1, bottom: 0.25, right: 1, top: 1.5 };

    const [placed] = layout([hungFrom(anchor)], { covered: [panel] });

    expect(placed!.mode).toBe('anchored');
    expect(overlap(boxOf(placed!.centre), panel)).toBe(false);
    const straightAbove = { x: 0, y: panel.top + INSET + SIZE.height / 2 };
    expect(gapOf(placed!.centre, anchor)).toBeLessThan(gapOf(straightAbove, anchor));
  });

  it('holds the spot it has while that stays free, and returns over its anchor once that is free', () => {
    const anchor = head(0, 0);
    const home = { x: 0, y: HEAD_RADIUS + RIM_GAP + SIZE.height / 2 };
    const blocker = (spot: ScreenPoint) => bubble({ fixed: spot, size: { width: 0.2, height: 0.2 } });

    const [, first] = layout([blocker(home), hungFrom(anchor)]);
    const [, , displaced] = layout([blocker(home), blocker(first!.centre), hungFrom(anchor)]);
    expect(displaced!.centre).not.toEqual(first!.centre);
    const held = { x: displaced!.centre.x - anchor.centre.x, y: displaced!.centre.y - anchor.centre.y };

    // With the second blocker gone, a bubble holding nothing takes the spot it left.
    expect(layout([blocker(home), hungFrom(anchor)])[1]!.centre).toEqual(first!.centre);
    const [, kept] = layout([blocker(home), hungFrom(anchor, { held })]);
    expect(kept!.centre).toEqual(displaced!.centre);

    const [back] = layout([hungFrom(anchor, { held })]);
    expect(back!.centre.x).toBeCloseTo(home.x, 9);
    expect(back!.centre.y).toBeCloseTo(home.y, 9);
  });

  it('finds a corridor between two panels beside its anchor', () => {
    const anchor = head(0, 0);
    const width = SIZE.width + 2 * 0.06 + 0.15;
    const covered = [
      { left: -4, bottom: -3, right: 1, top: 3 },
      { left: 1 + width, bottom: -3, right: 4, top: 3 },
    ];

    const [placed] = layout([hungFrom(anchor)], { covered });

    expect(placed!.mode).toBe('anchored');
    const box = boxOf(placed!.centre);
    expect(box.left).toBeGreaterThanOrEqual(1);
    expect(box.right).toBeLessThanOrEqual(1 + width);
  });

  it('prefers the spot whose tail passes behind no bubble between two equally near ones', () => {
    const anchor = head(0, 0, 0.1);
    const size = { width: 1.2, height: 0.8 };
    // Panels above and below the anchor leave a slot too low for the bubble beside it, so the nearest spots lie past them on either side.
    const covered = [
      { left: -0.95, bottom: 0.4, right: 0.95, top: 3 },
      { left: -0.95, bottom: -3, right: 0.95, top: -0.4 },
    ];
    const between = bubble({ fixed: { x: 0.5, y: 0 }, size: { width: 0.1, height: 0.1 } });

    const [alone] = layout([hungFrom(anchor, { size })], { covered });
    const [, beside] = layout([between, hungFrom(anchor, { size })], { covered });

    expect(alone!.centre.x).toBeGreaterThan(0);
    expect(beside!.centre.x).toBeCloseTo(-alone!.centre.x, 9);
    expect(beside!.centre.y).toBeCloseTo(alone!.centre.y, 9);
  });

  it('prefers the spot that sits on no earlier tail between two equally near ones', () => {
    const anchor = head(0, 0, 0.1);
    const size = { width: 1.2, height: 0.8 };
    // The same slot beside the anchor, and a panel over the spot above a second anchor far below it.
    const covered = [
      { left: -0.95, bottom: 0.4, right: 0.95, top: 3 },
      { left: -0.95, bottom: -3, right: 0.95, top: -0.4 },
      { left: 1.1, bottom: -1.45, right: 2.5, top: -0.9 },
    ];
    // Held high above its anchor, its tail runs down through the spot right of the first anchor.
    const earlier = hungFrom(head(1.8, -1.6, 0.1), { held: { x: 0, y: 2.8 } });

    const [alone] = layout([hungFrom(anchor, { size })], { covered });
    const [held, beside] = layout([earlier, hungFrom(anchor, { size })], { covered });

    expect(held!.centre.x).toBeCloseTo(1.8, 9);
    expect(held!.centre.y).toBeCloseTo(1.2, 9);
    expect(alone!.centre.x).toBeGreaterThan(0);
    expect(beside!.centre.x).toBeCloseTo(-alone!.centre.x, 9);
  });
});

describe('a screen with no room', () => {
  it('keeps a bubble over its anchor in a screen narrower than it, and centres a second one across the screen', () => {
    const half = { x: 0.5, y: 3 };

    const [first, second] = layout([hungFrom(head(0.2, 0)), hungFrom(head(-0.3, 0))], { halfSize: half });

    expect(first!.mode).toBe('anchored');
    expect(first!.centre.x).toBe(0);
    expect(first!.centre.y).toBeCloseTo(HEAD_RADIUS + RIM_GAP + SIZE.height / 2, 9);
    expect(second!.mode).toBe('anchored');
    expect(second!.centre.x).toBe(0);
  });

  it('never pins a bubble whose anchor is on screen, but keeps it inside the screen by its anchor', () => {
    const half = { x: 4, y: 3 };
    const everything = { left: -4, bottom: -3, right: 4, top: 3 };

    const [placed] = layout([hungFrom(head(0, 2.9))], { halfSize: half, covered: [everything] });

    expect(placed!.mode).toBe('anchored');
    expect(insideInset(boxOf(placed!.centre), half)).toBe(true);
  });

  /** A walk out through the rings that does not stop where they leave the screen never returns here. */
  it('returns when nothing is free anywhere', () => {
    const anchor = head(0, 0);

    const [placed] = layout([hungFrom(anchor)], { covered: [{ left: -4, bottom: -3, right: 4, top: 3 }] });

    expect(placed!.mode).toBe('anchored');
    expect(placed!.centre.y).toBeCloseTo(HEAD_RADIUS + RIM_GAP + SIZE.height / 2, 9);
  });

  it('overlaps a bubble over its anchor when no spot is free and nothing covers that one', () => {
    const half = { x: 0.8, y: 0.5 };

    const [first, second] = layout([hungFrom(head(0, -0.3)), hungFrom(head(0, -0.3))], { halfSize: half });

    expect(second!.mode).toBe('anchored');
    expect(second!.centre.x).toBeCloseTo(first!.centre.x, 9);
    expect(second!.centre.y).toBeCloseTo(first!.centre.y, 9);
  });

  it('overlaps a second bubble by its anchor rather than letting it leave a screen too small for both', () => {
    const half = { x: 0.8, y: 0.5 };

    const placed = layout([hungFrom(head(-0.2, -0.3)), hungFrom(head(0.2, -0.3))], { halfSize: half });

    expect(placed.map((each) => each.mode)).toEqual(['anchored', 'anchored']);
    expect(insideInset(boxOf(placed[1]!.centre), half)).toBe(true);
    expect(overlap(boxOf(placed[0]!.centre), boxOf(placed[1]!.centre))).toBe(true);
  });
});

describe('a bubble with nothing on screen to hang from', () => {
  const grown = { width: SIZE.width + 2 * TAIL_LENGTH, height: SIZE.height + 2 * TAIL_LENGTH };

  it('is pinned toward its voice, whole with its tail, stepped back off a bubble and a head on that line', () => {
    const half = { x: 4, y: 3 };
    const voice = { x: 10, y: 0 };
    const earlier = bubble({ fixed: { x: 3.1, y: 0 } });
    const inTheWay = head(1.2, 0);

    const [, placed] = layout([earlier, hungFrom(head(voice.x, voice.y))], { halfSize: half, heads: [inTheWay] });

    expect(placed!.mode).toBe('pinned');
    expect(placed!.centre.y).toBeCloseTo(0, 9);
    expect(placed!.centre.x).toBeGreaterThan(0);
    expect(insideInset(boxOf(placed!.centre, grown), half)).toBe(true);
    const tip = tailTip(placed!.centre, SIZE, { toward: voice })!;
    expect(tip.x).toBeLessThanOrEqual(half.x - INSET + 1e-9);
    expect(overlap(boxOf(placed!.centre, grown), boxOf({ x: 3.1, y: 0 }, grown))).toBe(false);
    expect(touchesHead(boxOf(placed!.centre, grown), inTheWay)).toBe(false);
  });

  /** Under a panel its text would be hidden; over a head, only the head is. */
  it('overlaps where no panel covers it when a panel and a head leave no spot free on its line', () => {
    const panel = { left: -4, bottom: -3, right: -2, top: 3 };
    const near = head(-0.6, 0);

    const [placed] = layout([bubble({ voice: { x: -20, y: 0 } })], { covered: [panel], heads: [near] });

    const box = boxOf(placed!.centre, grown);
    expect(placed!.mode).toBe('pinned');
    expect(placed!.centre.y).toBeCloseTo(0, 9);
    expect(box.left).toBeGreaterThanOrEqual(panel.right + 0.06);
    // The first such spot from the edge, not one further on toward the player.
    expect(box.left).toBeLessThan(panel.right + 0.06 + 0.1);
    expect(touchesHead(box, near)).toBe(true);
  });

  /** Walked in steps that stop short of the line's end, the one spot no panel covers is never tried. */
  it("overlaps at the player's own spot when a panel covers the rest of its line", () => {
    const size = { width: 1, height: 0.35 };
    const panel = { left: -4, bottom: -3, right: -0.74, top: 3 };
    const own = head(0, 0, 0.2);

    const [placed] = layout([bubble({ size, voice: { x: -20, y: 0 } })], { covered: [panel], heads: [own] });

    expect(placed!.mode).toBe('pinned');
    expect(placed!.centre.x).toBeCloseTo(0, 9);
    expect(placed!.centre.y).toBeCloseTo(0, 9);
  });

  it('stays where the line toward its voice leaves the screen when a panel covers all of that line', () => {
    const [placed] = layout([bubble({ voice: { x: 10, y: 0 } })], { covered: [{ left: -4, bottom: -1, right: 4, top: 1 }] });

    expect(placed!.mode).toBe('pinned');
    expect(placed!.centre.x).toBeCloseTo(4 - INSET - grown.width / 2, 9);
    expect(placed!.centre.y).toBeCloseTo(0, 9);
  });

  /** Its fixed spot would leave it cut by the screen's edge; pinned, it is centred across the screen. */
  it('is pinned, not left at its fixed spot, in a screen narrower than it', () => {
    const [placed] = layout([bubble({ fixed: { x: 0.2, y: 1 }, voice: { x: 0, y: 5 } })], { halfSize: { x: 0.5, y: 3 } });

    expect(placed!.mode).toBe('pinned');
    expect(placed!.centre.x).toBe(0);
  });

  it('takes a fixed spot that is free, and is pinned when that spot is off screen', () => {
    const [onScreen, offScreen] = layout([bubble({ fixed: { x: 1, y: 1 } }), bubble({ fixed: { x: 4.5, y: 0 }, voice: { x: 9, y: 0 } })]);

    expect(onScreen!.mode).toBe('fixed');
    expect(onScreen!.centre).toEqual({ x: 1, y: 1 });
    expect(offScreen!.mode).toBe('pinned');
  });
});
