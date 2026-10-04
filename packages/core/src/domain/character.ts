import type { Energy } from '@somnio/protocol';
import type { Point } from '../geometry.ts';
import type { Heading } from '../heading.ts';
import type { People } from '../people.ts';

export interface Character {
  id: string;
  name: string;
  people: People;
  /** The id of the space the character stands in; `position` is in that space's coordinates. */
  space: string;
  position: Point;
  facing: Heading;
  energy: Energy;
  lastSeen: Date;
}
