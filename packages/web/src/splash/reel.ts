import {
  OUTDOOR_SPACE_ID,
  SOMNIO_CONSTANTS,
  clamp,
  dialogSteps,
  distance,
  gaitMetresPerSecond,
  localizedDialogLine,
  monsterKind,
  sectorPointInSpace,
} from '@somnio/core';
import type { Heading, ModelRegistry, Point, Sector } from '@somnio/core';
import type { Condition, Gait, SpeechKind } from '@somnio/protocol';
import type { RaiseProgress } from '@/client/renderSurface';
import { currentLocale, t } from '@/i18n';
import { ORTHO_RIG, clampedScale, worldMovement } from '@/scene/cameraRig';

/**
 * The splash reel: a fixed sequence of short shots of the committed world, staged in the browser
 * with scripted dreamers, NPCs, and nightmares. Positions are in the coordinates of the shot's
 * space, so an outdoor point carries its sector's origin and the North Wood lies at negative `z`.
 */

/** How long the dip to dark between two shots takes, half of it falling and half rising. */
export const DIP_SECONDS = 0.5;

/** The widest pre-login card (Sign Up) and the tallest, in CSS pixels; every one is centred. */
export const PRE_LOGIN_CARD = { width: 560, height: 294 } as const;

/**
 * Where the wordmark band runs: from this far below the top edge to this far above the tallest card.
 * The wordmark drawn in it (`.splash-wordmark__image` in `chrome.css`) is narrower than the card, so
 * beside the card's column the world shows from the top edge down.
 */
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
  /**
   * Keeps `subject`, an actor id or a fixed point, beside the card on `side`, `drop` half-heights
   * below the middle. On a window whose strip beside the card holds less than `span` metres of ground
   * across at `scale`, the camera pulls back, as far as the scene draws.
   */
  | { kind: 'subject'; subject: string | Point; side: 'left' | 'right'; drop: number; scale: { from: number; to: number }; span: number }
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
const PUGNAX = 'npc:EdariaFighterHall/pugnax';
const LIBUS = 'npc:EdariaLibrary/libus';
const QUIETA = 'npc:EdariaInn/quieta';
const GHOST = 'monster:splash-1';
const NORTH_WOOD_SPAWN = { sector: 'NorthWood', id: 'spawn-1' };

/** The reel in the order it plays. Every scripted path is a straight run between points the reel test proves legal. */
export const SPLASH_REEL: readonly SplashShot[] = [
  {
    id: 'town',
    space: OUTDOOR_SPACE_ID,
    seconds: 7,
    hour: 10,
    camera: { kind: 'area', from: { point: { x: 18.5, z: 20.8 }, scale: 6.35 }, to: { point: { x: 22.5, z: 19.6 }, scale: 6.35 } },
    actors: [
      {
        kind: 'peer',
        id: TAMO,
        name: 'Tamo',
        at: { x: 9, z: 20.5 },
        facing: 90,
        gait: 'jog',
        path: [
          { x: 16, z: 20.5 },
          { x: 17.6, z: 23 },
          { x: 17.6, z: 27 },
        ],
      },
      {
        kind: 'peer',
        id: LINNEA,
        name: 'Linnea',
        at: { x: 23.5, z: 14 },
        facing: 0,
        gait: 'jog',
        path: [
          { x: 23.5, z: 17 },
          { x: 26, z: 18.5 },
          { x: 31, z: 18.5 },
        ],
      },
      {
        kind: 'peer',
        id: ODO,
        name: 'Odo',
        at: { x: 29.5, z: 22.6 },
        facing: 270,
        gait: 'run',
        path: [
          { x: 23, z: 22.6 },
          { x: 18, z: 22.6 },
          { x: 13, z: 21 },
        ],
      },
    ],
    beats: [],
  },
  {
    id: 'follow-dreamer',
    space: OUTDOOR_SPACE_ID,
    seconds: 7,
    hour: 11,
    camera: { kind: 'subject', subject: AUREL, side: 'right', drop: 0.2, scale: { from: 2.5, to: 2.5 }, span: 1.25 },
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
    space: 'EdariaFighterHall',
    seconds: 7,
    hour: 12,
    camera: { kind: 'subject', subject: PUGNAX, side: 'right', drop: 0.05, scale: { from: 2.6, to: 2.6 }, span: 2 },
    actors: [
      { kind: 'npc', sector: 'EdariaFighterHall', npc: 'pugnax' },
      { kind: 'peer', id: MIRA, name: 'Mira', at: { x: 3.84, z: 6.88 }, facing: 180, gait: 'jog', path: [{ x: 3.4, z: 2.9 }], faces: PUGNAX },
    ],
    beats: [{ at: 2.1, kind: 'greeting', npc: PUGNAX, listener: 'Mira' }],
  },
  {
    id: 'speech',
    space: OUTDOOR_SPACE_ID,
    seconds: 7,
    hour: 14,
    camera: { kind: 'subject', subject: { x: 21.8, z: 22.6 }, side: 'left', drop: 0.1, scale: { from: 2.8, to: 2.6 }, span: 1.5 },
    actors: [
      { kind: 'peer', id: TAMO, name: 'Tamo', at: { x: 21.55, z: 22.77 }, facing: 120, gait: 'jog', path: [] },
      { kind: 'peer', id: LINNEA, name: 'Linnea', at: { x: 22.05, z: 22.43 }, facing: 300, gait: 'jog', path: [] },
      { kind: 'peer', id: ODO, name: 'Odo', at: { x: 22.32, z: 23.34 }, facing: 180, gait: 'jog', path: [] },
    ],
    beats: [
      { at: 0.6, kind: 'speech', speaker: TAMO, speech: 'say', text: () => t('Anyone up for the North Wood?') },
      { at: 2.4, kind: 'speech', speaker: ODO, speech: 'yell', text: () => t('Watch out, nightmares about!') },
      { at: 4.2, kind: 'speech', speaker: LINNEA, speech: 'whisper', text: () => t('Meet me at the inn.') },
    ],
  },
  {
    id: 'follow-nightmare',
    space: OUTDOOR_SPACE_ID,
    seconds: 6,
    hour: 13,
    camera: { kind: 'subject', subject: GHOST, side: 'left', drop: 0.2, scale: { from: 2.6, to: 2.6 }, span: 1.25 },
    actors: [
      {
        kind: 'monster',
        id: GHOST,
        spawn: NORTH_WOOD_SPAWN,
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
    camera: { kind: 'subject', subject: AUREL, side: 'left', drop: 0.15, scale: { from: 2.6, to: 2.4 }, span: 1.75 },
    actors: [
      { kind: 'peer', id: AUREL, name: 'Aurel', at: { x: 19, z: -46.6 }, facing: 35, gait: 'jog', path: [], faces: GHOST },
      { kind: 'carried', id: GHOST, path: [], faces: AUREL },
    ],
    beats: [
      { at: 0.5, kind: 'blow', attacker: GHOST, target: AUREL, hit: true },
      { at: 0.5, kind: 'condition', id: AUREL, condition: 'grazed' },
      { at: 0.8, kind: 'blow', attacker: AUREL, target: GHOST, hit: false },
      { at: 1.8, kind: 'blow', attacker: AUREL, target: GHOST, hit: true },
      { at: 1.8, kind: 'condition', id: GHOST, condition: 'grazed' },
      { at: 2, kind: 'blow', attacker: GHOST, target: AUREL, hit: true },
      { at: 2, kind: 'condition', id: AUREL, condition: 'wounded' },
      { at: 2.8, kind: 'blow', attacker: AUREL, target: GHOST, hit: false },
      { at: 3.5, kind: 'blow', attacker: GHOST, target: AUREL, hit: true },
      { at: 3.5, kind: 'condition', id: AUREL, condition: 'hurt' },
      { at: 3.8, kind: 'blow', attacker: AUREL, target: GHOST, hit: true },
      { at: 4.8, kind: 'blow', attacker: AUREL, target: GHOST, hit: false },
      { at: 5, kind: 'blow', attacker: GHOST, target: AUREL, hit: true },
      { at: 5, kind: 'condition', id: AUREL, condition: 'failing' },
      { at: 5.8, kind: 'blow', attacker: AUREL, target: GHOST, hit: true },
      { at: 6.5, kind: 'blow', attacker: GHOST, target: AUREL, hit: true },
      { at: 6.5, kind: 'condition', id: AUREL, condition: 'fallen' },
    ],
  },
  {
    id: 'raise',
    space: OUTDOOR_SPACE_ID,
    seconds: 8,
    hour: 13,
    camera: { kind: 'subject', subject: AUREL, side: 'left', drop: 0.3, scale: { from: 2.4, to: 2.4 }, span: 1.75 },
    actors: [
      { kind: 'carried', id: AUREL, path: [] },
      { kind: 'carried', id: GHOST, path: [{ x: 17.5, z: -48.5 }] },
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
    camera: { kind: 'subject', subject: QUIETA, side: 'left', drop: -0.05, scale: { from: 2.6, to: 2.6 }, span: 2 },
    actors: [
      { kind: 'npc', sector: 'EdariaInn', npc: 'quieta' },
      {
        kind: 'peer',
        id: ODO,
        name: 'Odo',
        at: { x: 5.2, z: 7.1 },
        facing: 270,
        gait: 'jog',
        path: [
          { x: 2.1, z: 7.1 },
          { x: 1.7, z: 5.7 },
        ],
        faces: QUIETA,
      },
    ],
    beats: [{ at: 2.4, kind: 'greeting', npc: QUIETA, listener: 'Odo' }],
  },
  {
    id: 'library',
    space: 'EdariaLibrary',
    seconds: 6,
    hour: 12,
    camera: { kind: 'subject', subject: LIBUS, side: 'right', drop: 0.2, scale: { from: 3.3, to: 3.3 }, span: 2.5 },
    actors: [
      { kind: 'npc', sector: 'EdariaLibrary', npc: 'libus' },
      {
        kind: 'peer',
        id: LINNEA,
        name: 'Linnea',
        at: { x: 2.56, z: 6.88 },
        facing: 180,
        gait: 'jog',
        path: [{ x: 4.3, z: 5.0 }],
        faces: LIBUS,
      },
    ],
    beats: [{ at: 1.4, kind: 'greeting', npc: LIBUS, listener: 'Linnea' }],
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
      return {
        at: beat.at,
        kind: 'speech',
        speaker: beat.npc,
        speech: 'say',
        text: () => localizedDialogLine(dialogSteps(npc.dialogScript)[0] ?? '', currentLocale(), beat.listener),
      };
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

/** Where the camera looks and at what scale, `seconds` into a shot. Its scale is clamped as the scene clamps it, so the focus puts the subject where the scene draws it. */
export function shotFraming(shot: StagedShot, seconds: number, viewport: Viewport): { focus: Point; scale: number } {
  const share = eased(seconds / shot.seconds);
  const camera = shot.camera;
  if (camera.kind === 'area') {
    const lerp = (from: number, to: number): number => from + (to - from) * share;
    return {
      focus: { x: lerp(camera.from.point.x, camera.to.point.x), z: lerp(camera.from.point.z, camera.to.point.z) },
      scale: clampedScale(lerp(camera.from.scale, camera.to.scale)),
    };
  }
  // Beside a card at least as wide as the window there is no strip, so the camera pulls back as far as it goes.
  const strip = (viewport.width - PRE_LOGIN_CARD.width) / 2;
  const floor = strip > 0 ? (camera.span * viewport.height) / (2 * strip) : ORTHO_RIG.maxScale;
  const scale = clampedScale(Math.max(camera.scale.from + (camera.scale.to - camera.scale.from) * share, floor));
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
