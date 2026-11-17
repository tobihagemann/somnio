import { BOARD_DAY_MS, boardDay, dayBounties } from '@somnio/core';
import type { Bounty, BountyLand } from '@somnio/core';
import type { BountyObjective } from '@somnio/protocol';

/** The board's day the tests start from. */
export const DAY = boardDay(Date.UTC(2026, 10, 16));

/** The Graveyard as a bounty's land, keeping one Skeleton alive. */
const SKELETONS: BountyLand = { name: 'Graveyard', kinds: [{ kind: 'skeleton-minion', alive: 1 }] };

/** Noon UTC of the board's day, in epoch milliseconds. */
export function noon(day: number): number {
  return day * BOARD_DAY_MS + BOARD_DAY_MS / 2;
}

/** The bounties a Graveyard keeping one Skeleton alive gets on the day. */
export function offered(day: number): Bounty[] {
  return dayBounties(day, [SKELETONS]);
}

/** The first day from `DAY` whose bounty asks `objective` and pays an item. */
export function dayAsking(objective: BountyObjective): number {
  let day = DAY;
  while (offered(day)[0]!.objective !== objective || offered(day)[0]!.reward.gear === undefined) day += 1;
  return day;
}
