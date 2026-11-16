import type { ClientToServerTag } from '@somnio/protocol';
import { SPEECH_PACE } from '@somnio/core';
import type { Budgets } from './attemptLimiter.ts';

/**
 * The gameplay budgets of one account: a burst of frames, then one more per refill interval. Each
 * budgets the frames that fan out to other players. Every `refillMs` is whole, so a full budget
 * admits exactly its burst.
 *
 * - `move` covers a walker's 7.5 s stall (75 reports at 10 Hz) plus a path's waypoints, and bounds
 *   what crossing a sector boundary back and forth sends everyone who sees it. A slower walk can
 *   bunch for longer within the allowance; the reports past the budget are dropped, and the
 *   allowance judges the next one accepted.
 * - `speech` lets the shipped client's lines through bunched by up to 8 s.
 * - `items` is one budget over every frame that can change what others see the dreamer hold or
 *   what lies on the ground, so interleaving them buys nothing.
 */
export const FRAME_LIMITS = {
  move: { burst: 100, refillMs: 33 },
  speech: { burst: SPEECH_PACE.burst + 8 * SPEECH_PACE.perSecond, refillMs: 1000 / SPEECH_PACE.perSecond },
  transfer: { burst: 8, refillMs: 1000 },
  items: { burst: 20, refillMs: 200 },
} as const;

export type FrameKind = keyof typeof FRAME_LIMITS;

export const FRAME_BUDGETS: Budgets<FrameKind> = { limits: FRAME_LIMITS, keyField: 'account_id', throttleMessage: 'gameplay frame throttled' };

/**
 * The budget each client frame spends in the world, so a new tag has to say whether it fans out.
 * A tag mapped to `undefined` spends none. Either it answers only its sender, or it is refused once
 * the player is in the world, or something else already paces what it shows others: the global
 * cooldown paces `useAbility`, an NPC's own cooldown `interact`, the swing and touch timers
 * `engage`, having to fall first `wake`, and a quest turned in only once the gift a trial's
 * `turnInQuest` hands.
 */
export const FRAME_KINDS: Record<ClientToServerTag, FrameKind | undefined> = {
  login: undefined,
  register: undefined,
  createCharacter: undefined,
  selectCharacter: undefined,
  deleteCharacter: undefined,
  move: 'move',
  clientSay: 'speech',
  equip: 'items',
  unequip: 'items',
  moveItem: 'items',
  dropItem: 'items',
  pickUp: 'items',
  interact: undefined,
  target: undefined,
  engage: undefined,
  useAbility: undefined,
  useDoor: 'transfer',
  acceptQuest: undefined,
  turnInQuest: undefined,
  abandonQuest: undefined,
  study: undefined,
  buy: undefined,
  sell: undefined,
  buyBack: undefined,
  wake: undefined,
  redeemSession: undefined,
  revokeSession: undefined,
  revokeOtherSessions: undefined,
};
