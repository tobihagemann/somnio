import { RARITIES } from '@somnio/protocol';
import type { NightmareRank, Role } from '@somnio/protocol';
import { rollItem } from './affixes.ts';
import { MOVE_SUBSTEP, isClear, isLegalMove } from './collision.ts';
import type { Body, SpaceCollision } from './collision.ts';
import { handAllows } from './combat.ts';
import { SOMNIO_CONSTANTS } from './constants.ts';
import type { HandNeed } from './combat.ts';
import type { Inventory } from './domain/inventory.ts';
import { distance } from './geometry.ts';
import type { Point } from './geometry.ts';
import { headingRadians } from './heading.ts';
import type { Heading } from './heading.ts';
import { BASE_ITEMS, baseItem, plainItem } from './items.ts';
import type { BaseItemId, Item, ItemInstance, Rarity, Tier } from './items.ts';
import { TRIAL_REWARDS } from './lucidity.ts';

/**
 * How far from a dreamer's centre a drop lies at most for them to pick it up. It is wider than the
 * nearest a path comes to a standing body's centre, so a drop under a body is picked up from where
 * the path stops beside it.
 */
export const PICKUP_REACH = 1;

/**
 * How many drops from nightmares lie for one dreamer at most, across every space. Each lies until
 * its owner leaves the world, and a new one past this takes the oldest away.
 */
export const MAX_PERSONAL_DROPS = 50;

/** How long an item a dreamer dropped lies on the ground for anyone before it is gone: long enough to call a friend over. */
export const SHARED_LOOT_SECONDS = 900;

/**
 * How many items dreamers dropped lie in one space at most. A new one past this takes the oldest
 * away, so a pile can never flood the frames a join sends.
 */
export const MAX_SHARED_DROPS = 100;

/** Whether a dreamer standing at `dreamer` can pick up a drop lying at `loot`. */
export function withinPickupReach(dreamer: Point, loot: Point): boolean {
  return distance(dreamer, loot) <= PICKUP_REACH;
}

/** How far from a dreamer's centre an item they drop is thrown: clear of their body, and within their pickup reach where they stand. */
export const THROW_DISTANCE = 1;

/** How far the drops a nightmare leaves burst out from where it stood, at least and at most: clear of the bodies fighting over it, as Diablo's loot flies. */
export const SCATTER_DISTANCE = { min: 1, max: 2 } as const;

/** How much room round its point a drop needs: a wall, a collider, or a ledge closer than this leaves no room to lie. */
const DROP_RADIUS = 0.1;

/**
 * Where an item thrown from `from` along `heading` lands: the farthest point up to `metres` out
 * that the throw reaches with room to lie all the way, and that a dreamer standing at `from`
 * comes within pickup reach of by a legal step along the throw. So it never passes through a
 * wall, a collider, or a ledge, or leaves the space, and lands short on the thrower's side of
 * whatever stops it, at `from` itself when nothing past it holds.
 */
export function throwLanding(collision: SpaceCollision, from: Point, heading: Heading, metres: number, npcs: readonly Body[]): Point {
  const turn = headingRadians(heading);
  const along = (length: number): Point => ({ x: from.x + Math.sin(turn) * length, z: from.z + Math.cos(turn) * length });
  const count = Math.ceil(metres / MOVE_SUBSTEP);
  let landing = from;
  for (let index = 1; index <= count; index += 1) {
    const length = (metres * index) / count;
    const point = along(length);
    if (!isClear(collision, point, DROP_RADIUS)) break;
    if (length > PICKUP_REACH && !isLegalMove(collision, from, along(length - PICKUP_REACH), SOMNIO_CONSTANTS.playerRadius, npcs)) break;
    landing = point;
  }
  return landing;
}

/**
 * Where `count` drops a nightmare leaves land, scattered from where it stood at `from`: fanned evenly
 * round it from a rolled heading, each nudged on by up to half its share of the turn, so no two lie
 * in one heap, and each `SCATTER_DISTANCE` out as `throwLanding` throws it, short of whatever stops
 * it. `random` gives rolls in `[0, 1)`.
 */
export function scatterLandings(collision: SpaceCollision, from: Point, count: number, npcs: readonly Body[], random: () => number): Point[] {
  const start = random() * 360;
  const spacing = 360 / count;
  return Array.from({ length: count }, (_, index) => {
    const heading = start + (index + random() / 2) * spacing;
    const metres = SCATTER_DISTANCE.min + random() * (SCATTER_DISTANCE.max - SCATTER_DISTANCE.min);
    return throwLanding(collision, from, heading, metres, npcs);
  });
}

/**
 * How one dreamer's drops from a foe go: how many rolls they get, each one's chance to drop
 * anything, the share of drops that may be any base rather than one the dreamer's role can use, and
 * each rarity's weight among the drops.
 */
interface DropOdds {
  rolls: number;
  chance: number;
  openShare: number;
  rarities: Readonly<Record<Rarity, number>>;
}

/**
 * The drop odds by the rank of the foe driven off: `nightmare` for an ordinary one, else its
 * `NightmareRank`. Most drops are of a base the dreamer's role can use (`usableBy`), and the open
 * share is of any, so something to sell or give still turns up. The odds are tuned in play, as
 * `COMBAT`'s numbers are.
 */
export const DROP_ODDS = {
  nightmare: { rolls: 1, chance: 0.3, openShare: 0.2, rarities: { plain: 60, magic: 30, rare: 10 } },
  elite: { rolls: 2, chance: 0.5, openShare: 0.2, rarities: { plain: 40, magic: 40, rare: 20 } },
  boss: { rolls: 4, chance: 0.9, openShare: 0.2, rarities: { plain: 10, magic: 50, rare: 40 } },
} as const satisfies Record<'nightmare' | NightmareRank, DropOdds>;
export type DropRank = keyof typeof DROP_ODDS;

/**
 * The bases a drop of the tier may be: every base of that tier or a lower one but the Moonstone,
 * which only the Healer's trial gives. Lower tiers count, so a further ring still drops the armour
 * and jewellery it has no bases of its own for.
 */
export function droppableBases(tier: Tier): BaseItemId[] {
  return (Object.keys(BASE_ITEMS) as BaseItemId[]).filter((baseId) => baseItem(baseId).tier <= tier && baseItem(baseId).trialOnly !== true);
}

/** The kits that hold the off hand, by what they need there. */
const OFF_HAND_NEEDS = ['moonstone', 'focus'] as const satisfies readonly HandNeed[];

/** What an item of the base serves in the off hand: the kit need it meets there, if any, as `handAllows` judges it. */
function offHandNeed(baseId: BaseItemId): HandNeed | undefined {
  return OFF_HAND_NEEDS.find((need) => handAllows(need, { offHand: plainItem(baseId) }));
}

/**
 * Whether a dreamer of the role can use an item of the base. A main hand, armour, and jewellery
 * serve everyone. The off hand of a role whose trial gives an off-hand item is held by that kind of item
 * (the Healer's Moonstone, the Mystic's focus), and any other role's by an off hand no kit needs,
 * so a Fighter uses no focus, a Healer neither a focus nor a shield, and a Mystic no shield. A
 * dreamer with no role yet uses anything.
 */
export function usableBy(baseId: BaseItemId, role: Role | undefined): boolean {
  if (role === undefined || baseItem(baseId).slot !== 'offHand') return true;
  const reward = TRIAL_REWARDS[role];
  return offHandNeed(baseId) === (reward === undefined ? undefined : offHandNeed(reward));
}

/**
 * What one dreamer of the role finds after a foe of the tier and rank is driven off, rolled apart
 * from every other dreamer's: for each of the rank's rolls, by its chance, an item rolled at the
 * tier, at a rarity by the weights, of a droppable base the role can use, or by the open share of
 * any droppable base, each base as likely as any other. `random` gives rolls in `[0, 1)`.
 */
export function rollDrops(tier: Tier, rank: DropRank, role: Role | undefined, random: () => number): Item[] {
  const odds: DropOdds = DROP_ODDS[rank];
  const bases = droppableBases(tier);
  const usable = bases.filter((baseId) => usableBy(baseId, role));
  const drops: Item[] = [];
  for (let roll = 0; roll < odds.rolls; roll += 1) {
    if (random() >= odds.chance) continue;
    const from = random() < odds.openShare ? bases : usable;
    const baseId = from[Math.floor(random() * from.length)]!;
    drops.push(rollItem(baseId, tier, rarityBy(odds.rarities, random()), random));
  }
  return drops;
}

/** The item a dreamer can drop to the ground, by its id: anything they carry or wear but the Moonstone. */
export function droppableItem(inventory: Inventory, itemId: string): ItemInstance | undefined {
  const item = inventory.bag.find((bagged) => bagged.item.id === itemId)?.item ?? Object.values(inventory.equipped).find((worn) => worn.id === itemId);
  return item === undefined || baseItem(item.baseId).trialOnly === true ? undefined : item;
}

/** The rarity a roll in `[0, 1)` lands on, each taking its weight's share of the range in `RARITIES` order. */
function rarityBy(weights: Readonly<Record<Rarity, number>>, roll: number): Rarity {
  const total = RARITIES.reduce((sum, rarity) => sum + weights[rarity], 0);
  let left = roll * total;
  for (const rarity of RARITIES) {
    left -= weights[rarity];
    if (left < 0) return rarity;
  }
  return RARITIES.at(-1)!;
}
