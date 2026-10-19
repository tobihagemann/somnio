import {
  OUTDOOR_SPACE_ID,
  SOMNIO_CONSTANTS,
  clamp,
  dialogLine,
  dialogSteps,
  distance,
  gaitMetresPerSecond,
  monsterKind,
  sectorPointInSpace,
} from '@somnio/core';
import type { Heading, ModelRegistry, Point, Sector } from '@somnio/core';
import type { Condition, Gait, SpeechKind } from '@somnio/protocol';
import type { RaiseProgress } from '@/client/renderSurface';
import { t } from '@/i18n';
import { ORTHO_RIG, worldMovement } from '@/scene/cameraRig';

/**
 * The splash reel: a fixed sequence of short shots of the committed world, staged in the browser
 * with scripted dreamers, NPCs, and nightmares. Positions are in the coordinates of the shot's
 * space, so an outdoor point carries its sector's origin and the Nordwald lies at negative `z`.
 */

/** How long the dip to dark between two shots takes, half of it falling and half rising. */
export const DIP_SECONDS = 0.5;

/** The widest pre-login card (Sign Up) and the tallest, in CSS pixels; every one is centred. */
export const PRE_LOGIN_CARD = { width: 560, height: 294 } as const;

/** Where the wordmark band runs: from this far below the top edge to this far above the tallest card. */
export const WORDMARK_BAND_INSET = 24;

export interface Viewport {
  width: number;
  height: number;
}

/** A dreamer the reel invents, drawn as a player with their name on the plate. */
interface PeerActor {
  kind: 'peer';
  id: string;
  name: string;
  at: Point;
  facing: Heading;
  gait: Gait;
  path: readonly Point[];
  /** Whom the dreamer turns to once they stand. */
  faces?: string;
}

/** An NPC as its sector's own record places it. */
interface NPCActor {
  kind: 'npc';
  sector: string;
  npc: string;
}

/** A nightmare of a sector's monster spawn, starting inside its area. */
interface MonsterActor {
  kind: 'monster';
  id: string;
  spawn: { sector: string; id: string };
  at: Point;
  facing: Heading;
  path: readonly Point[];
  faces?: string;
}

/** An actor of the shot before, in the same space, taken over as it stands. */
interface CarriedActor {
  kind: 'carried';
  id: string;
  path: readonly Point[];
  faces?: string;
}

type SplashActor = PeerActor | NPCActor | MonsterActor | CarriedActor;

type SplashBeat =
  | { at: number; kind: 'blow'; attacker: string; target: string; hit: boolean }
  | { at: number; kind: 'condition'; id: string; condition: Condition }
  | { at: number; kind: 'raise'; target: string; raise: RaiseProgress | undefined }
  | { at: number; kind: 'speech'; speaker: string; speech: SpeechKind; text: () => string }
  /** The NPC's own first dialog step, said to `listener` as the server would greet them. */
  | { at: number; kind: 'greeting'; npc: string; listener: string };

type SplashCamera =
  /** Keeps `subject`, an actor id or a fixed point, beside the card on `side`, `drop` half-heights below the middle. */
  | { kind: 'subject'; subject: string | Point; side: 'left' | 'right'; drop: number; scale: { from: number; to: number } }
  /** A pan with no subject. */
  | { kind: 'area'; from: { point: Point; scale: number }; to: { point: Point; scale: number } };

export interface SplashShot {
  id: string;
  /** `outdoors`, or the name of an interior sector. */
  space: string;
  seconds: number;
  /** The hour lighting the shot, or the hours a time-lapse runs between; past 24 is the next day. */
  hour: number | { from: number; to: number };
  camera: SplashCamera;
  actors: readonly SplashActor[];
  beats: readonly SplashBeat[];
}

/** An actor with everything the scene needs to draw it and the script needs to move it. */
export interface StagedActor {
  id: string;
  kind: 'peer' | 'npc' | 'monster';
  characterModelId: string;
  name: string;
  radius: number;
  metresPerSecond: number;
  gait: Gait;
  start: Point;
  facing: Heading;
  path: readonly Point[];
  faces: string | undefined;
  /** How it stands as the shot opens: hale, unless the shot before left it otherwise. */
  condition: Condition;
  /** Whether it came over from the shot before rather than being placed. */
  carried: boolean;
}

type StagedBeat = Exclude<SplashBeat, { kind: 'greeting' }>;

export interface StagedShot extends Omit<SplashShot, 'actors' | 'beats'> {
  sectors: Sector[];
  actors: StagedActor[];
  beats: StagedBeat[];
}

const AUREL = 'splash:aurel';
const MIRA = 'splash:mira';
const TAMO = 'splash:tamo';
const LINNEA = 'splash:linnea';
const ODO = 'splash:odo';
const PUGNAX = 'npc:EdariaMitte/pugnax';
const LIBUS = 'npc:EdariaBibliothek/libus';
const GESPENST = 'monster:splash-1';
const NORDWALD_SPAWN = { sector: 'Nordwald', id: 'spawn-1' };

/** The reel in the order it plays. Every scripted path is a straight run between points the reel test proves legal. */
export const SPLASH_REEL: readonly SplashShot[] = [
  {
    id: 'town',
    space: OUTDOOR_SPACE_ID,
    seconds: 7,
    hour: 10,
    camera: { kind: 'area', from: { point: { x: 18.5, z: 20.8 }, scale: 6.2 }, to: { point: { x: 22.5, z: 19.6 }, scale: 6.2 } },
    actors: [
      { kind: 'peer', id: TAMO, name: 'Tamo', at: { x: 9, z: 20.5 }, facing: 90, gait: 'walk', path: [{ x: 16, z: 20.5 }] },
      {
        kind: 'peer',
        id: LINNEA,
        name: 'Linnea',
        at: { x: 23.5, z: 9 },
        facing: 0,
        gait: 'jog',
        path: [
          { x: 23.5, z: 17 },
          { x: 26, z: 18.5 },
        ],
      },
      { kind: 'peer', id: ODO, name: 'Odo', at: { x: 31, z: 22 }, facing: 270, gait: 'walk', path: [{ x: 24.5, z: 22 }] },
    ],
    beats: [],
  },
  {
    id: 'follow-dreamer',
    space: OUTDOOR_SPACE_ID,
    seconds: 7,
    hour: 11,
    camera: { kind: 'subject', subject: AUREL, side: 'right', drop: 0.35, scale: { from: 2.5, to: 2.5 } },
    actors: [
      {
        kind: 'peer',
        id: AUREL,
        name: 'Aurel',
        at: { x: 22.5, z: 19 },
        facing: 180,
        gait: 'jog',
        path: [
          { x: 22.5, z: 9.3 },
          { x: 30, z: 9.3 },
        ],
      },
    ],
    beats: [],
  },
  {
    id: 'npc-greeting',
    space: OUTDOOR_SPACE_ID,
    seconds: 7,
    hour: 12,
    camera: { kind: 'subject', subject: PUGNAX, side: 'right', drop: 0.5, scale: { from: 2.2, to: 2.2 } },
    actors: [
      { kind: 'npc', sector: 'EdariaMitte', npc: 'pugnax' },
      { kind: 'peer', id: MIRA, name: 'Mira', at: { x: 39.6, z: 32.1 }, facing: 220, gait: 'walk', path: [{ x: 38.4, z: 33.7 }], faces: PUGNAX },
    ],
    beats: [{ at: 2.6, kind: 'greeting', npc: PUGNAX, listener: 'Mira' }],
  },
  {
    id: 'speech',
    space: OUTDOOR_SPACE_ID,
    seconds: 7,
    hour: 14,
    camera: { kind: 'subject', subject: { x: 21.8, z: 22.6 }, side: 'left', drop: 0.35, scale: { from: 2.8, to: 2.6 } },
    actors: [
      { kind: 'peer', id: TAMO, name: 'Tamo', at: { x: 21.55, z: 22.77 }, facing: 120, gait: 'walk', path: [] },
      { kind: 'peer', id: LINNEA, name: 'Linnea', at: { x: 22.05, z: 22.43 }, facing: 300, gait: 'walk', path: [] },
      { kind: 'peer', id: ODO, name: 'Odo', at: { x: 22.32, z: 23.34 }, facing: 180, gait: 'walk', path: [] },
    ],
    beats: [
      { at: 0.6, kind: 'speech', speaker: TAMO, speech: 'say', text: () => t('Anyone up for the Nordwald?') },
      { at: 2.4, kind: 'speech', speaker: ODO, speech: 'yell', text: () => t('Watch out, nightmares about!') },
      { at: 4.2, kind: 'speech', speaker: LINNEA, speech: 'whisper', text: () => t('Meet me at the inn.') },
    ],
  },
  {
    id: 'follow-nightmare',
    space: OUTDOOR_SPACE_ID,
    seconds: 6,
    hour: 13,
    camera: { kind: 'subject', subject: GESPENST, side: 'left', drop: 0.4, scale: { from: 2.6, to: 2.6 } },
    actors: [
      {
        kind: 'monster',
        id: GESPENST,
        spawn: NORDWALD_SPAWN,
        at: { x: 18.5, z: -50.3 },
        facing: 90,
        path: [
          { x: 23, z: -50 },
          { x: 19.77, z: -46.29 },
        ],
      },
    ],
    beats: [],
  },
  {
    id: 'combat',
    space: OUTDOOR_SPACE_ID,
    seconds: 8,
    hour: 13,
    camera: { kind: 'subject', subject: AUREL, side: 'left', drop: 0.4, scale: { from: 2.6, to: 2.4 } },
    actors: [
      { kind: 'peer', id: AUREL, name: 'Aurel', at: { x: 19, z: -46.6 }, facing: 35, gait: 'walk', path: [], faces: GESPENST },
      { kind: 'carried', id: GESPENST, path: [], faces: AUREL },
    ],
    beats: [
      { at: 0.5, kind: 'blow', attacker: GESPENST, target: AUREL, hit: true },
      { at: 0.5, kind: 'condition', id: AUREL, condition: 'grazed' },
      { at: 0.8, kind: 'blow', attacker: AUREL, target: GESPENST, hit: false },
      { at: 1.8, kind: 'blow', attacker: AUREL, target: GESPENST, hit: true },
      { at: 1.8, kind: 'condition', id: GESPENST, condition: 'grazed' },
      { at: 2, kind: 'blow', attacker: GESPENST, target: AUREL, hit: true },
      { at: 2, kind: 'condition', id: AUREL, condition: 'wounded' },
      { at: 2.8, kind: 'blow', attacker: AUREL, target: GESPENST, hit: false },
      { at: 3.5, kind: 'blow', attacker: GESPENST, target: AUREL, hit: true },
      { at: 3.5, kind: 'condition', id: AUREL, condition: 'hurt' },
      { at: 3.8, kind: 'blow', attacker: AUREL, target: GESPENST, hit: true },
      { at: 4.8, kind: 'blow', attacker: AUREL, target: GESPENST, hit: false },
      { at: 5, kind: 'blow', attacker: GESPENST, target: AUREL, hit: true },
      { at: 5, kind: 'condition', id: AUREL, condition: 'failing' },
      { at: 5.8, kind: 'blow', attacker: AUREL, target: GESPENST, hit: true },
      { at: 6.5, kind: 'blow', attacker: GESPENST, target: AUREL, hit: true },
      { at: 6.5, kind: 'condition', id: AUREL, condition: 'fallen' },
    ],
  },
  {
    id: 'raise',
    space: OUTDOOR_SPACE_ID,
    seconds: 8,
    hour: 13,
    camera: { kind: 'subject', subject: AUREL, side: 'left', drop: 0.4, scale: { from: 2.4, to: 2.4 } },
    actors: [
      { kind: 'carried', id: AUREL, path: [] },
      { kind: 'carried', id: GESPENST, path: [{ x: 22.5, z: -48.5 }] },
      { kind: 'peer', id: MIRA, name: 'Mira', at: { x: 16.5, z: -43.5 }, facing: 120, gait: 'jog', path: [{ x: 19.65, z: -46.63 }], faces: AUREL },
    ],
    beats: [
      { at: 2.4, kind: 'raise', target: AUREL, raise: { progress: 0, seconds: 5 } },
      { at: 7.4, kind: 'condition', id: AUREL, condition: 'hale' },
      { at: 7.4, kind: 'raise', target: AUREL, raise: undefined },
    ],
  },
  {
    id: 'inn',
    space: 'EdariaInn',
    seconds: 6,
    hour: 12,
    camera: { kind: 'subject', subject: ODO, side: 'right', drop: 0.45, scale: { from: 2.4, to: 2 } },
    actors: [
      { kind: 'npc', sector: 'EdariaInn', npc: 'quieta' },
      { kind: 'peer', id: ODO, name: 'Odo', at: { x: 4.2, z: 2.56 }, facing: 270, gait: 'walk', path: [{ x: 3.1, z: 2.9 }], faces: 'npc:EdariaInn/quieta' },
    ],
    beats: [],
  },
  {
    id: 'library',
    space: 'EdariaBibliothek',
    seconds: 6,
    hour: 12,
    camera: { kind: 'subject', subject: LIBUS, side: 'right', drop: 0.4, scale: { from: 3, to: 2.6 } },
    actors: [
      { kind: 'npc', sector: 'EdariaBibliothek', npc: 'libus' },
      {
        kind: 'peer',
        id: LINNEA,
        name: 'Linnea',
        at: { x: 1.3, z: 5.3 },
        facing: 90,
        gait: 'walk',
        path: [
          { x: 4.2, z: 5.3 },
          { x: 3.4, z: 5.2 },
        ],
      },
    ],
    beats: [],
  },
  {
    id: 'time-lapse',
    space: OUTDOOR_SPACE_ID,
    seconds: 8,
    hour: { from: 16, to: 31 },
    camera: { kind: 'area', from: { point: { x: 20.5, z: 18 }, scale: 7 }, to: { point: { x: 20.5, z: 20 }, scale: 7 } },
    actors: [],
    beats: [],
  },
];

/**
 * Resolves every shot against the sectors: its space's sectors, each actor with its model,
 * radius, speed, and where it stands as the shot opens, and each greeting as the line it says.
 * Throws on a reference the sectors or the shot before do not hold.
 */
export function stageReel(reel: readonly SplashShot[], sectors: readonly Sector[], registry: ModelRegistry): StagedShot[] {
  const staged: StagedShot[] = [];
  for (const shot of reel) {
    const previous = staged.at(-1);
    const spaceSectors = sectors.filter((sector) => (sector.kind === 'outdoor' ? OUTDOOR_SPACE_ID : sector.name) === shot.space);
    if (spaceSectors.length === 0) throw new Error(`splash shot ${shot.id}: no sectors in space ${shot.space}`);
    const actors = shot.actors.map((actor) => stageActor(actor, shot, previous, spaceSectors, registry));
    const beats = shot.beats.map((beat): StagedBeat => {
      if (beat.kind !== 'greeting') return beat;
      const npc = findNPC(spaceSectors, beat.npc);
      if (npc === undefined) throw new Error(`splash shot ${shot.id}: no NPC ${beat.npc}`);
      return { at: beat.at, kind: 'speech', speaker: beat.npc, speech: 'say', text: () => dialogLine(dialogSteps(npc.dialogScript)[0] ?? '', beat.listener) };
    });
    staged.push({ ...shot, sectors: spaceSectors, actors, beats });
  }
  return staged;
}

function stageActor(actor: SplashActor, shot: SplashShot, previous: StagedShot | undefined, sectors: readonly Sector[], registry: ModelRegistry): StagedActor {
  switch (actor.kind) {
    case 'peer':
      return {
        id: actor.id,
        kind: 'peer',
        characterModelId: registry.playerModel,
        name: actor.name,
        radius: SOMNIO_CONSTANTS.playerRadius,
        metresPerSecond: gaitMetresPerSecond(actor.gait),
        gait: actor.gait,
        start: actor.at,
        facing: actor.facing,
        path: actor.path,
        faces: actor.faces,
        condition: 'hale',
        carried: false,
      };
    case 'npc': {
      const id = npcId(actor.sector, actor.npc);
      const sector = sectors.find((candidate) => candidate.name === actor.sector);
      const npc = sector?.npcs.find((candidate) => candidate.id === actor.npc);
      if (sector === undefined || npc === undefined) throw new Error(`splash shot ${shot.id}: no NPC ${id}`);
      return {
        id,
        kind: 'npc',
        characterModelId: npc.characterModelId,
        name: npc.name,
        radius: SOMNIO_CONSTANTS.npcRadius,
        metresPerSecond: 0,
        gait: 'walk',
        start: sectorPointInSpace(sector, npc),
        facing: npc.facing,
        path: [],
        faces: undefined,
        condition: 'hale',
        carried: false,
      };
    }
    case 'monster': {
      const sector = sectors.find((candidate) => candidate.name === actor.spawn.sector);
      const spawn = sector?.monsterSpawns.find((candidate) => candidate.id === actor.spawn.id);
      if (spawn === undefined) throw new Error(`splash shot ${shot.id}: no monster spawn ${actor.spawn.sector}/${actor.spawn.id}`);
      const kind = monsterKind(spawn.kind);
      return {
        id: actor.id,
        kind: 'monster',
        characterModelId: kind.characterModelId,
        name: kind.name,
        radius: kind.radius,
        metresPerSecond: kind.metresPerSecond,
        gait: 'walk',
        start: actor.at,
        facing: actor.facing,
        path: actor.path,
        faces: actor.faces,
        condition: 'hale',
        carried: false,
      };
    }
    case 'carried': {
      const before = previous?.space === shot.space ? previous.actors.find((candidate) => candidate.id === actor.id) : undefined;
      if (previous === undefined || before === undefined) throw new Error(`splash shot ${shot.id}: ${actor.id} is not in the shot before`);
      return {
        ...before,
        start: before.path.at(-1) ?? before.start,
        facing: before.facing,
        path: actor.path,
        faces: actor.faces,
        condition: conditionAfter(previous, before),
        carried: true,
      };
    }
  }
}

function npcId(sector: string, npc: string): string {
  return `npc:${sector}/${npc}`;
}

function findNPC(sectors: readonly Sector[], id: string): Sector['npcs'][number] | undefined {
  for (const sector of sectors) {
    const npc = sector.npcs.find((candidate) => npcId(sector.name, candidate.id) === id);
    if (npc !== undefined) return npc;
  }
  return undefined;
}

/** How an actor stands once its shot has played through. */
function conditionAfter(shot: StagedShot, actor: StagedActor): Condition {
  let condition = actor.condition;
  for (const beat of shot.beats) {
    if (beat.kind === 'condition' && beat.id === actor.id) condition = beat.condition;
  }
  return condition;
}

/** Where an actor stands `seconds` into its shot, walking its path at its own speed and stopping at the end. */
export function pathPoint(actor: StagedActor, seconds: number): Point {
  let left = Math.max(seconds, 0) * actor.metresPerSecond;
  let from = actor.start;
  for (const to of actor.path) {
    const length = distance(from, to);
    if (left < length) return { x: from.x + ((to.x - from.x) * left) / length, z: from.z + ((to.z - from.z) * left) / length };
    left -= length;
    from = to;
  }
  return from;
}

/** How long an actor takes to walk its whole path. */
export function pathSeconds(actor: StagedActor): number {
  let length = 0;
  let from = actor.start;
  for (const to of actor.path) {
    length += distance(from, to);
    from = to;
  }
  return actor.metresPerSecond === 0 ? 0 : length / actor.metresPerSecond;
}

/** Eases in and out, so a push-in or a pan starts and settles gently. */
function eased(share: number): number {
  const clamped = clamp(share, 0, 1);
  return clamped * clamped * (3 - 2 * clamped);
}

/**
 * The camera focus that draws `subject` beside the card: horizontally midway between the widest
 * card's edge and the viewport's edge on `side`, and `drop` half-heights below the middle. Screen
 * axes run `x` right and `y` down. A screen-down distance on the ground is longer than on the screen
 * by 1/sin(pitch), because the camera looks down at the ground at that pitch.
 */
export function shotFocus(subject: Point, side: 'left' | 'right', drop: number, scale: number, viewport: Viewport): Point {
  const halfHeight = viewport.height / 2;
  const across = (PRE_LOGIN_CARD.width / 2 + viewport.width / 2) / 2;
  const x = ((side === 'right' ? 1 : -1) * across) / halfHeight;
  const pitch = (ORTHO_RIG.pitchDegrees * Math.PI) / 180;
  const offset = worldMovement(x * scale, (drop * scale) / Math.sin(pitch));
  return { x: subject.x - offset.dx, z: subject.z - offset.dz };
}

/** Where the camera looks and at what scale, `seconds` into a shot. */
export function shotFraming(shot: StagedShot, seconds: number, viewport: Viewport): { focus: Point; scale: number } {
  const share = eased(seconds / shot.seconds);
  const camera = shot.camera;
  if (camera.kind === 'area') {
    const lerp = (from: number, to: number): number => from + (to - from) * share;
    return {
      focus: { x: lerp(camera.from.point.x, camera.to.point.x), z: lerp(camera.from.point.z, camera.to.point.z) },
      scale: lerp(camera.from.scale, camera.to.scale),
    };
  }
  const scale = camera.scale.from + (camera.scale.to - camera.scale.from) * share;
  return { focus: shotFocus(subjectPoint(shot, camera.subject, seconds), camera.side, camera.drop, scale, viewport), scale };
}

/** Where a shot's subject stands `seconds` in: its actor's place on its path, or the fixed point it names. */
function subjectPoint(shot: StagedShot, subject: string | Point, seconds: number): Point {
  if (typeof subject !== 'string') return subject;
  const actor = shot.actors.find((candidate) => candidate.id === subject);
  if (actor === undefined) throw new Error(`splash shot ${shot.id}: no subject ${subject}`);
  return pathPoint(actor, seconds);
}

/** The world seconds lighting a shot `seconds` in. */
export function shotWorldSeconds(shot: StagedShot, seconds: number): number {
  const hour = typeof shot.hour === 'number' ? shot.hour : shot.hour.from + (shot.hour.to - shot.hour.from) * Math.min(seconds / shot.seconds, 1);
  return hour * 3600;
}
