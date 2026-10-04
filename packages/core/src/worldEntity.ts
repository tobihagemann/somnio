import type { Gait } from '@somnio/protocol';
import type { Point } from './geometry.ts';
import type { Heading } from './heading.ts';

export type WorldEntityKind = 'player' | 'peer' | 'npc' | 'monster';

export interface WorldEntity {
  id: string;
  kind: WorldEntityKind;
  characterModelId: string;
  name: string;
  position: Point;
  facing: Heading;
  gait: Gait;
}
