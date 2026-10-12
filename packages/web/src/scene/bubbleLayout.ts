import { clamp } from '@somnio/core';

/**
 * Where each speech bubble goes on the screen, all of them at once, so that they keep apart.
 *
 * Everything is in metres on the screen, `x` right and `y` up from its middle. A bubble whose anchor
 * is on screen goes straight above it when that spot is free. Otherwise it keeps the spot it already
 * has while that stays free, and failing that takes the nearest free spot round the anchor, leaning
 * toward above. A bubble with nothing on screen to hang from takes the fixed spot it was given, when
 * it has one and that is free. Otherwise it is pinned on the line from the player toward its voice,
 * as near the screen's edge as is free. A bubble's size is all it draws but its tail: a yell's teeth
 * belong to it.
 */

export interface ScreenPoint {
  x: number;
  y: number;
}

export interface ScreenSize {
  width: number;
  height: number;
}

export interface ScreenRect {
  left: number;
  bottom: number;
  right: number;
  top: number;
}

/** A head as a circle, or a doorway spot with no radius. */
export interface ScreenDisc {
  centre: ScreenPoint;
  radius: number;
}

/** Hung round its anchor, at a spot given for it (a voice past a room's wall), or pinned toward its voice. */
export type BubbleMode = 'anchored' | 'fixed' | 'pinned';

export interface BubbleRequest {
  size: ScreenSize;
  anchor: ScreenDisc | undefined;
  fixed: ScreenPoint | undefined;
  /** Where the voice comes from, which a pinned bubble is put toward. */
  voice: ScreenPoint;
  /** The offset from its anchor's centre the bubble held last tick, while hung round that same anchor. */
  held: ScreenPoint | undefined;
}

export interface BubbleLayoutInput {
  /** Half the screen's width and height. */
  halfSize: ScreenPoint;
  /** What covers the screen, such as the panels. */
  covered: readonly ScreenRect[];
  /** Every head drawn. */
  heads: readonly ScreenDisc[];
  player: ScreenPoint;
  /** In placement order: each bubble keeps clear of those before it. */
  bubbles: readonly BubbleRequest[];
}

export interface BubblePlacement {
  centre: ScreenPoint;
  mode: BubbleMode;
}

/** The nearest a bubble comes to the rim of its anchor. */
const RIM_GAP = 0.14;
/** How much further out each ring of spots round an anchor lies than the one before. */
const GAP_STEP = 0.08;
/** The furthest apart the spots of one ring lie along a bubble's edge. */
const SLIDE_STEP = 0.1;
/** How far each bubble keeps inside the screen's edge. */
const SCREEN_INSET = 0.06;
const BUBBLE_MARGIN = 0.05;
const COVERED_MARGIN = 0.06;
const HEAD_MARGIN = 0.04;
/** What a spot straight below its anchor costs over one straight above, in metres of gap. */
const LEAN = 0.24;
/** What a tail passing behind a bubble, or a bubble sitting on a tail, costs in metres of gap. */
const TAIL_TROUBLE = 0.3;
const TAIL_TROUBLE_MARGIN = 0.02;
/** The furthest a pinned bubble steps back toward the player at a time, looking for a free spot. */
const PIN_STEP = 0.1;
/** How far a pinned or fixed bubble's tail reaches out of its body. */
const TAIL_LENGTH = 0.16;
/** How close on screen a voice is to the player before it has no direction. */
const SAME_SPOT = 1e-3;

export function layoutBubbles(input: BubbleLayoutInput): BubblePlacement[] {
  const screen = input.halfSize;
  const placed: ScreenRect[] = [];
  const tails: { from: ScreenPoint; to: ScreenPoint }[] = [];

  /** Per axis, whether the body is larger than the screen inside its inset. On such an axis its centre is held at the screen's middle. */
  const oversized = (size: ScreenSize) => ({ x: size.width > 2 * (screen.x - SCREEN_INSET), y: size.height > 2 * (screen.y - SCREEN_INSET) });
  /** How far from the screen's middle the body's centre may lie and keep inside the inset. */
  const limitFor = (size: ScreenSize): ScreenPoint => ({ x: screen.x - SCREEN_INSET - size.width / 2, y: screen.y - SCREEN_INSET - size.height / 2 });
  /** A pinned or fixed body grown by its tail on every side, so the tail shows whole whichever way it points. */
  const withTail = (size: ScreenSize): ScreenSize => ({ width: size.width + 2 * TAIL_LENGTH, height: size.height + 2 * TAIL_LENGTH });
  const fitted = (centre: ScreenPoint, size: ScreenSize): ScreenPoint => {
    const over = oversized(size);
    return { x: over.x ? 0 : centre.x, y: over.y ? 0 : centre.y };
  };
  const insideAxis = (centre: number, extent: number, half: number, over: boolean) =>
    over ? Math.abs(centre) <= half : Math.abs(centre) + extent / 2 <= half - SCREEN_INSET;
  const inScreen = (centre: ScreenPoint, size: ScreenSize) => {
    const over = oversized(size);
    return insideAxis(centre.x, size.width, screen.x, over.x) && insideAxis(centre.y, size.height, screen.y, over.y);
  };
  const clearOfCovered = (box: ScreenRect) => input.covered.every((rect) => !overlaps(box, rect, COVERED_MARGIN));
  const free = (centre: ScreenPoint, size: ScreenSize) => {
    const box = boxAt(centre, size);
    return (
      inScreen(centre, size) &&
      clearOfCovered(box) &&
      input.heads.every((head) => !touches(box, head, HEAD_MARGIN)) &&
      placed.every((other) => !overlaps(box, other, BUBBLE_MARGIN))
    );
  };

  /**
   * The cheapest spot round `anchor` that `extraCost` accepts, walked one ring at a time, nearest
   * first. A spot costs at least its ring's gap, so the walk ends at the first ring whose gap is more
   * than the cheapest cost found. It also ends at a ring with no spot on screen.
   */
  const nearestSpot = (anchor: ScreenDisc, size: ScreenSize, extraCost: (centre: ScreenPoint) => number | undefined): ScreenPoint | undefined => {
    let best: { centre: ScreenPoint; cost: number } | undefined;
    for (let gap = RIM_GAP; best === undefined || gap <= best.cost; gap += GAP_STEP) {
      let anyOnScreen = false;
      for (const offset of ringOffsets(anchor.radius + gap, size)) {
        const raw = { x: anchor.centre.x + offset.x, y: anchor.centre.y + offset.y };
        if (!inScreen(raw, size)) continue;
        anyOnScreen = true;
        const centre = fitted(raw, size);
        const extra = extraCost(centre);
        if (extra === undefined) continue;
        const cost = gap + lean({ x: centre.x - anchor.centre.x, y: centre.y - anchor.centre.y }) + extra;
        if (best === undefined || cost < best.cost) best = { centre, cost };
      }
      if (!anyOnScreen) break;
    }
    return best?.centre;
  };

  /** What it costs that a bubble here would pass its tail behind a bubble before it, or sit on a tail before it. */
  const tailTrouble = (centre: ScreenPoint, size: ScreenSize, anchor: ScreenDisc): number => {
    const box = boxAt(centre, size);
    const tip = rimPoint(anchor, centre);
    const behind = placed.filter((other) => crosses(centre, tip, other, TAIL_TROUBLE_MARGIN)).length;
    const under = tails.filter((tail) => crosses(tail.from, tail.to, box, TAIL_TROUBLE_MARGIN)).length;
    return (behind + under) * TAIL_TROUBLE;
  };

  const anchoredCentre = (bubble: BubbleRequest, anchor: ScreenDisc): ScreenPoint => {
    const { size } = bubble;
    const home = fitted({ x: anchor.centre.x, y: anchor.centre.y + anchor.radius + RIM_GAP + size.height / 2 }, size);
    if (free(home, size)) return home;
    const kept = bubble.held === undefined ? undefined : fitted({ x: anchor.centre.x + bubble.held.x, y: anchor.centre.y + bubble.held.y }, size);
    if (kept !== undefined && free(kept, size)) return kept;
    const nearest = nearestSpot(anchor, size, (centre) => (free(centre, size) ? tailTrouble(centre, size, anchor) : undefined));
    if (nearest !== undefined) return nearest;
    // No free spot: it overlaps by its anchor, at the nearest spot inside the screen that no panel covers, or just inside the screen when panels cover them all.
    if (inScreen(home, size) && clearOfCovered(boxAt(home, size))) return home;
    const uncovered = nearestSpot(anchor, size, (centre) => (clearOfCovered(boxAt(centre, size)) ? 0 : undefined));
    if (uncovered !== undefined) return uncovered;
    const over = oversized(size);
    const limit = limitFor(size);
    return { x: over.x ? 0 : clamp(home.x, -limit.x, limit.x), y: over.y ? 0 : clamp(home.y, -limit.y, limit.y) };
  };

  /**
   * From where the line from the player toward the voice leaves the screen's inset, stepped back
   * toward the player to the first free spot, the player's own among them. With none free, it
   * overlaps at the first spot no panel covers, or at the edge when panels cover them all. Where the
   * bubble is larger than the screen on an axis, it is centred there.
   */
  const pinnedCentre = (voice: ScreenPoint, size: ScreenSize): ScreenPoint => {
    const from = input.player;
    let dx = voice.x - from.x;
    let dy = voice.y - from.y;
    // A voice on the player's own spot has no direction; it is pinned to the top.
    if (Math.hypot(dx, dy) < SAME_SPOT) [dx, dy] = [0, 1];
    const limit = limitFor(size);
    const reachX = limit.x > 0 && dx !== 0 ? (Math.sign(dx) * limit.x - from.x) / dx : Number.POSITIVE_INFINITY;
    const reachY = limit.y > 0 && dy !== 0 ? (Math.sign(dy) * limit.y - from.y) / dy : Number.POSITIVE_INFINITY;
    const reach = Math.min(reachX, reachY);
    const along = (start: number, delta: number, axisLimit: number): number =>
      axisLimit <= 0 ? 0 : clamp(Number.isFinite(reach) ? start + delta * reach : start, -axisLimit, axisLimit);
    const start = { x: along(from.x, dx, limit.x), y: along(from.y, dy, limit.y) };
    const back = { x: from.x - start.x, y: from.y - start.y };
    const length = Math.hypot(back.x, back.y);
    let uncovered: ScreenPoint | undefined;
    const steps = Math.ceil(length / PIN_STEP);
    for (let index = 0; index <= steps; index += 1) {
      const fraction = steps === 0 ? 0 : index / steps;
      const centre = fitted({ x: start.x + back.x * fraction, y: start.y + back.y * fraction }, size);
      if (free(centre, size)) return centre;
      if (uncovered === undefined && inScreen(centre, size) && clearOfCovered(boxAt(centre, size))) uncovered = centre;
    }
    return uncovered ?? start;
  };

  const place = (bubble: BubbleRequest): BubblePlacement => {
    const anchor = bubble.anchor;
    if (anchor !== undefined && Math.abs(anchor.centre.x) <= screen.x && Math.abs(anchor.centre.y) <= screen.y) {
      return { centre: anchoredCentre(bubble, anchor), mode: 'anchored' };
    }
    const grown = withTail(bubble.size);
    const over = oversized(grown);
    const fixed = bubble.fixed;
    if (fixed !== undefined && !over.x && !over.y && free(fixed, grown)) return { centre: fixed, mode: 'fixed' };
    return { centre: pinnedCentre(bubble.voice, grown), mode: 'pinned' };
  };

  return input.bubbles.map((bubble) => {
    const placement = place(bubble);
    if (placement.mode === 'anchored') {
      placed.push(boxAt(placement.centre, bubble.size));
      tails.push({ from: placement.centre, to: rimPoint(bubble.anchor!, placement.centre) });
    } else {
      placed.push(boxAt(placement.centre, withTail(bubble.size)));
    }
    return placement;
  });
}

/**
 * Where a bubble's tail ends. A bubble hung round an anchor reaches the anchor's rim on the side
 * facing it, and has no tail while it covers the anchor's centre. A pinned or fixed one points a
 * short tail straight out of the edge the line toward its target crosses.
 */
export function tailTip(centre: ScreenPoint, size: ScreenSize, target: { anchor: ScreenDisc } | { toward: ScreenPoint }): ScreenPoint | undefined {
  if ('anchor' in target) {
    const anchor = target.anchor;
    if (Math.abs(anchor.centre.x - centre.x) < size.width / 2 && Math.abs(anchor.centre.y - centre.y) < size.height / 2) return undefined;
    return rimPoint(anchor, centre);
  }
  const dx = target.toward.x - centre.x;
  const dy = target.toward.y - centre.y;
  if (dx === 0 && dy === 0) return undefined;
  const half = { x: size.width / 2, y: size.height / 2 };
  if (Math.abs(dx) * half.y >= Math.abs(dy) * half.x) {
    return { x: centre.x + Math.sign(dx) * (half.x + TAIL_LENGTH), y: centre.y + (dy * half.x) / Math.abs(dx) };
  }
  return { x: centre.x + (dx * half.y) / Math.abs(dy), y: centre.y + Math.sign(dy) * (half.y + TAIL_LENGTH) };
}

/**
 * The centres, sampled, where a body of `size` has its nearest edge or corner `distance` from a point: slid
 * along each of its four edges, and round each corner.
 */
function ringOffsets(distance: number, size: ScreenSize): ScreenPoint[] {
  const halfWidth = size.width / 2;
  const halfHeight = size.height / 2;
  const offsets: ScreenPoint[] = [];
  const across = Math.max(1, Math.ceil(size.width / SLIDE_STEP));
  for (let index = 0; index <= across; index += 1) {
    const x = -halfWidth + (size.width * index) / across;
    offsets.push({ x, y: halfHeight + distance }, { x, y: -(halfHeight + distance) });
  }
  const down = Math.max(1, Math.ceil(size.height / SLIDE_STEP));
  for (let index = 0; index <= down; index += 1) {
    const y = -halfHeight + (size.height * index) / down;
    offsets.push({ x: halfWidth + distance, y }, { x: -(halfWidth + distance), y });
  }
  for (let degrees = 15; degrees < 90; degrees += 15) {
    const radians = (degrees * Math.PI) / 180;
    const x = halfWidth + distance * Math.cos(radians);
    const y = halfHeight + distance * Math.sin(radians);
    offsets.push({ x, y }, { x: -x, y }, { x, y: -y }, { x: -x, y: -y });
  }
  return offsets;
}

/** How much a spot at `offset` from its anchor costs for not being straight above it. */
function lean(offset: ScreenPoint): number {
  const length = Math.hypot(offset.x, offset.y);
  if (length === 0) return 0;
  return (LEAN * Math.acos(clamp(offset.y / length, -1, 1))) / Math.PI;
}

/** The point on the anchor's rim facing `toward`. */
function rimPoint(anchor: ScreenDisc, toward: ScreenPoint): ScreenPoint {
  const dx = toward.x - anchor.centre.x;
  const dy = toward.y - anchor.centre.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return anchor.centre;
  return { x: anchor.centre.x + (dx / length) * anchor.radius, y: anchor.centre.y + (dy / length) * anchor.radius };
}

function boxAt(centre: ScreenPoint, size: ScreenSize): ScreenRect {
  return { left: centre.x - size.width / 2, bottom: centre.y - size.height / 2, right: centre.x + size.width / 2, top: centre.y + size.height / 2 };
}

function overlaps(a: ScreenRect, b: ScreenRect, margin: number): boolean {
  return a.left < b.right + margin && b.left < a.right + margin && a.bottom < b.top + margin && b.bottom < a.top + margin;
}

function touches(box: ScreenRect, disc: ScreenDisc, margin: number): boolean {
  const dx = Math.max(box.left - disc.centre.x, 0, disc.centre.x - box.right);
  const dy = Math.max(box.bottom - disc.centre.y, 0, disc.centre.y - box.top);
  return Math.hypot(dx, dy) < disc.radius + margin;
}

/** Whether the segment from `from` to `to` passes through `rect` grown by `margin`. */
function crosses(from: ScreenPoint, to: ScreenPoint, rect: ScreenRect, margin: number): boolean {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  let enter = 0;
  let leave = 1;
  const clips: [number, number][] = [
    [-dx, from.x - (rect.left - margin)],
    [dx, rect.right + margin - from.x],
    [-dy, from.y - (rect.bottom - margin)],
    [dy, rect.top + margin - from.y],
  ];
  for (const [toward, room] of clips) {
    if (toward === 0) {
      if (room < 0) return false;
      continue;
    }
    const at = room / toward;
    if (toward < 0) enter = Math.max(enter, at);
    else leave = Math.min(leave, at);
    if (enter > leave) return false;
  }
  return true;
}
