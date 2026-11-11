import { describe, expect, it } from 'vitest';
import { bundledModelRegistry, distance, headingFromVector, isLegalMove, rasterizeWalkable, reaches, resolveDoor, sectorView } from '@somnio/core';
import type { EffectId, Point } from '@somnio/core';
import type { SectorView, SomnioMessage } from '@somnio/protocol';
import {
  ClientWorld,
  FACING_EMIT_THRESHOLD_DEGREES,
  GameplayPredictor,
  MAX_TICK_ELAPSED_MS,
  PATH_FOLLOWING,
  POSITION_HEARTBEAT_INTERVAL_MS,
  RemoteInterpolation,
  entityBlockers,
  noopRenderSurface,
} from '@/client';
import type { ClientEntity, ConnectionState, OverlayKind, PredictorSession } from '@/client';
import { loadSectorFixtures } from '../../core/test/support/sectorFixture.ts';
import { TEST_REGISTRY, outdoorSector } from '../../core/test/support/worldFixture.ts';
import { clientEntity, makeDoor } from './helpers/worldFixture';

/**
 * Deterministic prediction-tick suite. Positional expectations are derived here from the gait
 * speeds and the directions walked, never by running the predictor's own arithmetic, so the suite
 * catches the predictor drifting from the shared `@somnio/core` movement rules.
 */

const YAW = (35 * Math.PI) / 180;
/** Heading 215, under the camera's 35-degree yaw. */
const UP_SCREEN = { x: -Math.sin(YAW), z: -Math.cos(YAW) };
/** Heading 35. */
const DOWN_SCREEN = { x: Math.sin(YAW), z: Math.cos(YAW) };

const START = { x: 10, z: 10 };

function along(direction: { x: number; z: number }, metres: number, from: Point = START): Point {
  return { x: from.x + direction.x * metres, z: from.z + direction.z * metres };
}

/** A point a metre from `from` at `facing` degrees (0 south, 90 east). */
function toward(facing: number, from: Point = START): Point {
  const radians = (facing * Math.PI) / 180;
  return { x: from.x + Math.sin(radians), z: from.z + Math.cos(radians) };
}

function self(overrides: Partial<ClientEntity> = {}): ClientEntity {
  return clientEntity({ position: START, facing: 210, ...overrides });
}

interface Rig {
  predictor: GameplayPredictor;
  session: PredictorSession & {
    connectionState: ConnectionState;
    presentedOverlay: OverlayKind | undefined;
  };
  world: ClientWorld;
  interpolation: RemoteInterpolation;
  sent: SomnioMessage[];
  /** The tick time each `move` was sent on. */
  moveTimes: number[];
  /** What the player faces; `undefined` faces the way they walk. */
  lookAt: Point | undefined;
  running: boolean;
  winded: boolean;
  effects: EffectId[];
  fallen: boolean;
  /** Whether a swing is slowing the player. */
  slowed: boolean;
  /** Whether a channel of the player's holds them still. */
  heldStill: boolean;
  self(): ClientEntity;
  moves(): Point[];
  /** Steers toward a point far along `direction` from where the player stands. */
  steer(direction: { x: number; z: number }): void;
}

function makeRig(options: { sector?: Partial<SectorView>; entities?: ClientEntity[]; world?: ClientWorld } = {}): Rig {
  const entities = new Map<string, ClientEntity>();
  for (const each of options.entities ?? [self()]) entities.set(each.id, each);
  const sent: SomnioMessage[] = [];
  const moveTimes: number[] = [];
  const world = options.world ?? new ClientWorld('outdoors', TEST_REGISTRY);
  if (options.world === undefined) world.addSector(outdoorSector('Meadow', { x: 0, z: 0 }, options.sector));
  const interpolation = new RemoteInterpolation();
  let tickTime = 0;

  // Typed through the mutable shape the rig exposes, so a test assigning a bogus state or overlay is
  // a compile error rather than a silently-closed gate.
  const session: Rig['session'] = {
    connectionState: 'attached',
    presentedOverlay: undefined,
    entities,
    selfId: 'self',
    world,
  };

  const rig: Rig = {
    predictor: undefined as unknown as GameplayPredictor,
    session,
    world,
    interpolation,
    sent,
    moveTimes,
    lookAt: undefined,
    running: false,
    winded: false,
    effects: [],
    fallen: false,
    slowed: false,
    heldStill: false,
    self: () => {
      const found = entities.get('self');
      if (found === undefined) throw new Error('self entity missing');
      return found;
    },
    moves: () => sent.flatMap((message) => (message.tag === 'move' ? [{ x: message.payload.x, z: message.payload.z }] : [])),
    steer: (direction) => rig.predictor.steerToward(along(direction, 50, rig.self().position)),
  };

  const predictor = new GameplayPredictor({
    session,
    renderSurface: noopRenderSurface,
    interpolation,
    send: (message) => {
      sent.push(message);
      if (message.tag === 'move') moveTimes.push(tickTime);
    },
    lookAt: () => rig.lookAt,
    running: () => rig.running,
    winded: () => rig.winded,
    effects: () => rig.effects,
    fallen: () => rig.fallen,
    slowed: () => rig.slowed,
    heldStill: () => rig.heldStill,
  });
  rig.predictor = predictor;
  const runTick = predictor.runTick.bind(predictor);
  predictor.runTick = (nowMs: number): void => {
    tickTime = nowMs;
    runTick(nowMs);
  };
  return rig;
}

/** Runs the priming tick plus `steps` further ticks spaced `stepMs` apart. */
function runTicks(rig: Rig, steps: number, stepMs: number): void {
  rig.predictor.runTick(0);
  for (let index = 1; index <= steps; index += 1) {
    rig.predictor.runTick(index * stepMs);
  }
}

/** Ticks every `stepMs` from `fromMs` until the walk ends, failing past `limitMs`; answers when it ended. */
function tickUntilWalkEnds(rig: Rig, stepMs: number, fromMs = 0, limitMs = 30_000): number {
  for (let time = fromMs; time <= limitMs; time += stepMs) {
    rig.predictor.runTick(time);
    if (rig.predictor.walk === undefined) return time;
  }
  throw new Error('the walk never ended');
}

function expectAt(actual: Point, expected: Point): void {
  expect(actual.x).toBeCloseTo(expected.x, 9);
  expect(actual.z).toBeCloseTo(expected.z, 9);
}

/** Every report a legal move from the one before it, the server's own test, starting from `from`. */
function expectLegalReports(rig: Rig, from: Point, npcs: { x: number; z: number; radius: number }[] = []): void {
  const reports = [from, ...rig.moves()];
  for (let index = 1; index < reports.length; index += 1) {
    expect(isLegalMove(rig.world.collision, reports[index - 1]!, reports[index]!, 0.3, npcs), `report ${index}`).toBe(true);
  }
}

describe('elapsed-time handling', () => {
  it('does not move on the first tick, having no previous timestamp to measure from', () => {
    const rig = makeRig();
    rig.steer(UP_SCREEN);

    rig.predictor.runTick(0);

    expect(rig.self().position).toEqual(START);
  });

  it('jogs two metres a second by default', () => {
    const rig = makeRig();
    rig.steer(UP_SCREEN);

    runTicks(rig, 4, 16);

    expectAt(rig.self().position, along(UP_SCREEN, 2 * 0.064));
    expect(rig.self().gait).toBe('jog');
  });

  it('advances by the same distance whether one 100 ms tick or a 5 s stall is reported', () => {
    const stalled = makeRig();
    const clamped = makeRig();
    stalled.steer(UP_SCREEN);
    clamped.steer(UP_SCREEN);

    stalled.predictor.runTick(0);
    stalled.predictor.runTick(5000);
    clamped.predictor.runTick(0);
    clamped.predictor.runTick(MAX_TICK_ELAPSED_MS);

    // A single tick is clamped to 100 ms. Without the clamp the stalled rig would teleport
    // fifty times further.
    expectAt(stalled.self().position, along(UP_SCREEN, 0.2));
    expect(clamped.self().position).toEqual(stalled.self().position);
  });

  it('runs three metres a second while Run is on', () => {
    const rig = makeRig();
    rig.running = true;
    rig.steer(UP_SCREEN);

    runTicks(rig, 3, 100);

    expectAt(rig.self().position, along(UP_SCREEN, 0.9));
    expect(rig.self().gait).toBe('run');
  });

  it('jogs when standing still with Run on, and reports no run', () => {
    const rig = makeRig();
    rig.running = true;
    rig.lookAt = toward(90);

    runTicks(rig, 2, 100);

    expect(rig.self().gait).toBe('jog');
    expect(rig.sent.at(-1)).toMatchObject({ tag: 'move', payload: { gait: 'jog' } });
  });
});

describe('facing', () => {
  it('faces the cursor while walking another way, at the pace of that direction', () => {
    const strafing = makeRig();
    const backing = makeRig();
    // Walking heading 215: the cursor at 125 is a quarter turn to the side, at 35 straight behind.
    strafing.lookAt = toward(125);
    backing.lookAt = toward(35);
    strafing.steer(UP_SCREEN);
    backing.steer(UP_SCREEN);

    runTicks(strafing, 1, 100);
    runTicks(backing, 1, 100);

    expect(strafing.self().facing).toBeCloseTo(125, 9);
    expectAt(strafing.self().position, along(UP_SCREEN, 0.2 * 0.7));
    expect(backing.self().facing).toBeCloseTo(35, 9);
    expectAt(backing.self().position, along(UP_SCREEN, 0.1));
  });

  it('turns toward the cursor while standing still', () => {
    const rig = makeRig();
    rig.lookAt = toward(300);

    rig.predictor.runTick(0);

    expect(rig.self().facing).toBeCloseTo(300, 9);
    expect(rig.self().position).toEqual(START);
  });

  it('faces the way it walks with nothing to look at, and keeps its facing once it stands', () => {
    const rig = makeRig();
    rig.predictor.walkTo(along(DOWN_SCREEN, 0.5));

    runTicks(rig, 1, 100);
    expect(rig.self().facing).toBeCloseTo(35, 9);

    tickUntilWalkEnds(rig, 100, 200);
    rig.predictor.runTick(10_000);
    expect(rig.self().facing).toBeCloseTo(35, 9);
  });

  /** A coarse pointer has no cursor; the session hands the predictor the target to look at, which it faces whichever way it walks. */
  it('faces what it is given to look at whichever way it walks', () => {
    const rig = makeRig();
    const target = { x: START.x + 3, z: START.z };
    rig.lookAt = target;
    rig.steer(DOWN_SCREEN);

    runTicks(rig, 2, 100);
    const at = rig.self().position;
    rig.predictor.runTick(300);

    // Facing is taken before the tick's step, from where the player stood.
    expect(distance(at, START)).toBeGreaterThan(0);
    expect(rig.self().facing).toBeCloseTo(headingFromVector(target.x - at.x, target.z - at.z), 9);
  });
});

describe('a path', () => {
  it('walks to the destination straight across open ground and ends the walk there', () => {
    const rig = makeRig();
    const destination = along(UP_SCREEN, 1.5);
    rig.predictor.walkTo(destination);

    const ended = tickUntilWalkEnds(rig, 50);

    expect(distance(rig.self().position, destination)).toBeLessThanOrEqual(PATH_FOLLOWING.arrivalMetres);
    // 1.5 m at 2 m/s: the walk ends on the tick that arrives, three quarters of a second in.
    expect(ended).toBe(750);
  });

  it('goes round a wall in its way rather than into it', () => {
    const wall = { id: 'wall', x: 8, z: 11, width: 4, depth: 0.5 };
    const rig = makeRig({ sector: { blockers: [wall] } });
    const destination = { x: 10, z: 13 };
    rig.predictor.walkTo(destination);

    tickUntilWalkEnds(rig, 50);

    expect(distance(rig.self().position, destination)).toBeLessThanOrEqual(PATH_FOLLOWING.arrivalMetres);
    expectLegalReports(rig, START);
  });

  /** The fallen peer stands on a cell corner, so the cell under each tap has its centre within the margin round them. */
  it.each([
    { metres: 0.55, side: 'east', tap: { x: 12.55, z: 10 } },
    { metres: 0.7, side: 'east', tap: { x: 12.7, z: 10 } },
    { metres: 0.55, side: 'north', tap: { x: 12, z: 9.45 } },
    { metres: 0.7, side: 'north', tap: { x: 12, z: 9.3 } },
  ])('ends a tap on the ground $metres m $side of a fallen peer within touch of them', ({ tap }) => {
    const fallen = clientEntity({ id: 'peer', kind: 'peer', position: { x: 12, z: 10 }, condition: 'fallen' });
    const rig = makeRig({ entities: [self(), fallen] });
    rig.predictor.walkTo(tap);

    tickUntilWalkEnds(rig, 50);

    expect(reaches(rig.self().position, { ...fallen.position, radius: fallen.radius })).toBe(true);
    expectLegalReports(rig, START);
  });

  it('is replaced by a new destination', () => {
    const rig = makeRig();
    rig.predictor.walkTo(along(UP_SCREEN, 5));
    runTicks(rig, 2, 100);

    const destination = along(DOWN_SCREEN, 1, rig.self().position);
    rig.predictor.walkTo(destination);
    tickUntilWalkEnds(rig, 50, 300);

    expect(distance(rig.self().position, destination)).toBeLessThanOrEqual(PATH_FOLLOWING.arrivalMetres);
  });

  it('ends with a stop', () => {
    const rig = makeRig();
    rig.predictor.walkTo(along(UP_SCREEN, 5));
    runTicks(rig, 2, 100);
    const stopped = rig.self().position;

    rig.predictor.stop();
    runTicks(rig, 3, 100);

    expect(rig.self().position).toEqual(stopped);
  });

  it('waits for a way while its sector has no walk raster yet, then walks', () => {
    const answers: (() => void)[] = [];
    const world = new ClientWorld('outdoors', TEST_REGISTRY, { rasterize: (inputs, done) => answers.push(() => done(rasterizeWalkable(inputs))) });
    world.addSector(sectorView(outdoorSector('Meadow', { x: 0, z: 0 })));
    const rig = makeRig({ world });
    rig.predictor.walkTo(along(UP_SCREEN, 1));

    rig.predictor.runTick(0);
    expect(rig.predictor.walk).toMatchObject({ kind: 'path', waypoints: [], searchAtMs: PATH_FOLLOWING.retryMs });

    for (const answer of answers) answer();
    tickUntilWalkEnds(rig, 50, 250);
    expect(distance(rig.self().position, along(UP_SCREEN, 1))).toBeLessThanOrEqual(PATH_FOLLOWING.arrivalMetres);
  });
});

describe('re-planning', () => {
  it('searches again round a body that steps into its leg, and arrives', () => {
    const rig = makeRig();
    const destination = { x: 14, z: 10 };
    rig.predictor.walkTo(destination);
    runTicks(rig, 2, 100);
    // A dreamer steps onto the line ahead, a body this client stops at.
    rig.session.entities.set('peer', clientEntity({ id: 'peer', kind: 'peer', position: { x: 11.2, z: 10 } }));

    let searches = 0;
    for (let time = 300; rig.predictor.walk !== undefined && time < 10_000; time += 50) {
      rig.predictor.runTick(time);
      if (rig.predictor.walk?.kind === 'path') searches = rig.predictor.walk.searches;
    }

    expect(searches).toBe(2);

    expect(distance(rig.self().position, destination)).toBeLessThanOrEqual(PATH_FOLLOWING.arrivalMetres);
    expect(distance(rig.self().position, { x: 11.2, z: 10 })).toBeGreaterThan(0.6);
  });

  /** Eight dreamers ring the player at touching distance, so no step leads anywhere a body may go. */
  function boxedIn(): Rig {
    const ring = Array.from({ length: 8 }, (_, index) => {
      const step = toward(index * 45);
      return clientEntity({ id: `peer-${index}`, kind: 'peer', position: along({ x: step.x - START.x, z: step.z - START.z }, 0.6) });
    });
    return makeRig({ entities: [self(), ...ring] });
  }

  it('waits and tries again while boxed in, four times, then ends the walk where it stands', () => {
    const rig = boxedIn();
    rig.predictor.walkTo({ x: 14, z: 10 });

    const searchedAt: number[] = [];
    let searches = 0;
    for (let time = 0; rig.predictor.walk !== undefined; time += 50) {
      rig.predictor.runTick(time);
      const walk = rig.predictor.walk;
      if (walk?.kind === 'path' && walk.searches !== searches) {
        searches = walk.searches;
        searchedAt.push(time);
      }
      if (time > 5000) throw new Error('the walk never ended');
    }

    expect(searchedAt).toEqual([0, 250, 500, 750, 1000]);
    expect(1 + PATH_FOLLOWING.maxReplans).toBe(5);
    expect(rig.self().position).toEqual(START);
  });

  it('walks on once the bodies boxing it in step away', () => {
    const rig = boxedIn();
    const destination = { x: 14, z: 10 };
    rig.predictor.walkTo(destination);
    runTicks(rig, 6, 50);
    for (let index = 0; index < 8; index += 1) rig.session.entities.delete(`peer-${index}`);

    tickUntilWalkEnds(rig, 50, 350);

    expect(distance(rig.self().position, destination)).toBeLessThanOrEqual(PATH_FOLLOWING.arrivalMetres);
  });
});

describe('a path through the committed square', () => {
  const registry = bundledModelRegistry();
  const outdoor = loadSectorFixtures().filter((sector) => sector.kind === 'outdoor');
  const square = outdoor.find((sector) => sector.name === 'EdariaSquare')!;
  const libraryDoor = resolveDoor(
    square,
    square.doors.find((door) => door.id === 'to-edarialibrary')!,
    registry,
  )!;

  it.each([
    { name: 'from the Library door to the well', from: libraryDoor.arrival, to: { x: 20.5, z: 22.5 } },
    { name: 'round the townhall', from: { x: 31.5, z: 2 }, to: { x: 38, z: 9.5 } },
  ])('is walked $name with only moves the server accepts', ({ from, to }) => {
    const world = new ClientWorld('outdoors', registry);
    for (const sector of outdoor) world.addSector(sectorView(sector));
    const rig = makeRig({ world, entities: [self({ position: from })] });
    rig.running = true;
    rig.predictor.walkTo(to);

    tickUntilWalkEnds(rig, 16);

    expect(distance(rig.self().position, to)).toBeLessThanOrEqual(PATH_FOLLOWING.arrivalMetres);
    expectLegalReports(rig, from);
  });
});

describe('collision resolution', () => {
  /** A wall whose east face is one body radius west of the player, so no step west is clear. */
  const westWall = { id: 'west-wall', x: 8.7, z: 5, width: 1, depth: 10 };

  it('slides a steer along a blocked axis instead of sticking', () => {
    const rig = makeRig({ sector: { blockers: [westWall] } });
    rig.steer(UP_SCREEN);

    runTicks(rig, 1, 100);

    // West is refused, north commits: the player glides up the wall's face.
    expectAt(rig.self().position, { x: START.x, z: START.z + UP_SCREEN.z * 0.2 });
  });

  it('treats a peer as solid', () => {
    const peer = clientEntity({ id: 'peer', kind: 'peer', name: 'Peer', position: along(UP_SCREEN, 0.62) });
    const rig = makeRig({ entities: [self(), peer] });
    rig.steer(UP_SCREEN);

    runTicks(rig, 3, 100);

    // A peer is a body the player stops at and slides round, never one walked through.
    expect(distance(rig.self().position, peer.position)).toBeGreaterThanOrEqual(0.6 - 1e-6);
  });

  it('lets the player walk free of a monster already overlapping them', () => {
    const overlapping = clientEntity({ id: 'monster:1', kind: 'monster', characterModelId: 'ghost', position: along(UP_SCREEN, 0.2) });
    const rig = makeRig({ entities: [self(), overlapping] });
    rig.steer(UP_SCREEN);

    runTicks(rig, 1, 100);

    // Soft-solid: a block here would hold the player in place, because monsters chase on the
    // server's tick and can lag onto the player's own body.
    expectAt(rig.self().position, along(UP_SCREEN, 0.2));
  });

  /** Where a dreamer stood in the Arena with a body drawn on either side of them, and where they retreated to. */
  const PRESSED = { x: 2.882, z: 3.375 };
  const RETREAT = { x: 9, z: 3.4 };

  function pressedInTheArena(): Rig {
    const arena = loadSectorFixtures().find((sector) => sector.name === 'EdariaArena')!;
    const world = new ClientWorld('EdariaArena', bundledModelRegistry());
    world.addSector(sectorView(arena));
    const peers = [-0.08, 0.08].map((offset, index) => clientEntity({ id: `peer-${index}`, kind: 'peer', position: { x: PRESSED.x + offset, z: PRESSED.z } }));
    return makeRig({ world, entities: [self({ position: PRESSED }), ...peers] });
  }

  it('steers out from between two peers it overlaps on opposite sides', () => {
    const rig = pressedInTheArena();
    rig.predictor.steerToward(RETREAT);

    runTicks(rig, 5, 100);

    expect(rig.self().position.x).toBeGreaterThan(PRESSED.x + 0.9);
    expectLegalReports(rig, PRESSED);
  });

  it('walks a path out from between two peers it overlaps on opposite sides, and arrives', () => {
    const rig = pressedInTheArena();
    rig.predictor.walkTo(RETREAT);

    tickUntilWalkEnds(rig, 16);

    expect(distance(rig.self().position, RETREAT)).toBeLessThanOrEqual(PATH_FOLLOWING.arrivalMetres);
    expectLegalReports(rig, PRESSED);
  });

  it('sorts the entities into contact-blocking NPCs and the bodies only this client stops at', () => {
    const player = self();
    const npc = clientEntity({ id: 'npc:Meadow/wirt', kind: 'npc', position: { x: 12, z: 10 } });
    const peer = clientEntity({ id: 'peer', kind: 'peer', position: { x: 10.1, z: 10 } });
    const clear = clientEntity({ id: 'monster:1', kind: 'monster', position: { x: 14, z: 10 }, radius: 0.4 });
    const overlapping = clientEntity({ id: 'monster:2', kind: 'monster', position: { x: 10.5, z: 10 } });

    const blockers = entityBlockers([player, npc, peer, clear, overlapping], player);

    // The distinction between the two monsters is the whole of "soft-solid": one is a body, the
    // other is dropped. An overlapping peer stays, and blocks only a step that closes on it.
    expect(blockers.npcs).toEqual([{ x: 12, z: 10, radius: 0.3 }]);
    expect(blockers.bodies.map((body) => body.radius)).toEqual([0.3, 0.4]);
  });

  it('keeps a fallen peer solid, and drops a nightmare that is fading', () => {
    const player = self();
    const fallen = clientEntity({ id: 'peer', kind: 'peer', position: { x: 12, z: 10 }, condition: 'fallen' });
    const fading = clientEntity({ id: 'monster:1', kind: 'monster', position: { x: 14, z: 10 }, condition: 'fallen' });

    const blockers = entityBlockers([player, fallen, fading], player);

    expect(blockers.bodies).toEqual([{ x: 12, z: 10, radius: 0.3 }]);
  });

  it('stops at a peer where it is drawn, halfway through its glide', () => {
    // The peer was last reported three metres to the west and is gliding there from three metres to
    // the east; at 50 ms it is drawn in the middle, right in the player's path.
    const middle = along(UP_SCREEN, 0.62);
    const peer = clientEntity({ id: 'peer', kind: 'peer', name: 'Peer', position: { x: middle.x + 3, z: middle.z } });
    const blocked = makeRig({ entities: [self(), peer] });
    const control = makeRig({ entities: [self(), peer] });
    blocked.interpolation.retarget('peer', peer.position, { x: middle.x - 3, z: middle.z }, 0);
    blocked.steer(UP_SCREEN);
    control.steer(UP_SCREEN);

    blocked.predictor.runTick(0);
    blocked.predictor.runTick(50);
    control.predictor.runTick(0);
    control.predictor.runTick(50);

    expectAt(blocked.session.entities.get('peer')!.position, middle);
    expect(distance(blocked.self().position, middle)).toBeGreaterThanOrEqual(0.6 - 1e-6);
    // Against the last reported position, or the one before it, nothing stands in the way.
    expectAt(control.self().position, along(UP_SCREEN, 0.1));
    expect(blocked.self().position).not.toEqual(control.self().position);
  });

  it('stands still once a steer is within a step of its point', () => {
    const rig = makeRig();
    rig.predictor.steerToward(along(UP_SCREEN, 0.2));

    runTicks(rig, 3, 100);

    expect(rig.self().position).toEqual(START);
    expect(rig.predictor.walk?.kind).toBe('steer');
  });
});

describe('triggers', () => {
  /** A door standing south of the player, its trigger reaching 0.58 m north from z = 12. */
  const doorSector = makeDoor('exit', { x: 10, z: 12 }, { sector: 'Hall', door: 'entry' });
  const beforeDoor = { x: 9.5, z: 11 };
  const south = { x: 0, z: 1 };
  const north = { x: 0, z: -1 };

  function doorRig(): Rig {
    const rig = makeRig({ sector: doorSector, entities: [self({ position: beforeDoor, facing: 30 })] });
    rig.steer(south);
    return rig;
  }

  it('asks for the door by sector and id when a step lands in its trigger, and ends the walk', () => {
    const rig = doorRig();

    runTicks(rig, 4, 100);

    expect(rig.sent.filter((message) => message.tag === 'useDoor')).toEqual([{ tag: 'useDoor', payload: { sector: 'Meadow', doorId: 'exit' } }]);
    expect(rig.predictor.walk).toBeUndefined();
  });

  it('ends a path at the door it walks into: what it was walking to lies in the space left', () => {
    const rig = makeRig({ sector: doorSector, entities: [self({ position: beforeDoor, facing: 30 })] });
    rig.predictor.walkTo({ x: 9.5, z: 11.8 });

    runTicks(rig, 4, 100);
    rig.predictor.releaseDoor(true);
    runTicks(rig, 4, 100);

    expect(rig.sent.filter((message) => message.tag === 'useDoor')).toHaveLength(1);
    expect(rig.predictor.walk).toBeUndefined();
  });

  it('walks a path on through the trigger of a door it does not end at', () => {
    const rig = makeRig({ sector: doorSector, entities: [self({ position: { x: 8, z: 11.7 } })] });
    rig.predictor.walkTo({ x: 12, z: 11.7 });

    runTicks(rig, 30, 100);

    expect(rig.sent.filter((message) => message.tag === 'useDoor')).toEqual([]);
    expect(distance(rig.self().position, { x: 12, z: 11.7 })).toBeLessThan(0.05);
  });

  it('takes the door a path ends at short of a destination it cannot reach', () => {
    const walledBeyond = { ...doorSector, blockers: [{ id: 'wall', x: 9, z: 12.05, width: 2, depth: 1 }] };
    const rig = makeRig({ sector: walledBeyond, entities: [self({ position: beforeDoor })] });
    rig.predictor.walkTo({ x: 10, z: 12.5 });

    runTicks(rig, 20, 100);

    expect(rig.sent.filter((message) => message.tag === 'useDoor')).toHaveLength(1);
  });

  it('stops the player outside the trigger and holds them there', () => {
    const rig = doorRig();

    runTicks(rig, 4, 100);
    const held = rig.self().position;
    rig.steer(south);
    runTicks(rig, 4, 100);

    expect(held.z).toBeLessThan(11.42);
    expect(rig.self().position).toEqual(held);
  });

  it('sends no move once the door has been asked for', () => {
    const rig = doorRig();

    runTicks(rig, 10, 100);

    // A trailing `move` would carry this space's coordinates into the one the door leads to.
    const asked = rig.sent.findIndex((message) => message.tag === 'useDoor');
    expect(asked).toBeGreaterThan(-1);
    expect(rig.sent.slice(asked + 1)).toEqual([]);
  });

  /** The doorway in a wall, as every committed door is, so nothing walks on past the trigger. */
  const walledDoor = { ...doorSector, blockers: [{ id: 'wall', x: 8, z: 12.05, width: 4, depth: 1 }] };

  it("walks into a refused door's trigger without asking again, until a step has left it", () => {
    const rig = makeRig({ sector: walledDoor, entities: [self({ position: beforeDoor, facing: 30 })] });
    rig.steer(south);
    runTicks(rig, 4, 100);
    rig.predictor.releaseDoor(false);
    const held = rig.self().position;

    rig.steer(south);
    for (let time = 500; time <= 900; time += 100) rig.predictor.runTick(time);
    // Still leaning on it: one request, not one per round trip, and the step is taken.
    expect(rig.sent.filter((message) => message.tag === 'useDoor')).toHaveLength(1);
    expect(rig.self().position.z).toBeGreaterThan(held.z + 0.2);

    rig.steer(north);
    for (let time = 1000; time <= 1300; time += 100) rig.predictor.runTick(time);
    rig.steer(south);
    for (let time = 1400; time <= 1800; time += 100) rig.predictor.runTick(time);
    expect(rig.sent.filter((message) => message.tag === 'useDoor')).toHaveLength(2);
  });

  /**
   * A path that walks through a trigger can leave the player standing in it, by a stop, a
   * correction, or another walk. A steer from there asks for the door only toward the doorway, while
   * one entering the trigger asks whichever way it heads.
   */
  it.each([
    ['steers out of a trigger it stands in without asking for the door', north, 0, { x: 10, z: 11.6 }],
    ['asks for the door it stands in front of on steering toward the doorway', south, 1, { x: 10, z: 11.6 }],
    ['asks for a door a steer enters at a glance, heading away from the doorway', { x: -0.9, z: 0.44 }, 1, { x: 9.4, z: 11.38 }],
  ])('%s', (_label, direction, asked, from) => {
    const rig = makeRig({ sector: walledDoor, entities: [self({ position: from })] });
    rig.steer(direction);

    runTicks(rig, 4, 100);

    expect(rig.sent.filter((message) => message.tag === 'useDoor')).toHaveLength(asked);
  });

  it('asks for nothing when a steer out of a trigger is stopped where it stands', () => {
    const boxedIn = { ...walledDoor, blockers: [...walledDoor.blockers, { id: 'beam', x: 8, z: 10.9, width: 4, depth: 0.35 }] };
    const rig = makeRig({ sector: boxedIn, entities: [self({ position: { x: 10, z: 11.6 } })] });
    rig.steer(north);

    runTicks(rig, 4, 100);

    expect(rig.sent.filter((message) => message.tag === 'useDoor')).toEqual([]);
  });

  it.each<[string, Partial<ClientEntity>]>([
    ['an NPC with something to offer', { id: 'npc:Meadow/pugnax', kind: 'npc', service: 'fighterMaster' }],
    ['a peer', { id: 'peer', kind: 'peer' }],
    ['a nightmare', { id: 'monster:1', kind: 'monster' }],
  ])('asks nothing of %s it walks into: acting on something is a click', (_label, entity) => {
    const rig = makeRig({ entities: [self(), clientEntity({ ...entity, position: along(UP_SCREEN, 0.61) })] });
    rig.steer(UP_SCREEN);

    runTicks(rig, 3, 100);

    expect(rig.sent.every((message) => message.tag === 'move')).toBe(true);
  });

  it('stops at the NPC rather than walking through it', () => {
    const npc = clientEntity({ id: 'npc:Meadow/wirt', kind: 'npc', name: 'Wirt', position: along(UP_SCREEN, 0.6) });
    const rig = makeRig({ entities: [self(), npc] });
    rig.steer(UP_SCREEN);

    runTicks(rig, 3, 16);

    expect(rig.self().position).toEqual(START);
  });
});

describe('a swing', () => {
  it('slows the player to its share of their pace while it lasts', () => {
    const rig = makeRig();
    rig.steer(UP_SCREEN);
    rig.slowed = true;
    runTicks(rig, 1, 100);
    expectAt(rig.self().position, along(UP_SCREEN, 0.14));

    rig.slowed = false;
    runTicks(rig, 1, 100);
    expectAt(rig.self().position, along(UP_SCREEN, 0.34));
  });
});

describe('a balance that gave out, and a fall', () => {
  it('moves a winded player at the slow gait whether Run is on or not', () => {
    const rig = makeRig();
    rig.running = true;
    rig.winded = true;
    rig.steer(UP_SCREEN);

    runTicks(rig, 1, 100);

    expectAt(rig.self().position, along(UP_SCREEN, 0.1));
    expect(rig.self().gait).toBe('walk');
    expect(rig.sent.at(-1)).toMatchObject({ tag: 'move', payload: { gait: 'walk' } });
  });

  it('jogs a braced player whether Run is on or not', () => {
    const rig = makeRig();
    rig.running = true;
    rig.effects = ['braced'];
    rig.steer(UP_SCREEN);

    runTicks(rig, 1, 100);

    expectAt(rig.self().position, along(UP_SCREEN, 0.2));
    expect(rig.sent.at(-1)).toMatchObject({ tag: 'move', payload: { gait: 'jog' } });
  });

  it('neither moves nor reports while the player lies fallen, and the fall ends the walk', () => {
    const rig = makeRig();
    rig.predictor.walkTo(along(UP_SCREEN, 5));
    rig.fallen = true;
    rig.lookAt = toward(90);

    runTicks(rig, 5, 100);
    rig.fallen = false;
    runTicks(rig, 5, 100);

    expect(rig.self()).toMatchObject({ position: START });
    expect(rig.predictor.walk).toBeUndefined();
    expect(rig.moves()).toEqual([START]);
  });
});

describe('a channel holding the player still', () => {
  it('keeps the walk and its arrival, turning the player but moving them nowhere, and walks on to act once it lets go', () => {
    const rig = makeRig();
    const destination = along(UP_SCREEN, 2);
    let acted = 0;
    rig.predictor.walkTo(destination, { within: 0.5, act: () => (acted += 1) });
    rig.heldStill = true;
    rig.lookAt = toward(90);

    runTicks(rig, 5, 100);

    expect(rig.self()).toMatchObject({ position: START });
    expect(rig.self().facing).toBeCloseTo(90, 9);
    expect(rig.moves()).toEqual([START]);
    expect(rig.predictor.walk).toMatchObject({ kind: 'path', destination });
    expect(acted).toBe(0);

    rig.heldStill = false;
    tickUntilWalkEnds(rig, 100, 600);

    expect(distance(rig.self().position, destination)).toBeLessThanOrEqual(0.5);
    expect(acted).toBe(1);
  });

  it('counts no stall while it holds, so a leg blocked once it lets go spends no re-plan at once', () => {
    const rig = makeRig();
    rig.predictor.walkTo(along(UP_SCREEN, 4));
    rig.predictor.runTick(0);
    // A walk whose every re-plan is spent: the next search due ends it.
    (rig.predictor.walk as { searches: number }).searches = 1 + PATH_FOLLOWING.maxReplans;
    rig.heldStill = true;
    for (let time = 100; time <= 1000; time += 100) rig.predictor.runTick(time);
    // A dreamer steps onto the leg, touching the player, so the next steps bring them no nearer.
    rig.session.entities.set('peer', clientEntity({ id: 'peer', kind: 'peer', position: along(UP_SCREEN, 0.6) }));

    rig.heldStill = false;
    rig.predictor.runTick(1050);
    rig.predictor.runTick(1100);

    expect(rig.self().position).toEqual(START);
    expect(rig.predictor.walk).toMatchObject({ kind: 'path' });
  });
});

describe('emission gates', () => {
  /**
   * A count, not a pattern match: this is the assertion that catches a tick emitting on every
   * frame. Over one second of 16 ms ticks a 10 Hz heartbeat produces the priming emit plus one
   * per interval; an ungated tick would produce 63.
   */
  it('reports the position at 10 Hz over a fixed interval', () => {
    const rig = makeRig();
    rig.steer(UP_SCREEN);

    runTicks(rig, 62, 16);

    // t = 0 (first change, nothing throttling it yet), then every seventh tick: 112, 224, ... 896.
    expect(rig.moves()).toHaveLength(9);
    expect(POSITION_HEARTBEAT_INTERVAL_MS).toBe(100);
  });

  it('reports metres, the facing, and the gait', () => {
    const rig = makeRig();
    rig.steer(UP_SCREEN);

    runTicks(rig, 1, 100);

    const report = rig.sent.at(-1);
    if (report?.tag !== 'move') throw new Error('expected a move');
    expect(report.payload).toEqual({ x: rig.self().position.x, z: rig.self().position.z, facing: rig.self().facing, gait: 'jog' });
    expectAt(report.payload, along(UP_SCREEN, 0.2));
    expect(report.payload.facing).toBeCloseTo(215, 9);
  });

  /**
   * The facing threshold needs its own pair of assertions, because a count alone cannot
   * distinguish a 1-degree threshold from 0 or 10 unless the driven sequence happens to straddle
   * it. Both rigs are stationary so position and gait cannot be what changes.
   */
  it('does not emit for a sub-threshold facing change', () => {
    const rig = makeRig();
    rig.lookAt = toward(90);
    rig.predictor.runTick(0);
    const baseline = rig.sent.length;

    rig.lookAt = toward(90.5);
    rig.predictor.runTick(1000);

    // `angularDistance(90 -> 90.5)` is 0.5, at or under the threshold. Without this gate a
    // cursor jittering by fractions of a degree reports on every heartbeat.
    expect(rig.sent).toHaveLength(baseline);
  });

  it('emits exactly once for a super-threshold facing change', () => {
    const rig = makeRig();
    rig.lookAt = toward(90);
    rig.predictor.runTick(0);
    const baseline = rig.sent.length;

    rig.lookAt = toward(91.5);
    rig.predictor.runTick(1000);

    // `angularDistance(90 -> 91.5)` is 1.5, past the threshold.
    expect(rig.sent).toHaveLength(baseline + 1);
    expect(FACING_EMIT_THRESHOLD_DEGREES).toBe(1);
  });

  it('measures the facing delta across the 0/360 seam', () => {
    const rig = makeRig();
    rig.lookAt = toward(359.5);
    rig.predictor.runTick(0);
    const baseline = rig.sent.length;

    rig.lookAt = toward(0.5);
    rig.predictor.runTick(1000);

    // The real turn is 1 degree, not 359. A naive subtraction would report every seam crossing.
    expect(rig.sent).toHaveLength(baseline);
  });

  it('reports the final position after a throttled move rather than dropping it', () => {
    const rig = makeRig();
    rig.steer(UP_SCREEN);

    // t = 112 is the first tick past the 100 ms interval, so the final tick here is an emit.
    runTicks(rig, 7, 16);

    // The last report is deliberately left unchanged while throttled, so the next tick past the
    // interval still sees the move as pending.
    expect(rig.moves().at(-1)).toEqual(rig.self().position);
  });
});

describe('a leap', () => {
  const ghostAt = (metres: number) => clientEntity({ id: 'monster:1', kind: 'monster', position: along(UP_SCREEN, metres) });

  it('heads for contact with the body at its own speed in place of the walk under way, and ends there, every report legal', () => {
    const ghost = ghostAt(3);
    const rig = makeRig({ entities: [self(), ghost] });
    rig.predictor.walkTo(along(DOWN_SCREEN, 5));
    rig.predictor.leapAt({ ...ghost.position, radius: ghost.radius }, 3, 6);
    // A steer asked for during the leap is dropped.
    rig.steer(DOWN_SCREEN);

    runTicks(rig, 2, 100);
    expectAt(rig.self().position, along(UP_SCREEN, 1.2));
    expect(rig.predictor.walk?.kind).toBe('leap');

    const ended = tickUntilWalkEnds(rig, 100, 300);
    expect(ended).toBe(500);
    expectAt(rig.self().position, along(UP_SCREEN, 2.4));
    expectLegalReports(rig, START);
  });

  it('goes no further than the metres it is given toward a body further off', () => {
    const ghost = ghostAt(5);
    const rig = makeRig({ entities: [self(), ghost] });
    rig.predictor.leapAt({ ...ghost.position, radius: ghost.radius }, 3, 6);
    tickUntilWalkEnds(rig, 100);
    expectAt(rig.self().position, along(UP_SCREEN, 3));
  });
});

describe('a flush', () => {
  it('sends the report the heartbeat holds back at once, so a useAbility sent between two heartbeats arrives after the final move', () => {
    const rig = makeRig();
    rig.steer(UP_SCREEN);
    // t = 0 reports, and the ticks at 16 and 32 are held back by the heartbeat.
    runTicks(rig, 2, 16);
    expect(rig.moves().at(-1)).not.toEqual(rig.self().position);

    rig.predictor.flush();
    rig.sent.push({ tag: 'useAbility', payload: { abilityId: 'brace' } });

    const last = rig.sent.at(-2);
    if (last?.tag !== 'move') throw new Error('expected a move ahead of the request');
    expect(last.payload).toEqual({ x: rig.self().position.x, z: rig.self().position.z, facing: rig.self().facing, gait: 'jog' });
    expectLegalReports(rig, START);
  });

  it('sends nothing when the last report already holds where the player stands', () => {
    const rig = makeRig();
    rig.steer(UP_SCREEN);
    runTicks(rig, 2, 16);
    rig.predictor.flush();
    const sent = rig.sent.length;
    rig.predictor.flush();
    expect(rig.sent).toHaveLength(sent);
  });
});

describe('waypoint reports', () => {
  /**
   * A box whose south-west corner the player slides round: a steer screen-up (heading 215) glides
   * the player west under the box's south face and turns north once past the corner.
   */
  const box = { id: 'box', x: 9, z: 8, width: 3, depth: 1 };
  const start = { x: 9.4, z: 9.3 };

  function slideRoundCorner(frameMs: number): { rig: Rig; reports: Point[] } {
    const rig = makeRig({ sector: { blockers: [box] }, entities: [self({ position: start })] });
    rig.running = true;
    rig.steer(UP_SCREEN);
    runTicks(rig, Math.ceil(1000 / frameMs), frameMs);
    // The slide really went round the corner, to the box's west side.
    expect(rig.self().position.x).toBeLessThan(box.x);
    expect(rig.self().position.z).toBeLessThan(box.z + box.depth);
    return { rig, reports: [start, ...rig.moves()] };
  }

  it.each([16, 50, 99, 150])('reports a corner slide so that every report is a legal move from the last, at %i ms frames', (frameMs) => {
    const { rig } = slideRoundCorner(frameMs);

    expectLegalReports(rig, start);
  });

  /**
   * At 99 ms a frame the heartbeat fires every second frame, which puts more than half a metre
   * between two timed reports: the straight line between them cuts inside the rounded corner.
   */
  it.each([99, 150])('reports the position before the corner when the next beat alone would cut it, at %i ms frames', (frameMs) => {
    const { rig, reports } = slideRoundCorner(frameMs);

    // A waypoint goes out on the tick that needed it, ahead of that tick's own heartbeat.
    const waypoints = rig.moveTimes.flatMap((time, index) => (rig.moveTimes[index + 1] === time ? [index + 1] : []));
    expect(waypoints.length).toBeGreaterThan(0);
    for (const index of waypoints) {
      expect(isLegalMove(rig.world.collision, reports[index - 1]!, reports[index + 1]!, 0.3, []), `skipping report ${index}`).toBe(false);
    }
  });

  /**
   * The same slide round a body instead of a corner: an NPC north of the player, which the player
   * glides west along and passes on its west side. Nothing but the NPC stands between two timed
   * reports, and the server refuses a report whose line from the last one cuts through it.
   */
  it.each([16, 50, 99, 150])('reports a slide round an NPC so that every report is a legal move from the last, at %i ms frames', (frameMs) => {
    const npc = clientEntity({ id: 'npc:Meadow/wirt', kind: 'npc', position: { x: START.x - 0.15, z: START.z - 0.8 } });
    const rig = makeRig({ entities: [self(), npc] });
    rig.running = true;
    rig.steer(UP_SCREEN);

    runTicks(rig, Math.ceil(1000 / frameMs), frameMs);

    // The player ran into the NPC and came out on its far side.
    expect(rig.self().position.x).toBeLessThan(npc.position.x - 0.6);
    expect(rig.self().position.z).toBeLessThan(npc.position.z);
    expectLegalReports(rig, START, [{ x: npc.position.x, z: npc.position.z, radius: npc.radius }]);
  });
});

describe('the input gate', () => {
  it.each<[string, (rig: Rig) => void]>([
    ['an overlay is presented', (rig) => (rig.session.presentedOverlay = { kind: 'gameMenu' })],
    ['the connection is not attached', (rig) => (rig.session.connectionState = 'awaitingEnterSpace')],
  ])('ends the walk when %s', (_label, close) => {
    const rig = makeRig();
    rig.predictor.walkTo(along(UP_SCREEN, 5));
    runTicks(rig, 2, 100);
    const stopped = rig.self().position;

    close(rig);
    rig.predictor.runTick(300);
    rig.session.presentedOverlay = undefined;
    rig.session.connectionState = 'attached';
    rig.predictor.runTick(400);

    expect(rig.predictor.walk).toBeUndefined();
    expect(rig.self().position).toEqual(stopped);
  });

  it('is open while attached with no overlay', () => {
    const rig = makeRig();

    expect(rig.predictor.gateIsOpen()).toBe(true);
    rig.session.presentedOverlay = { kind: 'gameMenu' };
    expect(rig.predictor.gateIsOpen()).toBe(false);
  });
});

describe('correction', () => {
  it('snaps to the corrected position, measures the next report from it, and ends the walk', () => {
    const rig = makeRig();
    rig.predictor.walkTo(along(UP_SCREEN, 5));
    rig.predictor.runTick(0);
    rig.predictor.runTick(100);
    const baseline = rig.sent.length;

    rig.predictor.correct({ x: 4, z: 4 });
    rig.predictor.runTick(1000);

    expect(rig.self().position).toEqual({ x: 4, z: 4 });
    expect(rig.predictor.walk).toBeUndefined();
    // The server already holds this position, so standing on it is nothing to report.
    expect(rig.sent).toHaveLength(baseline);
  });
});

describe('reset', () => {
  it('drops the tick clock and the last report', () => {
    const rig = makeRig();
    rig.steer(UP_SCREEN);
    runTicks(rig, 4, 16);
    const before = rig.self().position;
    const reports = rig.moves().length;

    rig.predictor.reset();
    rig.predictor.runTick(1000);

    // A stale tick timestamp would move the player on the first tick back; a stale report would
    // leave the server not hearing from the client until something changed.
    expect(rig.self().position).toEqual(before);
    expect(rig.moves()).toHaveLength(reports + 1);
  });
});
