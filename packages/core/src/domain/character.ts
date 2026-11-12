import type { Energy } from '@somnio/protocol';
import type { Point } from '../geometry.ts';
import type { Heading } from '../heading.ts';
import type { Lucidity } from '../lucidity.ts';
import type { People } from '../people.ts';
import type { QuestLog } from '../quests.ts';

export interface Character {
  id: string;
  name: string;
  people: People;
  /** The id of the space the character stands in; `position` is in that space's coordinates. */
  space: string;
  position: Point;
  facing: Heading;
  energy: Energy;
  lucidity: Lucidity;
  quests: QuestLog;
  lastSeen: Date;
}

/**
 * The `lastSeen` of a character's next write: now, but strictly after `previous`, so the `last_seen`
 * guard accepts it over the row it follows even when two are taken in one millisecond or the
 * clock has stepped back.
 */
export function nextLastSeen(previous: Date, now: Date): Date {
  return new Date(Math.max(now.getTime(), previous.getTime() + 1));
}
