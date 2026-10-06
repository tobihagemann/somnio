import { describe, expect, it } from 'vitest';
import { distance, isLegalMove } from '@somnio/core';
import type { Point } from '@somnio/core';
import type { SectorView, SomnioMessage } from '@somnio/protocol';
import {
  ClientWorld,
  FACING_EMIT_THRESHOLD_DEGREES,
  GameplayPredictor,
  MAX_TICK_ELAPSED_MS,
  POSITION_HEARTBEAT_INTERVAL_MS,
  RemoteInterpolation,
  entityBlockers,
  gaitFromHeld,
  noHeldKeys,
  noopRenderSurface,
  velocityFromHeld,
} from '@/client';
import type { ClientEntity, ConnectionState, HeldKeys, OverlayKind, PredictorSession } from '@/client';
import { TEST_REGISTRY, outdoorSector } from '../../core/test/support/worldFixture.ts';
import { clientEntity, makeDoor } from './helpers/worldFixture';

/**
 * Deterministic prediction-tick suite. Positional expectations are derived here from the camera
 * yaw and the gait speeds, never by running the predictor's own arithmetic, so the suite catches
 * the predictor drifting from the shared `@somnio/core` movement rules.
 */

/** Held W only. Screen-up under the camera's 35-degree yaw, so both world axes move. */
const HELD_W: HeldKeys = { ...noHeldKeys(), w: true };
const HELD_S: HeldKeys = { ...noHeldKeys(), s: true };

const YAW = (35 * Math.PI) / 180;
/** The unit world direction of held W. */
const W_DIRECTION = { x: -Math.sin(YAW), z: -Math.cos(YAW) };

/** Held W travels at heading 215; facing 210 buckets it as forward, with a 1.0 speed multiplier. */
const FORWARD_FACING = 210;

const START = { x: 10, z: 10 };

function along(direction: { x: number; z: number }, metres: number, from: Point = START): Point {
  return { x: from.x + direction.x * metres, z: from.z + direction.z * metres };
}

function self(overrides: Partial<ClientEntity> = {}): ClientEntity {
  return clientEntity({ position: START, facing: FORWARD_FACING, ...overrides });
}

interface Rig {
  predictor: GameplayPredictor;
  session: PredictorSession & {
    connectionState: ConnectionState;
    presentedOverlay: OverlayKind | undefined;
    isChatInputFocused: boolean;
  };
  world: ClientWorld;
  interpolation: RemoteInterpolation;
  sent: SomnioMessage[];
  /** The tick time each `move` was sent on. */
  moveTimes: number[];
  held: HeldKeys;
  /** Cursor-derived facing; `undefined` leaves the entity's own facing alone. */
  mouseFacing: number | undefined;
  winded: boolean;
  fallen: boolean;
  /** Whether a swing is slowing the player. */
  slowed: boolean;
  gateWrites: boolean[];
  self(): ClientEntity;
  moves(): Point[];
}

function makeRig(options: { sector?: Partial<SectorView>; entities?: ClientEntity[]; held?: HeldKeys } = {}): Rig {
  const entities = new Map<string, ClientEntity>();
  for (const each of options.entities ?? [self()]) entities.set(each.id, each);
  const sent: SomnioMessage[] = [];
  const moveTimes: number[] = [];
  const gateWrites: boolean[] = [];
  const world = new ClientWorld('outdoors', TEST_REGISTRY);
  world.addSector(outdoorSector('Meadow', { x: 0, z: 0 }, options.sector));
  const interpolation = new RemoteInterpolation();
  let tickTime = 0;

  // Typed through the mutable shape the rig exposes, so a test assigning a bogus state or overlay is
  // a compile error rather than a silently-closed gate.
  const session: Rig['session'] = {
    connectionState: 'attached',
    presentedOverlay: undefined,
    isChatInputFocused: false,
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
    held: options.held ?? HELD_W,
    mouseFacing: undefined,
    winded: false,
    fallen: false,
    slowed: false,
    gateWrites,
    self: () => {
      const found = entities.get('self');
      if (found === undefined) throw new Error('self entity missing');
      return found;
    },
    moves: () => sent.flatMap((message) => (message.tag === 'move' ? [{ x: message.payload.x, z: message.payload.z }] : [])),
  };

  const predictor = new GameplayPredictor({
    session,
    input: {
      snapshot: () => rig.held,
      setGameplayActive: (active) => gateWrites.push(active),
    },
    renderSurface: noopRenderSurface,
    interpolation,
    send: (message) => {
      sent.push(message);
      if (message.tag === 'move') moveTimes.push(tickTime);
    },
    mouseFacing: () => rig.mouseFacing,
    winded: () => rig.winded,
    fallen: () => rig.fallen,
    slowed: () => rig.slowed,
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

function expectAt(actual: Point, expected: Point): void {
  expect(actual.x).toBeCloseTo(expected.x, 9);
  expect(actual.z).toBeCloseTo(expected.z, 9);
}

describe('elapsed-time handling', () => {
  it('does not move on the first tick, having no previous timestamp to measure from', () => {
    const rig = makeRig();

    rig.predictor.runTick(0);

    expect(rig.self().position).toEqual(START);
  });

  it('jogs two metres a second along the camera-rotated direction', () => {
    const rig = makeRig();

    runTicks(rig, 4, 16);

    expectAt(rig.self().position, along(W_DIRECTION, 2 * 0.064));
  });

  it('advances by the same distance whether one 100 ms tick or a 5 s stall is reported', () => {
    const stalled = makeRig();
    const clamped = makeRig();

    stalled.predictor.runTick(0);
    stalled.predictor.runTick(5000);
    clamped.predictor.runTick(0);
    clamped.predictor.runTick(MAX_TICK_ELAPSED_MS);

    // A single tick is clamped to 100 ms. Without the clamp the stalled rig would teleport
    // fifty times further.
    expectAt(stalled.self().position, along(W_DIRECTION, 0.2));
    expect(clamped.self().position).toEqual(stalled.self().position);
  });

  it.each([
    ['leftShift', 'run', 3],
    ['leftOption', 'walk', 1],
  ] as const)('scales the step by gait: %s is a %s', (key, gait, metresPerSecond) => {
    const rig = makeRig({ held: { ...HELD_W, [key]: true } });

    runTicks(rig, 3, 100);

    expect(gaitFromHeld(rig.held)).toBe(gait);
    expectAt(rig.self().position, along(W_DIRECTION, metresPerSecond * 0.3));
    expect(rig.self().gait).toBe(gait);
  });

  it('halves the step when backpedalling', () => {
    // Facing 30 looks back along the travel heading of 215.
    const rig = makeRig({ entities: [self({ facing: 30 })] });

    runTicks(rig, 1, 100);

    expectAt(rig.self().position, along(W_DIRECTION, 0.1));
  });
});

describe('collision resolution', () => {
  /** A wall whose east face is one body radius west of the player, so no step west is clear. */
  const westWall = { id: 'west-wall', x: 8.7, z: 5, width: 1, depth: 10 };

  it('slides along a blocked axis instead of sticking', () => {
    const rig = makeRig({ sector: { blockers: [westWall] } });

    runTicks(rig, 1, 100);

    // West is refused, north commits: the player glides up the wall's face.
    expectAt(rig.self().position, { x: START.x, z: START.z + W_DIRECTION.z * 0.2 });
  });

  it('treats a peer as solid', () => {
    const peer = clientEntity({ id: 'peer', kind: 'peer', name: 'Peer', position: along(W_DIRECTION, 0.62) });
    const rig = makeRig({ entities: [self(), peer] });

    runTicks(rig, 3, 100);

    // A peer is a body the player stops at and slides round, never one walked through.
    expect(distance(rig.self().position, peer.position)).toBeGreaterThanOrEqual(0.6 - 1e-6);
  });

  it('lets the player walk free of a monster already overlapping them', () => {
    const overlapping = clientEntity({ id: 'monster:1', kind: 'monster', characterModelId: 'ghost', position: along(W_DIRECTION, 0.2) });
    const rig = makeRig({ entities: [self(), overlapping] });

    runTicks(rig, 1, 100);

    // Soft-solid: a block here would hold the player in place, because monsters chase on the
    // server's tick and can lag onto the player's own body.
    expectAt(rig.self().position, along(W_DIRECTION, 0.2));
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
    const middle = along(W_DIRECTION, 0.62);
    const peer = clientEntity({ id: 'peer', kind: 'peer', name: 'Peer', position: { x: middle.x + 3, z: middle.z } });
    const blocked = makeRig({ entities: [self(), peer] });
    const control = makeRig({ entities: [self(), peer] });
    blocked.interpolation.retarget('peer', peer.position, { x: middle.x - 3, z: middle.z }, 0);

    blocked.predictor.runTick(0);
    blocked.predictor.runTick(50);
    control.predictor.runTick(0);
    control.predictor.runTick(50);

    expectAt(blocked.session.entities.get('peer')!.position, middle);
    expect(distance(blocked.self().position, middle)).toBeGreaterThanOrEqual(0.6 - 1e-6);
    // Against the last reported position, or the one before it, nothing stands in the way.
    expectAt(control.self().position, along(W_DIRECTION, 0.1));
    expect(blocked.self().position).not.toEqual(control.self().position);
  });
});

describe('triggers', () => {
  /** A door standing south of the player, its trigger reaching 0.58 m north from z = 12. */
  const doorSector = makeDoor('exit', { x: 10, z: 12 }, { sector: 'Hall', door: 'entry' });
  const beforeDoor = { x: 9.5, z: 11 };

  function doorRig(): Rig {
    return makeRig({ sector: doorSector, held: HELD_S, entities: [self({ position: beforeDoor, facing: 30 })] });
  }

  it('asks for the door by sector and id when a step lands in its trigger', () => {
    const rig = doorRig();

    runTicks(rig, 4, 100);

    expect(rig.sent.filter((message) => message.tag === 'useDoor')).toEqual([{ tag: 'useDoor', payload: { sector: 'Meadow', doorId: 'exit' } }]);
  });

  it('stops the player outside the trigger and holds them there', () => {
    const rig = doorRig();

    runTicks(rig, 4, 100);
    const held = rig.self().position;
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

  /** A held swing reports before each swing, and the rhythm can come round between `useDoor` and `enterSpace`. */
  it('reports nothing ahead of the heartbeat either while the door is pending', () => {
    const rig = doorRig();
    runTicks(rig, 4, 100);
    const turned = { ...rig.self(), facing: 200 };
    rig.session.entities.set('self', turned);

    rig.predictor.reportNow();
    expect(rig.sent.at(-1)?.tag).toBe('useDoor');

    // The same call reports the turn once the door has answered.
    rig.predictor.releaseDoor(false);
    rig.predictor.reportNow();
    expect(rig.sent.at(-1)).toMatchObject({ tag: 'move', payload: { facing: 200 } });
  });

  it('does not ask again for a refused door until a step has left its trigger', () => {
    const rig = doorRig();
    runTicks(rig, 4, 100);

    rig.predictor.releaseDoor(false);
    for (let time = 500; time <= 900; time += 100) rig.predictor.runTick(time);
    // Still leaning on it: one request, not one per round trip.
    expect(rig.sent.filter((message) => message.tag === 'useDoor')).toHaveLength(1);

    rig.held = HELD_W;
    rig.predictor.runTick(1000);
    rig.held = HELD_S;
    for (let time = 1100; time <= 1500; time += 100) rig.predictor.runTick(time);
    expect(rig.sent.filter((message) => message.tag === 'useDoor')).toHaveLength(2);
  });

  it.each<[string, Partial<ClientEntity>]>([
    ['an NPC with something to offer', { id: 'npc:Meadow/pugnax', kind: 'npc', service: 'kaempferMaster' }],
    ['a peer', { id: 'peer', kind: 'peer' }],
    ['a nightmare', { id: 'monster:1', kind: 'monster' }],
  ])('asks nothing of %s it walks into: acting on something is a click', (_label, entity) => {
    const rig = makeRig({ entities: [self(), clientEntity({ ...entity, position: along(W_DIRECTION, 0.61) })] });

    runTicks(rig, 3, 100);

    expect(rig.sent.every((message) => message.tag === 'move')).toBe(true);
  });

  it('stops at the NPC rather than walking through it', () => {
    const npc = clientEntity({ id: 'npc:Meadow/wirt', kind: 'npc', name: 'Wirt', position: along(W_DIRECTION, 0.6) });
    const rig = makeRig({ entities: [self(), npc] });

    runTicks(rig, 3, 16);

    expect(rig.self().position).toEqual(START);
  });
});

describe('a swing', () => {
  it('slows the player to its share of their pace while it lasts', () => {
    const rig = makeRig();
    rig.slowed = true;
    runTicks(rig, 1, 100);
    expectAt(rig.self().position, along(W_DIRECTION, 0.14));

    rig.slowed = false;
    runTicks(rig, 1, 100);
    expectAt(rig.self().position, along(W_DIRECTION, 0.34));
  });

  it('is reported from where the player stands, ahead of the heartbeat, and once', () => {
    const rig = makeRig();
    rig.predictor.runTick(0);
    rig.predictor.runTick(16);
    expect(rig.moves()).toHaveLength(1);

    rig.predictor.reportNow();
    rig.predictor.reportNow();
    expect(rig.moves()).toHaveLength(2);
    expect(rig.moves().at(-1)).toEqual(rig.self().position);
  });
});

describe('a balance that gave out, and a fall', () => {
  it('moves a winded player at the slow gait whatever is held', () => {
    const rig = makeRig({ held: { ...HELD_W, leftShift: true } });
    rig.winded = true;

    runTicks(rig, 1, 100);

    expectAt(rig.self().position, along(W_DIRECTION, 0.1));
    expect(rig.self().gait).toBe('walk');
    expect(rig.sent.at(-1)).toMatchObject({ tag: 'move', payload: { gait: 'walk' } });
  });

  it('neither moves nor reports while the player lies fallen', () => {
    const rig = makeRig();
    rig.fallen = true;
    rig.mouseFacing = 90;

    runTicks(rig, 5, 100);

    expect(rig.self()).toMatchObject({ position: START, facing: FORWARD_FACING });
    expect(rig.sent).toEqual([]);
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

    runTicks(rig, 62, 16);

    // t = 0 (first change, nothing throttling it yet), then every seventh tick: 112, 224, ... 896.
    expect(rig.moves()).toHaveLength(9);
    expect(POSITION_HEARTBEAT_INTERVAL_MS).toBe(100);
  });

  it('reports metres, the facing, and the gait', () => {
    const rig = makeRig();

    runTicks(rig, 1, 100);

    const expected = along(W_DIRECTION, 0.2);
    const report = rig.sent.at(-1);
    if (report?.tag !== 'move') throw new Error('expected a move');
    expect(report.payload).toEqual({ x: rig.self().position.x, z: rig.self().position.z, facing: FORWARD_FACING, gait: 'jog' });
    expectAt(report.payload, expected);
  });

  /**
   * The facing threshold needs its own pair of assertions, because a count alone cannot
   * distinguish a 1-degree threshold from 0 or 10 unless the driven sequence happens to straddle
   * it. Both rigs are stationary so position and gait cannot be what changes.
   */
  it('does not emit for a sub-threshold facing change', () => {
    const rig = makeRig({ held: noHeldKeys() });
    rig.mouseFacing = 90;
    rig.predictor.runTick(0);
    const baseline = rig.sent.length;

    rig.mouseFacing = 90.5;
    rig.predictor.runTick(1000);

    // `angularDistance(90 -> 90.5)` is 0.5, at or under the threshold. Without this gate a
    // cursor jittering by fractions of a degree reports on every heartbeat.
    expect(rig.sent).toHaveLength(baseline);
  });

  it('emits exactly once for a super-threshold facing change', () => {
    const rig = makeRig({ held: noHeldKeys() });
    rig.mouseFacing = 90;
    rig.predictor.runTick(0);
    const baseline = rig.sent.length;

    rig.mouseFacing = 91.5;
    rig.predictor.runTick(1000);

    // `angularDistance(90 -> 91.5)` is 1.5, past the threshold.
    expect(rig.sent).toHaveLength(baseline + 1);
    expect(FACING_EMIT_THRESHOLD_DEGREES).toBe(1);
  });

  it('measures the facing delta across the 0/360 seam', () => {
    const rig = makeRig({ held: noHeldKeys() });
    rig.mouseFacing = 359.5;
    rig.predictor.runTick(0);
    const baseline = rig.sent.length;

    rig.mouseFacing = 0.5;
    rig.predictor.runTick(1000);

    // The real turn is 1 degree, not 359. A naive subtraction would report every seam crossing.
    expect(rig.sent).toHaveLength(baseline);
  });

  it('reports the final position after a throttled move rather than dropping it', () => {
    const rig = makeRig();

    // t = 112 is the first tick past the 100 ms interval, so the final tick here is an emit.
    runTicks(rig, 7, 16);

    // The last report is deliberately left unchanged while throttled, so the next tick past the
    // interval still sees the move as pending.
    expect(rig.moves().at(-1)).toEqual(rig.self().position);
  });
});

describe('waypoints', () => {
  /**
   * A box whose south-west corner the player slides round: held W runs north-north-west, so the
   * player glides west under the box's south face and turns north once past the corner.
   */
  const box = { id: 'box', x: 9, z: 8, width: 3, depth: 1 };
  const start = { x: 9.6, z: 9.3 };

  function slideRoundCorner(frameMs: number): { rig: Rig; reports: Point[] } {
    const rig = makeRig({ sector: { blockers: [box] }, held: { ...HELD_W, leftShift: true }, entities: [self({ position: start })] });
    runTicks(rig, Math.ceil(1000 / frameMs), frameMs);
    // The slide really went round the corner, to the box's west side.
    expect(rig.self().position.x).toBeLessThan(box.x);
    expect(rig.self().position.z).toBeLessThan(box.z + box.depth);
    return { rig, reports: [start, ...rig.moves()] };
  }

  it.each([16, 50, 99, 150])('reports a corner slide so that every report is a legal move from the last, at %i ms frames', (frameMs) => {
    const { rig, reports } = slideRoundCorner(frameMs);

    // What the server checks: each report against the one it accepted before.
    for (let index = 1; index < reports.length; index += 1) {
      expect(isLegalMove(rig.world.collision, reports[index - 1]!, reports[index]!, 0.3, []), `report ${index}`).toBe(true);
    }
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
    const rig = makeRig({ held: { ...HELD_W, leftShift: true }, entities: [self(), npc] });

    runTicks(rig, Math.ceil(1000 / frameMs), frameMs);

    // The player ran into the NPC and came out on its far side.
    expect(rig.self().position.x).toBeLessThan(npc.position.x - 0.6);
    expect(rig.self().position.z).toBeLessThan(npc.position.z);
    const reports = [START, ...rig.moves()];
    const body = { x: npc.position.x, z: npc.position.z, radius: npc.radius };
    for (let index = 1; index < reports.length; index += 1) {
      expect(isLegalMove(rig.world.collision, reports[index - 1]!, reports[index]!, 0.3, [body]), `report ${index}`).toBe(true);
    }
  });
});

describe('the input gate', () => {
  it('is open while attached with no overlay and no chat focus', () => {
    const rig = makeRig();

    rig.predictor.runTick(0);

    expect(rig.gateWrites).toEqual([true]);
  });

  it('closes while an overlay is presented', () => {
    const rig = makeRig();
    rig.session.presentedOverlay = { kind: 'gameMenu' };

    rig.predictor.runTick(0);

    expect(rig.gateWrites).toEqual([false]);
  });

  it('closes while the chat input is focused', () => {
    const rig = makeRig();
    rig.session.isChatInputFocused = true;

    rig.predictor.runTick(0);

    expect(rig.gateWrites).toEqual([false]);
  });

  it.each(['awaitingLoginResult', 'awaitingEnterSpace'] as const)('closes while %s', (state) => {
    const rig = makeRig();
    rig.session.connectionState = state;

    rig.predictor.runTick(0);

    expect(rig.gateWrites).toEqual([false]);
  });

  it('keeps reporting the gate closed across ticks while an overlay is up', () => {
    const rig = makeRig();
    rig.session.presentedOverlay = { kind: 'gameMenu' };
    // Only the gate *write* is asserted, deliberately. `runTick` returns early on chat focus but not
    // on an overlay, and this rig's stub sink keeps reporting the held key, so the character does
    // move here by design — there is no position to assert. That the production sampler clears its
    // bitset when the gate closes is covered in `browser-host.test.ts`, which drives a real
    // `KeyboardSampler`.
    rig.predictor.runTick(0);
    rig.predictor.runTick(16);

    expect(rig.gateWrites).toEqual([false, false]);
  });

  it('returns before moving the player while chat is focused', () => {
    const rig = makeRig();
    rig.session.isChatInputFocused = true;

    rig.predictor.runTick(0);
    rig.predictor.runTick(16);

    expect(rig.self().position).toEqual(START);
    expect(rig.sent).toHaveLength(0);
  });

  it('keeps drawing remote entities while chat is focused', () => {
    const peer = clientEntity({ id: 'peer', kind: 'peer', position: { x: 2, z: 2 } });
    const rig = makeRig({ entities: [self(), peer] });
    rig.session.isChatInputFocused = true;
    rig.interpolation.retarget('peer', peer.position, { x: 3, z: 2 }, 0);

    rig.predictor.runTick(100);

    expect(rig.session.entities.get('peer')?.position).toEqual({ x: 3, z: 2 });
  });
});

describe('correction', () => {
  it('snaps to the corrected position and measures the next report from it', () => {
    const rig = makeRig({ held: noHeldKeys() });
    rig.predictor.runTick(0);
    const baseline = rig.sent.length;

    rig.predictor.correct({ x: 4, z: 4 });
    rig.predictor.runTick(1000);

    expect(rig.self().position).toEqual({ x: 4, z: 4 });
    // The server already holds this position, so standing on it is nothing to report.
    expect(rig.sent).toHaveLength(baseline);
  });
});

describe('reset', () => {
  it('drops the tick clock and the last report', () => {
    const rig = makeRig();
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

describe('velocity', () => {
  it('normalizes a diagonal so eight-way movement is not faster', () => {
    const diagonal = velocityFromHeld({ ...noHeldKeys(), w: true, d: true });

    expect(Math.hypot(diagonal.dx, diagonal.dy)).toBeCloseTo(1, 12);
  });

  it('cancels opposing keys to a standstill', () => {
    expect(velocityFromHeld({ ...noHeldKeys(), a: true, d: true })).toEqual({ dx: 0, dy: 0 });
  });
});
