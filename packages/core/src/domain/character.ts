import type { Energy } from '@somnio/protocol';
import type { Gender } from '../characterClass.ts';
import type { GridPoint } from '../geometry.ts';
import type { Heading } from '../heading.ts';
import type { Tempo } from '../tempo.ts';

export interface Character {
  id: string;
  name: string;
  figure: number;
  gender: Gender;
  currentSector: string;
  position: GridPoint;
  facing: Heading;
  tempo: Tempo;
  energy: Energy;
  lastSeen: Date;
}
