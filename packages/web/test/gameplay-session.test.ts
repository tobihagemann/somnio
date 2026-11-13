import { describe, expect, it } from 'vitest';
import {
  ConnectionController,
  FINGER_HOLD_MS,
  GameplaySession,
  HOLD_TO_STEER_MS,
  PATH_FOLLOWING,
  REMOTE_INTERPOLATION_SECONDS,
  compassPoint,
  noopRenderSurface,
} from '@/client';
import type { ClientEntity, QuestNews, SpeechBubbleRequest, TargetMark } from '@/client';
import { GameplayTransport } from '@/transport';
import { fakeSocketFactory } from './helpers/fakeSocket';
import { TEST_REGISTRY, interiorSector, outdoorSector } from '../../core/test/support/worldFixture.ts';
import { carrying, inventoryFrame, item } from './helpers/inventory';
import { clientEntity, enterSpaceFrame, entityFrame, makeDoor, sectorFrame } from './helpers/worldFixture';
import { NO_STATS, PICKUP_REACH, SOMNIO_CONSTANTS, bountyIdOf, fullPools, headingFromVector, reachDistance } from '@somnio/core';
import type { QuestMarker } from '@somnio/core';
import { SOMNIO_PROTOCOL_CONSTANTS } from '@somnio/protocol';
import type { RaisingState, SomnioMessage } from '@somnio/protocol';

/**
 * The gameplay half of the client.
 *
 * The self/remote split of the position frames and the door latch are the places a slip stays
 * invisible until a player notices rubber-banding or lands in the wrong space, which is why they
 * are pinned here.
 */

const FULL = fullPools(NO_STATS);
const MOONSTONE_IN_HAND = inventoryFrame(carrying({ worn: [item('moonstone')] }));
const MOONSTONE_PUT_AWAY = inventoryFrame(carrying({ bag: [item('moonstone')] }));
/** A Fighter who has learned Brace and Lunge. */
const FIGHTER_KIT: SomnioMessage = {
  tag: 'lucidity',
  payload: {
    role: 'fighter',
    ranks: [
      { teachingId: 'strike', rank: 2, practice: 0 },
      { teachingId: 'guard', rank: 1, practice: 0 },
      { teachingId: 'brace', rank: 1, practice: 0 },
      { teachingId: 'lunge', rank: 2, practice: 0 },
    ],
  },
};

interface Rig {
  session: GameplaySession;
  controller: ConnectionController;
  sent: SomnioMessage[];
  /** Every `updatePosition` call. */
  positions: { id: string; x: number; z: number }[];
  gaits: { id: string; gait: string }[];
  /** Every `showSelection` call's entity. */
  selections: (string | undefined)[];
  /** Every `showSelection` call's mark, in step with `selections`. */
  selectionMarks: TargetMark[];
  /** Every `showBlow`, `showAbility`, `showEffects`, `showRaising`, `showMend`, `showSensed`, `showLoot`, `removeLoot`, and `updateCondition` call, by name. */
  shown: unknown[][];
  /** Every `showQuestMarkers` call. */
  questMarkers: ReadonlyMap<string, QuestMarker>[];
  /** Every `showSpeechBubble` call. */
  bubbles: SpeechBubbleRequest[];
  /** Every `showPressMarker` and `liftPressMarker` call, by name. */
  pressMarks: [string, { x: number; z: number }?][];
  /** What the scene answers a bubble with: whether it pinned it at the edge. */
  pinsBubbles: boolean;
  /** The clock remote reports are stamped with. */
  now: number;
}

function makeRig(options: { coarsePointer?: boolean } = {}): Rig {
  const { factory } = fakeSocketFactory();
  const sent: SomnioMessage[] = [];
  const positions: Rig['positions'] = [];
  const gaits: Rig['gaits'] = [];
  const selections: Rig['selections'] = [];
  const selectionMarks: Rig['selectionMarks'] = [];
  const shown: Rig['shown'] = [];
  const questMarkers: Rig['questMarkers'] = [];
  const bubbles: Rig['bubbles'] = [];
  const pressMarks: Rig['pressMarks'] = [];

  const controller = new ConnectionController({
    transport: new GameplayTransport(factory),
    resolveURL: () => 'ws://test/ws',
    registry: TEST_REGISTRY,
    renderSurface: {
      ...noopRenderSurface,
      updatePosition: (id, position) => positions.push({ id, x: position.x, z: position.z }),
      updateGait: (id, gait) => gaits.push({ id, gait }),
      showSelection: (id, mark) => {
        selections.push(id);
        selectionMarks.push(mark);
      },
      showBlow: (...blow) => shown.push(['showBlow', ...blow]),
      showRaising: (...raising) => shown.push(['showRaising', ...raising]),
      showMend: (...mend) => shown.push(['showMend', ...mend]),
      showSensed: (...sensed) => shown.push(['showSensed', ...sensed]),
      showQuestMarkers: (markers) => questMarkers.push(markers),
      showLoot: (...loot) => shown.push(['showLoot', ...loot]),
      removeLoot: (...loot) => shown.push(['removeLoot', ...loot]),
      showAbility: (...ability) => shown.push(['showAbility', ...ability]),
      showEffects: (...effects) => shown.push(['showEffects', ...effects]),
      updateCondition: (...condition) => shown.push(['updateCondition', ...condition]),
      showPressMarker: (point) => pressMarks.push(['show', point]),
      liftPressMarker: () => pressMarks.push(['lift']),
      showSpeechBubble: (request) => {
        bubbles.push(request);
        return rig.pinsBubbles;
      },
    },
  });

  const rig: Rig = {
    session: undefined as unknown as GameplaySession,
    controller,
    sent,
    positions,
    gaits,
    selections,
    selectionMarks,
    shown,
    questMarkers,
    bubbles,
    pressMarks,
    pinsBubbles: false,
    now: 0,
  };
  rig.session = new GameplaySession({
    controller,
    send: (message) => sent.push(message),
    ...options,
    measureText: (line) => line.length * 6,
    now: () => rig.now,
  });
  return rig;
}

/** A `raising` snapshot of the raise on `targetId`, held by `healerIds`. */
function raisingFrame(targetId: string, healerIds: string[], state: RaisingState, progress = 0, seconds = state === 'holding' ? 6 : 0): SomnioMessage {
  return { tag: 'raising', payload: { targetId, healerIds, state, progress, seconds } };
}

/** Five metres from (10, 10) toward the top of the screen, heading 215. */
const UP_SCREEN = { x: 10 - 5 * Math.sin((35 * Math.PI) / 180), z: 10 - 5 * Math.cos((35 * Math.PI) / 180) };

/** Ticks every 50 ms from `fromMs`, until `done` or `toMs`, and answers the time it stopped at. */
function tickUntil(rig: Rig, fromMs: number, toMs: number, done: () => boolean): number {
  let time = fromMs;
  for (; time <= toMs && !done(); time += 50) rig.session.runTick(time);
  return time;
}

/** A player at (10, 10) with full pools, a nightmare (`monster:1`) 6 m east, an NPC (`npc:Meadow/guard`) 6 m south, and Bren 6 m west. */
function meadowOfBodies(options: { coarsePointer?: boolean } = {}): Rig {
  const rig = makeRig(options);
  rig.controller.dispatch(enterSpaceFrame());
  rig.controller.dispatch(sectorFrame(outdoorSector('Meadow', { x: 0, z: 0 })));
  rig.controller.dispatch(entityFrame());
  rig.controller.dispatch(entityFrame({ id: 'monster:1', kind: 'monster', name: 'Ghost', x: 16, z: 10 }));
  rig.controller.dispatch(entityFrame({ id: 'npc:Meadow/guard', kind: 'npc', name: 'Guard', x: 10, z: 16 }));
  rig.controller.dispatch(entityFrame({ id: 'bren', kind: 'player', name: 'Bren', x: 4, z: 10 }));
  rig.controller.dispatch({ tag: 'energy', payload: FULL });
  return rig;
}

/** A tap on the ground at `point`: pressed there and let go at once. */
function tapGround(rig: Rig, point: { x: number; z: number }, timeMs = 0): void {
  rig.session.pressGround(point, timeMs);
  rig.session.release(point);
}

function attach(rig: Rig, entities: readonly ClientEntity[]): void {
  for (const each of entities) rig.controller.entities.set(each.id, each);
  rig.controller.selfId = 'self';
  rig.controller.connectionState = 'attached';
}

describe('remote moves', () => {
  /**
   * Every remote entity arrives in the same batch, so one cadence serves them all. A separate,
   * longer glide for one kind would leave it trailing its reported position.
   */
  it.each(['peer', 'npc', 'monster'] as const)('glides a %s to its reported position over one batch interval', (kind) => {
    const rig = makeRig();
    attach(rig, [clientEntity(), clientEntity({ id: 'other', kind, position: { x: 2, z: 2 } })]);

    rig.now = 1000;
    rig.controller.dispatch({ tag: 'moves', payload: { moves: [{ id: 'other', x: 3, z: 2, facing: 90, gait: 'run' }] } });

    // The record keeps the drawn position until a tick samples the glide.
    expect(rig.controller.entities.get('other')?.position).toEqual({ x: 2, z: 2 });
    rig.session.runTick(1000 + (REMOTE_INTERPOLATION_SECONDS * 1000) / 2);
    expect(rig.controller.entities.get('other')?.position).toEqual({ x: 2.5, z: 2 });
    rig.session.runTick(1000 + REMOTE_INTERPOLATION_SECONDS * 1000);
    expect(rig.controller.entities.get('other')?.position).toEqual({ x: 3, z: 2 });
    expect(rig.positions.filter((write) => write.id === 'other').at(-1)).toEqual({ id: 'other', x: 3, z: 2 });
    expect(REMOTE_INTERPOLATION_SECONDS).toBe(0.1);
  });

  it('takes the facing and gait at once', () => {
    const rig = makeRig();
    attach(rig, [clientEntity(), clientEntity({ id: 'other', kind: 'peer' })]);

    rig.controller.dispatch({ tag: 'moves', payload: { moves: [{ id: 'other', x: 3, z: 2, facing: 450, gait: 'run' }] } });

    expect(rig.controller.entities.get('other')).toMatchObject({ facing: 90, gait: 'run' });
    expect(rig.gaits).toEqual([{ id: 'other', gait: 'run' }]);
  });

  it('starts a new glide from where the entity is drawn, not from its last target', () => {
    const rig = makeRig();
    attach(rig, [clientEntity(), clientEntity({ id: 'other', kind: 'peer', position: { x: 2, z: 2 } })]);
    rig.controller.dispatch({ tag: 'moves', payload: { moves: [{ id: 'other', x: 3, z: 2, facing: 0, gait: 'jog' }] } });
    rig.session.runTick(50);

    rig.now = 50;
    rig.controller.dispatch({ tag: 'moves', payload: { moves: [{ id: 'other', x: 2.5, z: 4, facing: 0, gait: 'jog' }] } });
    rig.session.runTick(100);

    // Halfway from (2.5, 2), where it stood on screen. From (3, 2) it would jump sideways first.
    expect(rig.controller.entities.get('other')?.position).toEqual({ x: 2.5, z: 3 });
  });

  it('starts a new glide from where the last one reached when no tick drew it, as in a hidden tab', () => {
    const rig = makeRig();
    attach(rig, [clientEntity(), clientEntity({ id: 'other', kind: 'peer', position: { x: 2, z: 2 } })]);
    rig.controller.dispatch({ tag: 'moves', payload: { moves: [{ id: 'other', x: 3, z: 2, facing: 0, gait: 'jog' }] } });

    rig.now = 1000;
    rig.controller.dispatch({ tag: 'moves', payload: { moves: [{ id: 'other', x: 6, z: 2, facing: 0, gait: 'jog' }] } });
    rig.session.runTick(1000 + (REMOTE_INTERPOLATION_SECONDS * 1000) / 2);

    // Halfway from (3, 2), where the first glide ended. From (2, 2), the last drawn spot, it would be (4, 2).
    expect(rig.controller.entities.get('other')?.position).toEqual({ x: 4.5, z: 2 });
  });

  it('drops the glide when the entity is placed again', () => {
    const rig = makeRig();
    attach(rig, [clientEntity(), clientEntity({ id: 'other', kind: 'peer', position: { x: 2, z: 2 } })]);
    rig.controller.dispatch({ tag: 'moves', payload: { moves: [{ id: 'other', x: 3, z: 2, facing: 0, gait: 'jog' }] } });

    rig.controller.dispatch(entityFrame({ id: 'other', x: 8, z: 8 }));
    rig.session.runTick(100);

    expect(rig.controller.entities.get('other')?.position).toEqual({ x: 8, z: 8 });
  });

  it('ignores a move for the local player and for an entity it does not know', () => {
    const rig = makeRig();
    attach(rig, [clientEntity()]);

    rig.controller.dispatch({
      tag: 'moves',
      payload: {
        moves: [
          { id: 'self', x: 1, z: 1, facing: 0, gait: 'jog' },
          { id: 'stranger', x: 1, z: 1, facing: 0, gait: 'jog' },
        ],
      },
    });
    rig.session.runTick(100);

    // The local player is predicted; the server's only word on its position is `correction`.
    expect(rig.controller.entities.get('self')?.position).toEqual({ x: 10, z: 10 });
    expect(rig.gaits.filter((write) => write.id === 'stranger')).toEqual([]);
  });
});

describe('correction', () => {
  /**
   * Written directly, never glided: the predictor writes this node every frame and also drives
   * the camera, so an interpolation would fight it and de-centre the view.
   */
  it('snaps the local player to the last accepted position', () => {
    const rig = makeRig();
    attach(rig, [clientEntity()]);

    rig.controller.dispatch({ tag: 'correction', payload: { x: 4, z: 5 } });

    expect(rig.controller.entities.get('self')?.position).toEqual({ x: 4, z: 5 });
    expect(rig.positions).toEqual([{ id: 'self', x: 4, z: 5 }]);
  });
});

describe('walking', () => {
  /** Joins an empty meadow standing at (10, 10), facing south. */
  function standing(options: { coarsePointer?: boolean } = {}): {
    rig: Rig;
    ticks: (fromMs: number, toMs: number) => void;
    at: () => { x: number; z: number };
  } {
    const rig = makeRig(options);
    rig.controller.dispatch(enterSpaceFrame());
    rig.controller.dispatch(sectorFrame(outdoorSector('Meadow', { x: 0, z: 0 })));
    rig.controller.dispatch(entityFrame());
    rig.controller.dispatch({ tag: 'energy', payload: FULL });
    return {
      rig,
      ticks: (fromMs, toMs) => {
        for (let time = fromMs; time <= toMs; time += 50) rig.session.runTick(time);
      },
      at: () => rig.controller.entities.get('self')!.position,
    };
  }

  const near = (a: { x: number; z: number }, b: { x: number; z: number }): boolean => Math.hypot(a.x - b.x, a.z - b.z) <= PATH_FOLLOWING.arrivalMetres;

  /** A finger never lifts exactly where it landed, so a tap goes where it was meant. */
  it('walks to where a tap on the ground landed, not where it lets go', () => {
    const { rig, ticks, at } = standing();

    rig.session.pressGround({ x: 12, z: 10 }, 0);
    ticks(0, 100);
    expect(at()).toEqual({ x: 10, z: 10 });
    rig.session.release({ x: 12, z: 11 });
    ticks(150, 3000);

    expect(near(at(), { x: 12, z: 10 })).toBe(true);
    expect(rig.session.predictor.walk).toBeUndefined();
  });

  it('steers at once a press that moved too far to be a tap, and walks on to where it lets go', () => {
    const { rig, ticks } = standing();

    rig.session.pressGround({ x: 14, z: 10 }, 0);
    rig.session.moveHold({ x: 14, z: 12 });
    rig.session.steer();
    ticks(0, 50);
    expect(rig.session.predictor.walk).toEqual({ kind: 'steer', toward: { x: 14, z: 12 } });

    rig.session.release({ x: 13, z: 12 });
    expect(rig.session.predictor.walk).toMatchObject({ kind: 'path', destination: { x: 13, z: 12 } });
  });

  it('steers toward the ground under a press held past the hold, and walks on to where it lets go', () => {
    const { rig, ticks, at } = standing();

    rig.session.pressGround({ x: 14, z: 10 }, 0);
    ticks(0, HOLD_TO_STEER_MS - 50);
    expect(rig.session.predictor.walk).toBeUndefined();
    ticks(HOLD_TO_STEER_MS, 600);
    expect(rig.session.predictor.walk).toEqual({ kind: 'steer', toward: { x: 14, z: 10 } });
    expect(at().x).toBeGreaterThan(10);
    expect(at().z).toBeCloseTo(10, 9);

    rig.session.moveHold({ x: 12, z: 14 });
    ticks(650, 700);
    expect(rig.session.predictor.walk).toEqual({ kind: 'steer', toward: { x: 12, z: 14 } });

    rig.session.release({ x: 11, z: 13 });
    expect(rig.session.predictor.walk).toMatchObject({ kind: 'path', destination: { x: 11, z: 13 } });
    ticks(750, 4000);
    expect(near(at(), { x: 11, z: 13 })).toBe(true);
  });

  it('drops a ring where a tap lands and keeps it there until the walk arrives', () => {
    const { rig, ticks, at } = standing();

    tapGround(rig, { x: 12, z: 10 });
    ticks(0, 100);
    expect(rig.pressMarks).toEqual([['show', { x: 12, z: 10 }]]);

    ticks(150, 3000);
    expect(near(at(), { x: 12, z: 10 })).toBe(true);
    expect(rig.pressMarks).toEqual([['show', { x: 12, z: 10 }], ['lift']]);
  });

  it('moves the ring with a steer, keeps it where the steer lets go, and lifts it as the next press drops its own', () => {
    const { rig, ticks } = standing();

    rig.session.pressGround({ x: 14, z: 10 }, 1000);
    rig.session.moveHold({ x: 14, z: 11 });
    ticks(1000 + HOLD_TO_STEER_MS, 1000 + HOLD_TO_STEER_MS);
    rig.session.moveHold({ x: 14, z: 12 });
    rig.session.release({ x: 13, z: 12 });
    ticks(1250, 1300);
    expect(rig.session.predictor.walk).toMatchObject({ kind: 'path', destination: { x: 13, z: 12 } });
    expect(rig.pressMarks).toEqual([
      ['show', { x: 14, z: 10 }],
      ['show', { x: 14, z: 12 }],
      ['show', { x: 13, z: 12 }],
    ]);

    rig.pressMarks.length = 0;
    rig.session.pressGround({ x: 8, z: 10 }, 1350);
    expect(rig.pressMarks).toEqual([['lift'], ['show', { x: 8, z: 10 }]]);
  });

  it('keeps the ring of a walk along a path that a let-go leaves running', () => {
    const { rig, ticks } = standing();
    tapGround(rig, { x: 14, z: 10 });

    rig.session.letGo();
    ticks(0, 100);

    expect(rig.session.predictor.walk).toMatchObject({ kind: 'path' });
    expect(rig.pressMarks).toEqual([['show', { x: 14, z: 10 }]]);
  });

  it.each<[string, (rig: Rig) => void]>([
    ['a fall', (rig) => rig.controller.dispatch({ tag: 'condition', payload: { entityId: 'self', condition: 'fallen' } })],
    ['a correction', (rig) => rig.controller.dispatch({ tag: 'correction', payload: { x: 10, z: 10 } })],
    ['an overlay closing the gate', (rig) => (rig.controller.presentedOverlay = { kind: 'gameMenu' })],
    ['a new space', (rig) => rig.controller.dispatch(enterSpaceFrame('Hall'))],
  ])('lifts the ring at the destination when the walk ends at %s', (_label, end) => {
    const { rig, ticks } = standing();
    tapGround(rig, { x: 14, z: 10 });
    ticks(0, 100);

    end(rig);
    ticks(150, 150);

    expect(rig.pressMarks).toEqual([['show', { x: 14, z: 10 }], ['lift']]);
  });

  it('lifts the ring at the destination when the path gives up', () => {
    const rig = makeRig();
    // No sector has arrived, so no search finds a way.
    rig.controller.dispatch(enterSpaceFrame());
    rig.controller.dispatch(entityFrame());
    tapGround(rig, { x: 14, z: 10 });

    const giveUpMs = (PATH_FOLLOWING.maxReplans + 2) * PATH_FOLLOWING.retryMs;
    for (let time = 0; time <= giveUpMs && rig.session.predictor.walk !== undefined; time += 50) rig.session.runTick(time);

    expect(rig.session.predictor.walk).toBeUndefined();
    expect(rig.pressMarks).toEqual([['show', { x: 14, z: 10 }], ['lift']]);
  });

  it('drops a ring where a press lands and lifts it when the press ends without a walk', () => {
    const { rig } = standing();

    rig.session.pressGround({ x: 14, z: 10 }, 2000);
    rig.session.letGo();
    rig.controller.dispatch(entityFrame({ id: 'monster:1', kind: 'monster', x: 10, z: 6 }));
    rig.session.selectEntity('monster:1');
    rig.session.release({ x: 10, z: 6 });
    expect(rig.pressMarks).toEqual([['show', { x: 14, z: 10 }], ['lift']]);
  });

  it.each<[string, (rig: Rig) => void]>([
    ['the chat input takes focus', (rig) => rig.controller.setChatInputFocused(true)],
    ['the page loses the pointer', (rig) => rig.session.handleVisibilityLoss()],
    ['the pointer is lost', (rig) => rig.session.letGo()],
  ])('lets go of a steer when %s, and does not take it up again', (_label, lose) => {
    const { rig, ticks, at } = standing();
    rig.session.pressGround({ x: 14, z: 10 }, 0);
    ticks(0, 400);

    lose(rig);
    rig.controller.setChatInputFocused(false);
    const stopped = at();
    ticks(450, 1000);

    expect(rig.session.predictor.walk).toBeUndefined();
    expect(at()).toEqual(stopped);
  });

  it.each<[string, (rig: Rig) => void]>([
    ['the chat input takes focus', (rig) => rig.controller.setChatInputFocused(true)],
    ['the page loses the pointer', (rig) => rig.session.handleVisibilityLoss()],
    ['the pointer is lost', (rig) => rig.session.letGo()],
  ])('walks on along a path when %s', (_label, lose) => {
    const { rig, ticks, at } = standing();
    tapGround(rig, { x: 14, z: 10 });
    ticks(0, 300);

    lose(rig);
    ticks(350, 3000);

    expect(at().x).toBeCloseTo(14, 1);
  });

  it('uses an ability after the move the heartbeat held back, since the server judges it where the player stands', () => {
    const { rig, ticks, at } = standing();
    rig.controller.dispatch(FIGHTER_KIT);
    tapGround(rig, { x: 14, z: 10 });
    ticks(0, 50);
    rig.session.runTick(75);

    rig.session.useAbility('brace');

    expect(rig.sent.slice(-2)).toEqual([
      { tag: 'move', payload: expect.objectContaining(at()) },
      { tag: 'useAbility', payload: { abilityId: 'brace' } },
    ]);
  });

  it("leaps at the target once the server takes Lunge, by the player's own ability frame, in place of the walk under way", () => {
    const { rig, ticks, at } = standing();
    rig.controller.dispatch(FIGHTER_KIT);
    rig.controller.dispatch(entityFrame({ id: 'monster:1', kind: 'monster', x: 10, z: 7 }));
    tapGround(rig, { x: 14, z: 10 });
    rig.session.useAbility('lunge');
    expect(rig.session.predictor.walk?.kind).toBe('path');
    expect(rig.sent.filter((message) => message.tag === 'useAbility')).toEqual([]);

    rig.session.select('monster:1');
    rig.session.useAbility('lunge');
    expect(rig.sent.at(-1)).toEqual({ tag: 'useAbility', payload: { abilityId: 'lunge' } });
    // The press alone moves the player nowhere new: a use the server refuses must not leap.
    expect(rig.session.predictor.walk?.kind).toBe('path');
    // Another's Lunge moves no one but them.
    rig.controller.dispatch({ tag: 'ability', payload: { entityId: 'peer', abilityId: 'lunge', targetId: 'monster:1' } });
    expect(rig.session.predictor.walk?.kind).toBe('path');

    rig.controller.dispatch({ tag: 'ability', payload: { entityId: 'self', abilityId: 'lunge', targetId: 'monster:1' } });
    expect(rig.session.predictor.walk).toEqual({ kind: 'leap', end: { x: 10, z: 7.6 }, metresPerSecond: 6 });
    ticks(0, 1000);
    expect(at().x).toBeCloseTo(10, 9);
    expect(at().z).toBeCloseTo(7.6, 9);
    expect(rig.session.predictor.walk).toBeUndefined();
  });

  it('leaps at the body the frame names, not at a target chosen since the press', () => {
    const { rig } = standing();
    rig.controller.dispatch(FIGHTER_KIT);
    rig.controller.dispatch(entityFrame({ id: 'monster:1', kind: 'monster', x: 10, z: 7 }));
    rig.controller.dispatch(entityFrame({ id: 'monster:2', kind: 'monster', x: 10, z: 12.5 }));
    rig.session.select('monster:1');
    rig.session.useAbility('lunge');
    expect(rig.sent.at(-1)).toEqual({ tag: 'useAbility', payload: { abilityId: 'lunge' } });

    rig.session.select('monster:2');
    rig.controller.dispatch({ tag: 'ability', payload: { entityId: 'self', abilityId: 'lunge', targetId: 'monster:1' } });
    expect(rig.session.predictor.walk).toEqual({ kind: 'leap', end: { x: 10, z: 7.6 }, metresPerSecond: 6 });
  });

  it('jogs while braced whatever Run says, holding Run off until the effect ends', () => {
    const { rig, ticks } = standing();
    const gaits = (): string[] => rig.sent.flatMap((message) => (message.tag === 'move' ? [message.payload.gait] : []));
    rig.session.toggleRun();
    rig.controller.dispatch({ tag: 'effects', payload: { entityId: 'self', effects: [{ effectId: 'braced', seconds: 4 }] } });
    tapGround(rig, { x: 18, z: 10 });
    ticks(0, 200);
    expect(rig.session.runHeldOff).toBe(true);
    expect(gaits().at(-1)).toBe('jog');

    rig.controller.dispatch({ tag: 'effects', payload: { entityId: 'self', effects: [] } });
    // Only the player's own effects hold them, not those of a dreamer they target.
    rig.controller.dispatch({ tag: 'effects', payload: { entityId: 'other', effects: [{ effectId: 'braced', seconds: 4 }] } });
    ticks(250, 450);
    expect(rig.session.runHeldOff).toBe(false);
    expect(gaits().at(-1)).toBe('run');
  });

  it('walks nowhere on a press while fallen', () => {
    const { rig, ticks, at } = standing();
    rig.controller.dispatch({ tag: 'condition', payload: { entityId: 'self', condition: 'fallen' } });

    tapGround(rig, { x: 14, z: 10 });
    ticks(0, 500);

    expect(rig.session.predictor.walk).toBeUndefined();
    expect(at()).toEqual({ x: 10, z: 10 });
  });

  it('runs while Run is on, and jogs again once it is off', () => {
    const { rig, ticks } = standing();
    const gaits = (): string[] => rig.sent.flatMap((message) => (message.tag === 'move' ? [message.payload.gait] : []));
    tapGround(rig, { x: 18, z: 10 });

    rig.session.toggleRun();
    ticks(0, 200);
    expect(rig.session.running).toBe(true);
    expect(gaits().at(-1)).toBe('run');

    rig.session.toggleRun();
    ticks(250, 450);
    expect(gaits().at(-1)).toBe('jog');
  });

  it('faces the cursor on a fine pointer, and the way it walks on a coarse one', () => {
    const fine = standing();
    const coarse = standing({ coarsePointer: true });
    for (const { rig } of [fine, coarse]) {
      rig.session.aimAt({ x: 10, z: -1000 });
      tapGround(rig, { x: 14, z: 10 });
    }

    fine.ticks(0, 200);
    coarse.ticks(0, 200);

    expect(fine.rig.controller.entities.get('self')!.facing).toBeCloseTo(180, 0);
    expect(coarse.rig.controller.entities.get('self')!.facing).toBeCloseTo(90, 9);
  });

  it('faces its target on a coarse pointer while it walks another way only with the gaze locked on it', () => {
    const { rig, ticks } = standing({ coarsePointer: true });
    rig.controller.dispatch(entityFrame({ id: 'monster:1', kind: 'monster', x: 10, z: 6 }));
    rig.session.selectEntity('monster:1');
    tapGround(rig, { x: 14, z: 10 });
    ticks(0, 200);
    expect(rig.controller.entities.get('self')!.facing).toBeCloseTo(90, 9);

    rig.session.toggleGazeLock();
    ticks(250, 450);

    const self = rig.controller.entities.get('self')!;
    expect(self.position.x).toBeGreaterThan(10.1);
    // Faced from where the last step began, a few centimetres back.
    expect(Math.abs(self.facing - headingFromVector(10 - self.position.x, 6 - self.position.z))).toBeLessThan(1);
  });
});

describe('the door latch', () => {
  /** Toward the bottom of the screen from wherever the player stands, heading 35. */
  const steerDown = (rig: Rig): void => {
    const at = rig.controller.entities.get('self')!.position;
    rig.session.predictor.steerToward({ x: at.x + 10 * Math.sin((35 * Math.PI) / 180), z: at.z + 10 * Math.cos((35 * Math.PI) / 180) });
  };
  const meadow = outdoorSector('Meadow', { x: 0, z: 0 }, makeDoor('exit', { x: 10, z: 12 }, { sector: 'Hall', door: 'entry' }));

  const NOON = 12 * 3600;

  /** Joins the meadow at `worldSeconds`, walks south into the door's trigger, and stops there waiting for the server. */
  function waitAtDoor(sector = meadow, worldSeconds = 0): { rig: Rig; tick: () => void; framesAfter: (count: number) => SomnioMessage[] } {
    const rig = makeRig();
    let time = 0;
    const tick = (): void => {
      rig.session.runTick(time);
      time += 100;
    };
    rig.controller.dispatch(enterSpaceFrame('outdoors', worldSeconds));
    rig.controller.dispatch(sectorFrame(sector));
    rig.controller.dispatch(entityFrame({ x: 9.5, z: 11, facing: 30 }));
    steerDown(rig);
    for (let index = 0; index < 5; index += 1) tick();
    expect(rig.sent.filter((message) => message.tag === 'useDoor')).toHaveLength(1);
    return {
      rig,
      tick,
      framesAfter: (count) => {
        const before = rig.sent.length;
        for (let index = 0; index < count; index += 1) tick();
        return rig.sent.slice(before);
      },
    };
  }

  it('holds through a correction that arrives while the door is pending', () => {
    const { rig, framesAfter } = waitAtDoor();

    rig.controller.dispatch({ tag: 'correction', payload: { x: 9.5, z: 11 } });

    // A correction answers an earlier move, not the door, so it cannot be what releases the wait.
    expect(framesAfter(3)).toEqual([]);
    expect(rig.controller.entities.get('self')?.position).toEqual({ x: 9.5, z: 11 });
  });

  it('holds through a blur', () => {
    const { rig, framesAfter } = waitAtDoor();

    rig.session.handleVisibilityLoss();

    expect(framesAfter(3)).toEqual([]);
  });

  it('is released by doorRefused, without asking again while the player still leans on the door', () => {
    const { rig, framesAfter } = waitAtDoor();

    rig.controller.dispatch({ tag: 'doorRefused', payload: { sector: 'Meadow', doorId: 'exit' } });
    steerDown(rig);

    const frames = framesAfter(3);
    expect(frames.some((message) => message.tag === 'move')).toBe(true);
    expect(frames.some((message) => message.tag === 'useDoor')).toBe(false);
  });

  it('says a door that opens only at night is shut by day, once however long the player leans on it', () => {
    const nightOnly = { ...meadow, doors: meadow.doors.map((door) => ({ ...door, nightOnly: true as const })) };
    const { rig, framesAfter } = waitAtDoor(nightOnly, NOON);

    rig.controller.dispatch({ tag: 'doorRefused', payload: { sector: 'Meadow', doorId: 'exit' } });
    steerDown(rig);

    expect(framesAfter(3).some((message) => message.tag === 'useDoor')).toBe(false);
    expect(rig.controller.chatHistory).toEqual([{ kind: 'doorOpensAtNight' }]);
  });

  it.each([
    ['a door that opens only at night, refused at night', true, 0],
    ['a door open at every hour, refused by day', false, NOON],
  ])('says nothing of the night for %s', (_label, nightOnly, worldSeconds) => {
    const sector = nightOnly ? { ...meadow, doors: meadow.doors.map((door) => ({ ...door, nightOnly: true as const })) } : meadow;
    const { rig } = waitAtDoor(sector, worldSeconds);

    rig.controller.dispatch({ tag: 'doorRefused', payload: { sector: 'Meadow', doorId: 'exit' } });

    expect(rig.controller.chatHistory).toEqual([]);
  });

  it('is released by enterSpace, and the door in the new space is armed', () => {
    const { rig, framesAfter } = waitAtDoor();
    const hall = interiorSector('Hall', makeDoor('entry', { x: 5, z: 6 }, { sector: 'Meadow', door: 'exit' }));

    rig.controller.dispatch(enterSpaceFrame('Hall'));
    rig.controller.dispatch(sectorFrame(hall));
    rig.controller.dispatch(entityFrame({ x: 4.5, z: 5, facing: 30 }));
    steerDown(rig);

    const frames = framesAfter(5);
    expect(frames[0]).toMatchObject({ tag: 'move', payload: { x: 4.5, z: 5 } });
    expect(frames.filter((message) => message.tag === 'useDoor')).toEqual([{ tag: 'useDoor', payload: { sector: 'Hall', doorId: 'entry' } }]);
  });
});

describe('a press held through a door', () => {
  const meadow = outdoorSector('Meadow', { x: 0, z: 0 }, makeDoor('exit', { x: 10, z: 12 }, { sector: 'Hall', door: 'entry' }));
  /** Its door's trigger reaches 0.58 m north of (5, 6), and a body arriving through it stands at (5, 5.2). */
  const hall = interiorSector('Hall', makeDoor('entry', { x: 5, z: 6 }, { sector: 'Meadow', door: 'exit' }));
  const ARRIVAL = { x: 5, z: 5.2 };

  /** Joins the meadow north of its door, ticking every 50 ms from then on. */
  function nearDoor(): { rig: Rig; ticks: (count: number) => void; at: () => { x: number; z: number } | undefined; doorsAsked: () => number } {
    const rig = makeRig();
    let time = 0;
    rig.controller.dispatch(enterSpaceFrame());
    rig.controller.dispatch(sectorFrame(meadow));
    rig.controller.dispatch(entityFrame({ x: 9.5, z: 11, facing: 180 }));
    return {
      rig,
      ticks: (count) => {
        for (let index = 0; index < count; index += 1) {
          rig.session.runTick(time);
          time += 50;
        }
      },
      at: () => rig.controller.entities.get('self')?.position,
      doorsAsked: () => rig.sent.filter((message) => message.tag === 'useDoor').length,
    };
  }

  /** The door's answer: the hall, and the player standing in it. */
  function enterHall(rig: Rig): void {
    rig.controller.dispatch(enterSpaceFrame('Hall'));
    rig.controller.dispatch(sectorFrame(hall));
    rig.controller.dispatch(entityFrame({ ...ARRIVAL, facing: 180 }));
  }

  it('steers on in the space it leads to, toward the ground under the pointer once the player stands there', () => {
    const { rig, ticks, at, doorsAsked } = nearDoor();
    rig.session.pressGround({ x: 9.5, z: 16 }, 0);
    expect(rig.session.predictor.arrivalsAct).toBe(true);
    ticks(12);
    expect(doorsAsked()).toBe(1);
    // No walk's end acts while the door's answer is pending, a following walk's included.
    expect(rig.session.predictor.arrivalsAct).toBe(false);

    rig.controller.dispatch(enterSpaceFrame('Hall'));
    rig.controller.dispatch(sectorFrame(hall));
    // The camera still frames the meadow, so the ground it finds under the pointer is not the hall's.
    rig.session.moveHold({ x: 9.5, z: 16 });
    ticks(2);
    rig.controller.dispatch(entityFrame({ ...ARRIVAL, facing: 180 }));
    ticks(2);
    expect(rig.session.predictor.walk).toBeUndefined();
    expect(at()).toEqual(ARRIVAL);

    rig.session.moveHold({ x: 5, z: 1 });
    ticks(10);
    expect(rig.session.predictor.walk).toEqual({ kind: 'steer', toward: { x: 5, z: 1 } });
    expect(at()!.z).toBeLessThan(ARRIVAL.z - 0.5);
    expect(doorsAsked()).toBe(1);
    expect(rig.pressMarks.at(-1)).toEqual(['show', { x: 5, z: 1 }]);

    rig.session.release({ x: 5, z: 2 });
    expect(rig.session.predictor.walk).toMatchObject({ kind: 'path', destination: { x: 5, z: 2 } });
    expect(rig.pressMarks.at(-1)).toEqual(['show', { x: 5, z: 2 }]);
  });

  it('takes the player back through the door only when they are steered back into its trigger', () => {
    const { rig, ticks, doorsAsked } = nearDoor();
    rig.session.pressGround({ x: 9.5, z: 16 }, 0);
    ticks(12);
    enterHall(rig);

    rig.session.moveHold({ x: 5, z: 9 });
    ticks(10);

    expect(rig.sent.filter((message) => message.tag === 'useDoor').at(-1)).toEqual({ tag: 'useDoor', payload: { sector: 'Hall', doorId: 'entry' } });
    expect(doorsAsked()).toBe(2);
  });

  it('ends a tapped path at the door, whose destination belongs to the space left', () => {
    const { rig, ticks, at, doorsAsked } = nearDoor();
    tapGround(rig, { x: 9.5, z: 11.8 });
    ticks(12);
    expect(doorsAsked()).toBe(1);

    enterHall(rig);
    ticks(20);

    expect(rig.session.predictor.walk).toBeUndefined();
    expect(at()).toEqual(ARRIVAL);
  });

  it('walks nowhere when let go of before the player stands in the space it leads to', () => {
    const { rig, ticks, at } = nearDoor();
    rig.session.pressGround({ x: 9.5, z: 16 }, 0);
    ticks(12);
    rig.controller.dispatch(enterSpaceFrame('Hall'));
    rig.controller.dispatch(sectorFrame(hall));

    rig.session.release({ x: 9.5, z: 16 });
    rig.controller.dispatch(entityFrame({ ...ARRIVAL, facing: 180 }));
    ticks(20);

    expect(rig.session.predictor.walk).toBeUndefined();
    expect(at()).toEqual(ARRIVAL);
    expect(rig.pressMarks.at(-1)).toEqual(['lift']);
  });
});

describe('outbound chat', () => {
  it('does not send while unattached, and sends once attached', () => {
    const rig = makeRig();
    rig.controller.selfId = 'self';
    rig.controller.entities.set('self', clientEntity());

    rig.session.submitChat('hello');
    expect(rig.sent).toEqual([]);

    rig.controller.connectionState = 'attached';
    rig.session.submitChat('hello');
    expect(rig.sent).toEqual([{ tag: 'clientSay', payload: { text: 'hello', kind: 'say' } }]);
  });

  it.each([
    ['/w hi', 'whisper', 'hi'],
    ['/flüstern hi', 'whisper', 'hi'],
    ['/Y HI', 'yell', 'HI'],
    ['/schreien  Hilfe!', 'yell', 'Hilfe!'],
    ['/s hallo', 'say', 'hallo'],
    ['  /w hi', 'whisper', 'hi'],
  ] as const)('speaks %j as a %s of %j, for that line alone', (input, kind, text) => {
    const rig = makeRig();
    attach(rig, [clientEntity()]);

    rig.session.submitChat(input);
    rig.session.submitChat('and now?');

    expect(rig.sent).toEqual([
      { tag: 'clientSay', payload: { text, kind } },
      { tag: 'clientSay', payload: { text: 'and now?', kind: 'say' } },
    ]);
    expect(rig.controller.chatHistory[0]).toMatchObject({ kind: 'spokenByOwn', message: text, speech: kind });
    expect(rig.bubbles[0]).toMatchObject({ entityId: 'self', kind, clarity: 1 });
  });

  it.each(['/x hi', '  /x hi'])('sends nothing for a command it does not know, and says so: %j', (input) => {
    const rig = makeRig();
    attach(rig, [clientEntity()]);

    rig.session.submitChat(input);

    expect(rig.sent).toEqual([]);
    expect(rig.controller.chatHistory).toEqual([{ kind: 'unknownCommand', command: '/x' }]);
  });

  it.each(['/w', '/w   ', '/'])('sends nothing, and says nothing, for %j', (input) => {
    const rig = makeRig();
    attach(rig, [clientEntity()]);

    rig.session.submitChat(input);

    expect(rig.sent).toEqual([]);
    expect(rig.controller.chatHistory).toEqual([]);
  });

  it('drops a blank line rather than sending an empty frame', () => {
    const rig = makeRig();
    attach(rig, [clientEntity()]);

    rig.session.submitChat('   ');

    expect(rig.sent).toEqual([]);
  });

  /** The cap is in UTF-8 bytes, so a string of multi-byte characters truncates well before 256 of them. */
  it('truncates outbound text on byte length, not code-unit length', () => {
    const rig = makeRig();
    attach(rig, [clientEntity()]);

    rig.session.submitChat('ä'.repeat(200));

    const frame = rig.sent[0];
    if (frame?.tag !== 'clientSay') throw new Error('expected a clientSay frame');
    expect(new TextEncoder().encode(frame.payload.text).length).toBeLessThanOrEqual(256);
  });
});

describe('the Bag', () => {
  it('reports the purse balance to chat', () => {
    const rig = makeRig();
    rig.controller.connectionState = 'attached';
    rig.controller.dispatch(inventoryFrame(carrying({ coins: 7 })));

    rig.session.tellPurse();

    expect(rig.sent).toEqual([]);
    expect(rig.controller.chatHistory.at(-1)).toEqual({ kind: 'purseBalance', coins: 7 });
  });

  it('wears an item by its id, in the slot asked for when one is, and puts a worn one away by its slot', () => {
    const rig = makeRig();
    rig.controller.connectionState = 'attached';

    rig.session.equip('moonstone-1');
    rig.session.equip('ring-1', 'ring2');
    rig.session.unequip('head');

    expect(rig.sent).toEqual([
      { tag: 'equip', payload: { itemId: 'moonstone-1' } },
      { tag: 'equip', payload: { itemId: 'ring-1', slot: 'ring2' } },
      { tag: 'unequip', payload: { slot: 'head' } },
    ]);
  });

  it('moves an item to a place in the bag, and asks nothing the rule refuses', () => {
    const rig = makeRig();
    rig.controller.connectionState = 'attached';
    const full = Array.from({ length: SOMNIO_PROTOCOL_CONSTANTS.maxBagItems }, (_, index) => item('cap', `cap-${index}`));
    rig.controller.dispatch(inventoryFrame(carrying({ worn: [item('cudgel')], bag: full })));

    rig.session.moveItem('cap-0', 9);
    rig.session.moveItem('cudgel-1', 3);
    rig.session.moveItem('nothing', 3);

    expect(rig.sent).toEqual([{ tag: 'moveItem', payload: { itemId: 'cap-0', place: 9 } }]);
  });

  it('puts nothing away into a full bag', () => {
    const rig = makeRig();
    rig.controller.connectionState = 'attached';
    const bag = Array.from({ length: SOMNIO_PROTOCOL_CONSTANTS.maxBagItems }, (_, index) => item('cap', `cap-${index}`));
    rig.controller.dispatch(inventoryFrame(carrying({ worn: [item('cudgel')], bag })));

    rig.session.unequip('mainHand');

    expect(rig.sent).toEqual([]);
  });

  it('drops an item from the bag by its id, and nothing while the player lies fallen', () => {
    const rig = makeRig();
    rig.controller.dispatch(enterSpaceFrame());
    rig.controller.dispatch(entityFrame());
    rig.controller.connectionState = 'attached';
    rig.controller.dispatch(inventoryFrame(carrying({ bag: [item('cap', 'cap-1'), item('cap', 'cap-2')] })));

    rig.session.dropItem('cap-1');
    rig.controller.dispatch({ tag: 'condition', payload: { entityId: 'self', condition: 'fallen' } });
    rig.session.dropItem('cap-2');

    expect(rig.sent.filter((message) => message.tag === 'dropItem')).toEqual([{ tag: 'dropItem', payload: { itemId: 'cap-1', heading: 0 } }]);
  });

  it.each<[string, boolean, number]>([
    ['toward the cursor on a fine pointer', false, 180],
    ['the way the player faces on a coarse pointer', true, 90],
  ])('throws toward where a drag lets go, else %s, facing the throw as it reports', (_label, coarsePointer, second) => {
    const rig = makeRig({ coarsePointer });
    rig.controller.dispatch(enterSpaceFrame());
    rig.controller.dispatch(entityFrame());
    rig.controller.connectionState = 'attached';
    rig.controller.dispatch(inventoryFrame(carrying({ bag: [item('cap', 'cap-1'), item('cap', 'cap-2')] })));

    rig.session.dropItem('cap-1', { x: 12, z: 10 });
    rig.session.aimAt({ x: 10, z: 7 });
    rig.session.dropItem('cap-2');

    expect(rig.sent.filter((message) => message.tag === 'move' || message.tag === 'dropItem')).toEqual([
      { tag: 'move', payload: { x: 10, z: 10, facing: 90, gait: 'jog' } },
      { tag: 'dropItem', payload: { itemId: 'cap-1', heading: 90 } },
      ...(second === 90 ? [] : [{ tag: 'move', payload: { x: 10, z: 10, facing: second, gait: 'jog' } }]),
      { tag: 'dropItem', payload: { itemId: 'cap-2', heading: second } },
    ]);
  });

  it('drops a worn item in one request, whatever room the bag has, and never the Moonstone', () => {
    const rig = makeRig();
    rig.controller.dispatch(enterSpaceFrame());
    rig.controller.dispatch(entityFrame());
    rig.controller.connectionState = 'attached';
    const full = Array.from({ length: SOMNIO_PROTOCOL_CONSTANTS.maxBagItems }, (_, index) => item('boots', `boots-${index}`));
    rig.controller.dispatch(inventoryFrame(carrying({ worn: [item('sword'), item('moonstone')], bag: full })));

    rig.session.dropItem('sword-1');
    rig.session.dropItem('moonstone-1');

    expect(rig.sent.filter((message) => message.tag === 'unequip' || message.tag === 'dropItem')).toEqual([
      { tag: 'dropItem', payload: { itemId: 'sword-1', heading: 0 } },
    ]);
  });

  it('announces what was dropped', () => {
    const rig = makeRig();
    rig.controller.dispatch(inventoryFrame(carrying({ bag: [item('cap')] })));
    rig.controller.dispatch(inventoryFrame(carrying(), { dropped: { kind: 'item', baseId: 'cap', rarity: 'plain' } }));
    expect(rig.controller.chatHistory).toEqual([{ kind: 'dropped', contents: { kind: 'item', baseId: 'cap', rarity: 'plain' } }]);
  });
});

describe('a drop', () => {
  const DAGGER_DROP = { kind: 'item', baseId: 'dagger', rarity: 'magic' } as const;
  const lootFrame = (lootId: string, at: { x: number; z: number }): SomnioMessage => ({ tag: 'loot', payload: { lootId, ...at, contents: DAGGER_DROP } });
  const pickUps = (rig: Rig) => rig.sent.filter((message) => message.tag === 'pickUp');
  const at = (rig: Rig) => rig.controller.entities.get('self')!.position;
  const away = (rig: Rig, point: { x: number; z: number }) => Math.hypot(at(rig).x - point.x, at(rig).z - point.z);

  /** Joins an empty meadow standing at (10, 10), with a dagger lying at (14, 10). */
  function nearLoot(): Rig {
    const rig = makeRig();
    rig.controller.dispatch(enterSpaceFrame());
    rig.controller.dispatch(sectorFrame(outdoorSector('Meadow', { x: 0, z: 0 })));
    rig.controller.dispatch(entityFrame());
    rig.controller.dispatch({ tag: 'energy', payload: FULL });
    rig.controller.dispatch(lootFrame('loot-1', { x: 14, z: 10 }));
    return rig;
  }

  it('is drawn as it arrives, and taken away when it is gone or the space is left', () => {
    const rig = nearLoot();
    rig.controller.dispatch(lootFrame('loot-2', { x: 4, z: 4 }));
    rig.controller.dispatch({ tag: 'lootGone', payload: { lootId: 'loot-1' } });
    expect(rig.shown).toEqual([
      ['showLoot', { lootId: 'loot-1', x: 14, z: 10, contents: DAGGER_DROP }],
      ['showLoot', { lootId: 'loot-2', x: 4, z: 4, contents: DAGGER_DROP }],
      ['removeLoot', 'loot-1'],
    ]);
    expect([...rig.session.loot.keys()]).toEqual(['loot-2']);
    rig.controller.dispatch(enterSpaceFrame());
    expect(rig.session.loot.size).toBe(0);
  });

  it('is walked to on a press and picked up as soon as the player stands within reach, after the move that brought them there', () => {
    const rig = nearLoot();
    rig.session.pressLoot('loot-1');
    expect(rig.pressMarks).toEqual([['show', { x: 14, z: 10 }]]);
    tickUntil(rig, 0, 3000, () => pickUps(rig).length > 0);

    expect(away(rig, { x: 14, z: 10 })).toBeLessThanOrEqual(PICKUP_REACH);
    expect(away(rig, { x: 14, z: 10 })).toBeGreaterThan(PICKUP_REACH - 0.25);
    expect(rig.sent.slice(-2)).toEqual([
      { tag: 'move', payload: expect.objectContaining(at(rig)) },
      { tag: 'pickUp', payload: { lootId: 'loot-1' } },
    ]);
    expect(rig.session.predictor.walk).toBeUndefined();
    tickUntil(rig, 3000, 4000, () => false);
    expect(pickUps(rig)).toHaveLength(1);
  });

  it('is picked up from beside a body standing on it, where the path round the body stops', () => {
    const rig = nearLoot();
    rig.controller.dispatch(entityFrame({ id: 'monster:1', kind: 'monster', name: 'Ghost', x: 14, z: 10 }));
    rig.session.pressLoot('loot-1');
    tickUntil(rig, 0, 3000, () => pickUps(rig).length > 0);

    expect(pickUps(rig)).toEqual([{ tag: 'pickUp', payload: { lootId: 'loot-1' } }]);
    expect(away(rig, { x: 14, z: 10 })).toBeLessThanOrEqual(PICKUP_REACH);
    expect(away(rig, { x: 14, z: 10 })).toBeGreaterThan(0.6);
  });

  it('is left lying when a body on it keeps the player out of reach', () => {
    const rig = nearLoot();
    rig.controller.dispatch(entityFrame({ id: 'monster:1', kind: 'monster', name: 'Ghost', radius: 1.5, x: 14, z: 10 }));
    rig.session.pressLoot('loot-1');
    tickUntil(rig, 0, 4000, () => false);

    expect(rig.session.predictor.walk).toBeUndefined();
    expect(away(rig, { x: 14, z: 10 })).toBeGreaterThan(PICKUP_REACH);
    expect(pickUps(rig)).toEqual([]);
  });

  it('acts on a walk that ends of itself in range, and once only', () => {
    const rig = nearLoot();
    let acted = 0;
    rig.session.predictor.walkTo({ x: 12, z: 10 }, { within: PATH_FOLLOWING.arrivalMetres, act: () => (acted += 1) });
    tickUntil(rig, 0, 3000, () => rig.session.predictor.walk === undefined);
    tickUntil(rig, 3000, 3500, () => false);
    expect(acted).toBe(1);
  });

  it('is not picked up once a new press lands on the way, though the walk goes on until it lets go', () => {
    const rig = nearLoot();
    rig.session.pressLoot('loot-1');
    const time = tickUntil(rig, 0, 3000, () => away(rig, { x: 14, z: 10 }) < PICKUP_REACH + 0.4);
    rig.session.pressGround({ x: 14, z: 14 }, time);
    tickUntil(rig, time + 50, time + 150, () => false);
    expect(away(rig, { x: 14, z: 10 })).toBeLessThanOrEqual(PICKUP_REACH);
    rig.session.release({ x: 14, z: 14 });
    tickUntil(rig, time + 200, time + 3000, () => false);

    expect(pickUps(rig)).toEqual([]);
  });

  it('says a full bag is full on arriving, and asks for nothing', () => {
    const rig = nearLoot();
    const bag = Array.from({ length: SOMNIO_PROTOCOL_CONSTANTS.maxBagItems }, (_, index) => item('cap', `cap-${index}`));
    rig.controller.dispatch(inventoryFrame(carrying({ bag })));
    rig.session.pressLoot('loot-1');
    tickUntil(rig, 0, 3000, () => rig.session.predictor.walk === undefined);

    expect(pickUps(rig)).toEqual([]);
    expect(rig.controller.chatHistory.at(-1)).toEqual({ kind: 'bagFull' });
  });

  it('asks for a trophy whatever the bag holds, since it never enters the bag', () => {
    const rig = nearLoot();
    const bag = Array.from({ length: SOMNIO_PROTOCOL_CONSTANTS.maxBagItems }, (_, index) => item('cap', `cap-${index}`));
    rig.controller.dispatch(inventoryFrame(carrying({ bag })));
    rig.controller.dispatch({ tag: 'loot', payload: { lootId: 'loot-2', x: 12, z: 10, contents: { kind: 'trophy', monsterKind: 'ghost' } } });
    rig.session.pressLoot('loot-2');
    tickUntil(rig, 0, 3000, () => pickUps(rig).length > 0);
    expect(pickUps(rig)).toEqual([{ tag: 'pickUp', payload: { lootId: 'loot-2' } }]);
  });

  it("dropped by a dreamer for anyone is drawn, walked to, and picked up as the player's own is", () => {
    const rig = nearLoot();
    const shared = { lootId: 'loot-3', x: 12, z: 10, contents: DAGGER_DROP, shared: true };
    rig.controller.dispatch({ tag: 'loot', payload: shared });
    expect(rig.shown.at(-1)).toEqual(['showLoot', shared]);
    rig.session.pressLoot('loot-3');
    tickUntil(rig, 0, 3000, () => pickUps(rig).length > 0);
    expect(pickUps(rig)).toEqual([{ tag: 'pickUp', payload: { lootId: 'loot-3' } }]);
  });

  it('announces what was picked up, and not the item it adds', () => {
    const rig = nearLoot();
    rig.controller.dispatch(inventoryFrame(carrying()));
    rig.controller.dispatch(inventoryFrame(carrying({ bag: [item('dagger')] }), { pickedUp: DAGGER_DROP }));
    expect(rig.controller.chatHistory).toEqual([{ kind: 'pickedUp', contents: DAGGER_DROP }]);
  });
});

describe('inbound gameplay dispatch', () => {
  const SAY = { name: 'Someone', kind: 'say', text: 'Hallo', clarity: 1, x: 0, z: 0 } as const;

  /**
   * NPC dialog arrives as `serverSay`, not on a tag of its own, so this discrimination is the only
   * thing that routes it to the NPC chat style rather than the peer one. Inverting it — or
   * collapsing the two kinds to one — would render every NPC line as a peer line for every player,
   * and no other assertion in the suite would notice.
   */
  it.each([
    ['npc', 'spokenByNPC'],
    ['monster', 'spokenByNPC'],
    ['peer', 'spokenByPeer'],
  ] as const)('routes serverSay from a %s to the %s chat style', (kind, expected) => {
    const rig = makeRig();
    rig.controller.entities.set('npc:Meadow/wirt', clientEntity({ id: 'npc:Meadow/wirt', kind, name: 'Wirt' }));

    rig.controller.dispatch({ tag: 'serverSay', payload: { ...SAY, entityId: 'npc:Meadow/wirt', name: 'Wirt', text: 'Willkommen!' } });

    expect(rig.controller.chatHistory.at(-1)).toEqual({
      kind: expected,
      senderName: 'Wirt',
      message: 'Willkommen!',
      speech: 'say',
    });
  });

  it('hangs the bubble of a speaker on screen over them, faded as the line was heard, and names no direction', () => {
    const rig = makeRig();
    attach(rig, [clientEntity(), clientEntity({ id: 'peer', kind: 'peer', name: 'Bren', position: { x: 14, z: 10 } })]);

    rig.controller.dispatch({ tag: 'serverSay', payload: { ...SAY, entityId: 'peer', name: 'Bren', kind: 'whisper', clarity: 0.4 } });

    // The voice comes from the body where it is drawn, not from where the frame says.
    expect(rig.bubbles).toEqual([{ entityId: 'peer', source: { x: 14, z: 10 }, lines: ['Hallo'], lifetimeMs: 3000, kind: 'whisper', clarity: 0.4 }]);
    expect(rig.controller.chatHistory.at(-1)).toEqual({ kind: 'spokenByPeer', senderName: 'Bren', message: 'Hallo', speech: 'whisper' });
  });

  /** A voice through a door, or a speaker this client draws nowhere, still speaks: from where the frame says, for a bubble that follows the speaker once they arrive. */
  it('hears a speaker it draws no body of, and names the direction the voice comes from', () => {
    const rig = makeRig();
    attach(rig, [clientEntity()]);
    rig.pinsBubbles = true;

    rig.controller.dispatch({ tag: 'serverSay', payload: { ...SAY, entityId: 'bren', name: 'Bren', kind: 'yell', x: 13, z: 7 } });
    rig.controller.dispatch({ tag: 'serverSay', payload: { ...SAY, entityId: 'cara', name: 'Cara', x: 4, z: 10 } });

    expect(rig.bubbles.map(({ entityId, source }) => ({ entityId, source }))).toEqual([
      { entityId: 'bren', source: { x: 13, z: 7 } },
      { entityId: 'cara', source: { x: 4, z: 10 } },
    ]);
    expect(rig.controller.chatHistory).toEqual([
      { kind: 'spokenByPeer', senderName: 'Bren', message: 'Hallo', speech: 'yell', direction: 'north-east' },
      { kind: 'spokenByPeer', senderName: 'Cara', message: 'Hallo', speech: 'say', direction: 'west' },
    ]);
  });

  /** A hidden tab runs no tick, so a line heard there would otherwise be placed from where the speaker was when it was hidden. */
  it('places a voice and names its direction from where the speaker stands now, with no frame drawn since they moved', () => {
    const rig = makeRig();
    attach(rig, [clientEntity(), clientEntity({ id: 'peer', kind: 'peer', name: 'Bren', position: { x: 2, z: 10 } })]);
    rig.controller.dispatch({ tag: 'moves', payload: { moves: [{ id: 'peer', x: 20, z: 10, facing: 0, gait: 'jog' }] } });
    rig.now = 1000;
    rig.pinsBubbles = true;

    rig.controller.dispatch({ tag: 'serverSay', payload: { ...SAY, entityId: 'peer', name: 'Bren', kind: 'yell' } });

    expect(rig.positions.filter((write) => write.id === 'peer').at(-1)).toEqual({ id: 'peer', x: 20, z: 10 });
    expect(rig.bubbles.map((bubble) => bubble.source)).toEqual([{ x: 20, z: 10 }]);
    expect(rig.controller.chatHistory.at(-1)).toMatchObject({ direction: 'east' });
  });

  /**
   * `onStateChanged` is the *only* repaint hook `AppShell` wires for session state, so dropping the
   * notification freezes the HUD bars and the Bag window for the rest of the session while the
   * values themselves stay correct. `ui.test.ts` renders both from hand-built values, which is
   * exactly why a broken notification is invisible there.
   */
  it('stores energy and asks for a repaint', () => {
    const rig = makeRig();
    let repaints = 0;
    rig.session.onStateChanged = () => {
      repaints += 1;
    };
    const energy = { healthCurrent: 40, healthMax: 80, balanceCurrent: 5, balanceMax: 10, spiritCurrent: 1, spiritMax: 4 };

    rig.controller.dispatch({ tag: 'energy', payload: energy });

    expect(rig.session.energy).toEqual(energy);
    expect(repaints).toBe(1);
  });

  it('stores the inventory and asks for a repaint', () => {
    const rig = makeRig();
    let repaints = 0;
    rig.session.onStateChanged = () => {
      repaints += 1;
    };
    const inventory = carrying({ coins: 100, worn: [item('cudgel')], bag: [item('cap')] });

    rig.controller.dispatch(inventoryFrame(inventory));

    expect(rig.session.inventory).toEqual(inventory);
    expect(repaints).toBe(1);
  });

  it('renders an admin broadcast into the scrollback', () => {
    const rig = makeRig();

    rig.controller.dispatch({ tag: 'adminSay', payload: { text: 'Server restarting.' } });

    expect(rig.controller.chatHistory.at(-1)).toEqual({
      kind: 'adminBroadcast',
      message: 'Server restarting.',
    });
  });
});

describe('winded and fallen', () => {
  const energy = (balanceCurrent: number, healthCurrent = 100) => ({
    tag: 'energy' as const,
    payload: { ...FULL, healthCurrent, balanceCurrent },
  });

  it.each([
    [14, true],
    [15, false],
  ])('starts winded from the first energy frame after enterSpace alone: %i balance', (balance, winded) => {
    const rig = makeRig();
    rig.controller.dispatch(enterSpaceFrame());
    rig.controller.dispatch(energy(balance));
    expect(rig.session.winded).toBe(winded);
  });

  it('then follows each frame in order: winded at zero, and until the balance is back to the threshold', () => {
    const rig = makeRig();
    rig.controller.dispatch(enterSpaceFrame());
    const after = (balance: number): boolean => {
      rig.controller.dispatch(energy(balance));
      return rig.session.winded;
    };
    expect([50, 0, 14, 15, 5].map(after)).toEqual([false, true, true, false, false]);

    // A new space starts over from the balance alone.
    rig.controller.dispatch(enterSpaceFrame('Hall'));
    expect(after(5)).toBe(true);
  });

  it("is fallen by its own entity's condition, never by an energy frame with no health", () => {
    const rig = makeRig();
    rig.controller.dispatch(enterSpaceFrame());
    rig.controller.dispatch(entityFrame());
    rig.controller.dispatch(energy(100, 0));
    expect(rig.session.fallen).toBe(false);

    let repaints = 0;
    rig.session.onStateChanged = () => {
      repaints += 1;
    };
    rig.controller.dispatch({ tag: 'condition', payload: { entityId: 'self', condition: 'fallen' } });
    expect(rig.session.fallen).toBe(true);
    // Repainted at once: a fallen dreamer's pools do not recover, so no other frame would come.
    expect(repaints).toBe(1);
    expect(rig.controller.chatHistory.at(-1)).toEqual({ kind: 'fell' });

    rig.controller.dispatch({ tag: 'condition', payload: { entityId: 'self', condition: 'failing' } });
    expect(rig.session.fallen).toBe(false);
  });

  it('is fallen from the join when its own entity arrives fallen, and says nothing of it', () => {
    const rig = makeRig();
    let repaints = 0;
    rig.session.onStateChanged = () => {
      repaints += 1;
    };
    rig.controller.dispatch(enterSpaceFrame());
    rig.controller.dispatch(entityFrame({ condition: 'fallen' }));
    expect(rig.session.fallen).toBe(true);
    expect(repaints).toBe(1);
    expect(rig.controller.chatHistory).toEqual([]);
  });

  it('asks to wake only while fallen, and reports the waking when the new space arrives', () => {
    const rig = makeRig();
    rig.controller.dispatch(enterSpaceFrame());
    rig.controller.dispatch(entityFrame());
    rig.session.wake();
    expect(rig.sent).toEqual([]);

    rig.controller.dispatch({ tag: 'condition', payload: { entityId: 'self', condition: 'fallen' } });
    rig.session.wake();
    expect(rig.sent).toEqual([{ tag: 'wake', payload: {} }]);
    rig.controller.dispatch(enterSpaceFrame('EdariaInn'));
    expect(rig.controller.chatHistory.at(-1)).toEqual({ kind: 'wokeWeakened' });

    // An ordinary door afterwards is no waking.
    rig.controller.dispatch(enterSpaceFrame('outdoors'));
    expect(rig.controller.chatHistory.filter((line) => line.kind === 'wokeWeakened')).toHaveLength(1);
  });

  it('keeps the raise given to the player, and reports it breaking and being drawn back', () => {
    const rig = makeRig();
    rig.controller.dispatch(enterSpaceFrame());
    rig.controller.dispatch(entityFrame({ condition: 'fallen' }));
    rig.controller.dispatch(entityFrame({ id: 'healer', name: 'Lumi' }));
    rig.now = 1000;
    rig.controller.dispatch(raisingFrame('self', ['healer'], 'holding'));
    expect(rig.session.raiseOf('self')).toEqual({ progress: 0, seconds: 6, healerNames: ['Lumi'], atMs: 1000, endsAtMs: 7000 });

    rig.controller.dispatch(raisingFrame('self', ['healer'], 'broken'));
    expect(rig.session.raiseOf('self')).toBeUndefined();
    expect(rig.controller.chatHistory).toEqual([{ kind: 'raiseBroken', healerNames: ['Lumi'] }]);

    rig.controller.dispatch(raisingFrame('self', ['healer'], 'holding'));
    rig.controller.dispatch(raisingFrame('self', ['healer'], 'done', 1));
    expect(rig.session.raiseOf('self')).toBeUndefined();
    expect(rig.controller.chatHistory.at(-1)).toEqual({ kind: 'raised', healerNames: ['Lumi'] });
  });

  it('names every Healer holding on to the raise given to the player that it knows, at their pace', () => {
    const rig = makeRig();
    rig.controller.dispatch(enterSpaceFrame());
    rig.controller.dispatch(entityFrame({ condition: 'fallen' }));
    rig.controller.dispatch(entityFrame({ id: 'healer', name: 'Lumi' }));
    rig.controller.dispatch(entityFrame({ id: 'other', name: 'Bren' }));
    rig.controller.dispatch(raisingFrame('self', ['healer'], 'holding'));
    rig.controller.dispatch(raisingFrame('self', ['healer', 'unseen', 'other'], 'holding', 0, 3));
    expect(rig.session.raiseOf('self')).toMatchObject({ healerNames: ['Lumi', 'Bren'], endsAtMs: 3000 });

    rig.controller.dispatch(raisingFrame('self', ['healer', 'unseen', 'other'], 'done', 1));
    expect(rig.controller.chatHistory).toEqual([{ kind: 'raised', healerNames: ['Lumi', 'Bren'] }]);
  });

  /** The Healer's `leave` comes just before the break it causes. */
  it('names the Healer whose raise broke, though they have already left', () => {
    const rig = makeRig();
    rig.controller.dispatch(enterSpaceFrame());
    rig.controller.dispatch(entityFrame({ condition: 'fallen' }));
    rig.controller.dispatch(entityFrame({ id: 'healer', name: 'Lumi' }));
    rig.controller.dispatch(raisingFrame('self', ['healer'], 'holding'));
    rig.controller.dispatch({ tag: 'leave', payload: { entityId: 'healer', leftGame: true } });
    rig.controller.dispatch(raisingFrame('self', ['healer'], 'broken'));
    expect(rig.controller.chatHistory.at(-1)).toEqual({ kind: 'raiseBroken', healerNames: ['Lumi'] });
  });

  it('names only the Healers it knows when a raise it never saw under way ends', () => {
    const rig = makeRig();
    rig.controller.dispatch(enterSpaceFrame());
    rig.controller.dispatch(entityFrame({ condition: 'fallen' }));
    rig.controller.dispatch(entityFrame({ id: 'healer', name: 'Lumi' }));
    rig.controller.dispatch(raisingFrame('self', ['unseen', 'healer'], 'done', 1));
    expect(rig.controller.chatHistory.at(-1)).toEqual({ kind: 'raised', healerNames: ['Lumi'] });
  });

  it('keeps each raise in view as its last snapshot states it, for the frames, until it ends or its dreamer leaves', () => {
    const rig = makeRig();
    rig.controller.dispatch(enterSpaceFrame());
    rig.controller.dispatch(entityFrame());
    rig.controller.dispatch(entityFrame({ id: 'peer', kind: 'player', name: 'Mira', condition: 'fallen' }));
    rig.controller.dispatch(entityFrame({ id: 'healer', kind: 'player', name: 'Lumi' }));
    rig.controller.dispatch(entityFrame({ id: 'other', kind: 'player', name: 'Bren' }));
    let repaints = 0;
    rig.session.onStateChanged = () => (repaints += 1);

    rig.now = 1000;
    rig.controller.dispatch(raisingFrame('peer', ['healer'], 'holding', 0.25, 4.5));
    expect(rig.session.raiseOf('peer')).toEqual({ progress: 0.25, seconds: 4.5, healerNames: ['Lumi'], atMs: 1000, endsAtMs: 5500 });
    expect(repaints).toBe(1);
    // A second Healer joins while a channel of theirs runs, which holds their pace back.
    rig.now = 2500;
    rig.controller.dispatch({
      tag: 'raising',
      payload: { targetId: 'peer', healerIds: ['healer', 'other', 'unseen'], state: 'holding', progress: 0.5, seconds: 2, pausedSeconds: [0, 1, 0] },
    });
    expect(rig.session.raiseOf('peer')).toEqual({
      progress: 0.5,
      seconds: 2,
      pausedSeconds: [0, 1, 0],
      healerNames: ['Lumi', 'Bren'],
      atMs: 2500,
      endsAtMs: 4500,
    });
    rig.controller.dispatch(raisingFrame('peer', ['healer'], 'broken'));
    expect(rig.session.raiseOf('peer')).toBeUndefined();
    rig.controller.dispatch(raisingFrame('peer', ['healer'], 'holding'));
    rig.controller.dispatch(raisingFrame('peer', ['healer'], 'done', 1));
    expect(rig.session.raiseOf('peer')).toBeUndefined();

    rig.controller.dispatch(raisingFrame('peer', ['healer'], 'holding'));
    rig.controller.dispatch({ tag: 'leave', payload: { entityId: 'peer', leftGame: false } });
    expect(rig.session.raiseOf('peer')).toBeUndefined();
    rig.controller.dispatch(raisingFrame('self', ['healer'], 'holding'));
    rig.controller.dispatch(enterSpaceFrame());
    expect(rig.session.raiseOf('self')).toBeUndefined();
  });

  it('shows the scene every blow, every raise as it stands and as it ends, every mend, and every change of condition', () => {
    const rig = makeRig();
    rig.controller.dispatch(enterSpaceFrame());
    rig.controller.dispatch(entityFrame());
    rig.controller.dispatch(entityFrame({ id: 'peer', kind: 'player' }));
    rig.shown.length = 0;

    rig.controller.dispatch({ tag: 'blow', payload: { attackerId: 'monster:1', targetId: 'peer', hit: true } });
    rig.controller.dispatch({ tag: 'blow', payload: { attackerId: 'peer', targetId: 'monster:1', hit: false } });
    rig.controller.dispatch({ tag: 'condition', payload: { entityId: 'peer', condition: 'fallen' } });
    rig.controller.dispatch(raisingFrame('peer', ['self'], 'holding', 0.25, 4.5));
    rig.controller.dispatch({
      tag: 'raising',
      payload: { targetId: 'peer', healerIds: ['self'], state: 'holding', progress: 0.25, seconds: 6, pausedSeconds: [1.5] },
    });
    rig.controller.dispatch(raisingFrame('peer', ['self'], 'broken'));
    rig.controller.dispatch({ tag: 'mend', payload: { targetId: 'peer' } });

    expect(rig.shown).toEqual([
      ['showBlow', 'monster:1', 'peer', true],
      ['showBlow', 'peer', 'monster:1', false],
      ['updateCondition', 'peer', 'fallen'],
      ['showRaising', 'peer', { progress: 0.25, seconds: 4.5 }],
      ['showRaising', 'peer', { progress: 0.25, seconds: 6, pausedSeconds: [1.5] }],
      ['showRaising', 'peer', undefined],
      ['showMend', 'peer'],
    ]);
  });

  it('shows the scene where each fallen dreamer lies, as the server last said, until a new space', () => {
    const rig = makeRig();
    rig.controller.dispatch(enterSpaceFrame());
    rig.controller.dispatch(entityFrame());
    const bearings = [{ name: 'Ida', x: 31.5, z: -12.25 }];
    rig.controller.dispatch({ tag: 'sensed', payload: { bearings } });
    expect(rig.session.sensed).toEqual(bearings);
    expect(rig.shown.filter(([name]) => name === 'showSensed')).toEqual([['showSensed', bearings]]);
    rig.controller.dispatch(enterSpaceFrame('Hall'));
    expect(rig.session.sensed).toEqual([]);
  });

  it('reports no waking after a wake that a raise came ahead of', () => {
    const rig = makeRig();
    rig.controller.dispatch(enterSpaceFrame());
    rig.controller.dispatch(entityFrame({ condition: 'fallen' }));
    rig.session.wake();
    rig.controller.dispatch({ tag: 'condition', payload: { entityId: 'self', condition: 'failing' } });

    rig.controller.dispatch(enterSpaceFrame('Hall'));
    expect(rig.controller.chatHistory).toEqual([]);
  });
});

describe('chat lines from what changed', () => {
  const purse = (coins: number) => inventoryFrame(carrying({ coins }));
  const strike = (rank: number, practice = 0) => ({ teachingId: 'strike', rank, practice });

  it('says nothing for the first frames after enterSpace, whatever they hold', () => {
    const rig = makeRig();
    rig.controller.dispatch(enterSpaceFrame());
    rig.controller.dispatch(purse(100));
    rig.controller.dispatch({
      tag: 'lucidity',
      payload: {
        role: 'fighter',
        ranks: [strike(3)],
        study: 'strike',
      },
    });

    expect(rig.controller.chatHistory).toEqual([]);
    expect(rig.session.lucidity.role).toBe('fighter');

    // Nor after a door: the new space's first frames restate what the player already knew.
    rig.controller.dispatch(enterSpaceFrame('Hall'));
    rig.controller.dispatch(purse(100));
    rig.controller.dispatch({ tag: 'lucidity', payload: { role: 'fighter', ranks: [strike(3)] } });
    expect(rig.controller.chatHistory).toEqual([]);
  });

  it('reports a larger purse by what was gained, and nothing for a smaller one', () => {
    const rig = makeRig();
    rig.controller.dispatch(enterSpaceFrame());
    rig.controller.dispatch(purse(100));
    rig.controller.dispatch(purse(106));
    rig.controller.dispatch(purse(90));
    expect(rig.controller.chatHistory).toEqual([{ kind: 'coinsGained', coins: 6 }]);
  });

  it("reports a turn-in's coins, then each item it gave", () => {
    const rig = makeRig();
    rig.controller.dispatch(enterSpaceFrame());
    rig.controller.dispatch(purse(100));
    const tunic = { kind: 'item', baseId: 'tunic', rarity: 'rare' } as const;
    rig.controller.dispatch(inventoryFrame(carrying({ coins: 160, bag: [item('tunic')] }), { rewarded: [tunic] }));
    expect(rig.controller.chatHistory).toEqual([
      { kind: 'coinsGained', coins: 60 },
      { kind: 'rewarded', contents: tunic },
    ]);
  });

  it('reports a new role and a new rank', () => {
    const rig = makeRig();
    rig.controller.dispatch(enterSpaceFrame());
    rig.controller.dispatch({ tag: 'lucidity', payload: { ranks: [] } });

    rig.controller.dispatch({ tag: 'lucidity', payload: { role: 'fighter', ranks: [strike(1)], study: 'strike' } });
    expect(rig.controller.chatHistory).toEqual([
      { kind: 'becameRole', role: 'fighter' },
      { kind: 'rankGained', teachingId: 'strike', rank: 1 },
    ]);

    // Practice alone is no news; the rank it earns is.
    rig.controller.dispatch({ tag: 'lucidity', payload: { role: 'fighter', ranks: [strike(1, 10)], study: 'strike' } });
    rig.controller.dispatch({ tag: 'lucidity', payload: { role: 'fighter', ranks: [strike(2, 5)], study: 'strike' } });
    expect(rig.controller.chatHistory.slice(2)).toEqual([{ kind: 'rankGained', teachingId: 'strike', rank: 2 }]);
  });

  /** A `quests` frame holding the quest, with that much done toward each of its objectives. */
  const holding = (questId: string, progress: number[]): SomnioMessage => ({
    tag: 'quests',
    payload: { active: [{ questId, progress }], done: [], bounties: [] },
  });

  it("says each hidden place found, never which, and a quest done with where to turn it in, but not the place that finishes it, nor a join's first frame", () => {
    const rig = makeRig();
    rig.controller.dispatch(enterSpaceFrame());
    rig.controller.dispatch(holding('mystic-trial', [0, 1, 0]));
    expect(rig.controller.chatHistory).toEqual([]);

    rig.controller.dispatch(holding('mystic-trial', [1, 1, 0]));
    expect(rig.controller.chatHistory).toEqual([{ kind: 'placeFound', found: 2, total: 3 }]);
    rig.controller.dispatch(holding('mystic-trial', [1, 1, 1]));
    // Tacita stands in no sector this client holds, so the committed world names her.
    expect(rig.controller.chatHistory.slice(1)).toEqual([{ kind: 'questDone', questId: 'mystic-trial', turnIn: 'Tacita' }]);

    // A quest taken on already done says nothing, nor does one given up.
    rig.controller.dispatch({ tag: 'quests', payload: { active: [{ questId: 'fighter-trial', progress: [1] }], done: [], bounties: [] } });
    rig.controller.dispatch({ tag: 'quests', payload: { active: [], done: [], bounties: [] } });
    expect(rig.controller.chatHistory).toHaveLength(2);

    rig.controller.dispatch(enterSpaceFrame('Hall'));
    rig.controller.dispatch(holding('mystic-trial', [1, 1, 1]));
    expect(rig.controller.chatHistory).toHaveLength(2);
  });

  it("tells the HUD of each line that came further and each quest done, but not of a join's first frame, nor of a count set back", () => {
    const rig = makeRig();
    const news: unknown[] = [];
    rig.session.onQuestNews = (told) =>
      news.push(told.kind === 'progress' ? [told.held.questId, told.line.done, told.line.goal] : [told.held.questId, told.kind]);
    rig.controller.dispatch(enterSpaceFrame());
    rig.controller.dispatch(holding('restless-graves', [1]));
    expect(news).toEqual([]);

    rig.controller.dispatch(holding('restless-graves', [2]));
    rig.controller.dispatch(holding('restless-graves', [2]));
    rig.controller.dispatch(holding('mystic-trial', [0, 1, 0]));
    rig.controller.dispatch(holding('mystic-trial', [1, 1, 0]));
    rig.controller.dispatch(holding('mystic-trial', [1, 1, 1]));
    rig.controller.dispatch(holding('follow-through-task', [2]));
    rig.controller.dispatch(holding('follow-through-task', [0]));
    expect(news).toEqual([
      ['restless-graves', 2, 4],
      ['mystic-trial', 'accepted'],
      ['mystic-trial', 2, 3],
      ['mystic-trial', 'done'],
      ['follow-through-task', 'accepted'],
    ]);
  });

  it("tells the HUD of each quest taken on, and of no line of it however far it has come, but not of the quests a join's first frame holds", () => {
    const rig = makeRig();
    const news: QuestNews[] = [];
    rig.session.onQuestNews = (told) => news.push(told);
    rig.controller.dispatch(enterSpaceFrame());
    rig.controller.dispatch(holding('restless-graves', [1]));
    expect(news).toEqual([]);

    // Two taken on in one frame, each its own news in the log's order, the one already part done with no line of it.
    rig.controller.dispatch({
      tag: 'quests',
      payload: {
        active: [
          { questId: 'restless-graves', progress: [1] },
          { questId: 'newcomer-errand', progress: [1, 0] },
          { questId: 'mystic-trial', progress: [0, 1, 0] },
        ],
        done: [],
        bounties: [],
      },
    });
    expect(news).toEqual([
      { kind: 'accepted', held: { questId: 'newcomer-errand', progress: [1, 0] } },
      { kind: 'accepted', held: { questId: 'mystic-trial', progress: [0, 1, 0] } },
    ]);
    // Taking a quest on says nothing in the chat, not even a hidden place already found.
    expect(rig.controller.chatHistory).toEqual([]);

    rig.controller.dispatch(enterSpaceFrame('Hall'));
    rig.controller.dispatch(holding('follow-through-task', [0]));
    expect(news).toHaveLength(2);
  });

  it("tells the HUD of a quest turned in once the frames answering it have arrived, with what it paid and the teaching studied, but not at a join's first frames", () => {
    const rig = makeRig();
    const news: QuestNews[] = [];
    // Each quest held here is taken on after the baseline, which is news of its own.
    rig.session.onQuestNews = (told) => {
      if (told.kind === 'turnedIn') news.push(told);
    };
    const turnedIn = (questId: string): SomnioMessage => ({ tag: 'quests', payload: { active: [], done: [questId], bounties: [] } });
    const studying = (practice: number): SomnioMessage => ({ tag: 'lucidity', payload: { role: 'fighter', ranks: [strike(1, practice)], study: 'strike' } });
    rig.controller.dispatch(enterSpaceFrame());
    rig.controller.dispatch(purse(100));
    rig.controller.dispatch(studying(0));
    rig.controller.dispatch(holding('into-the-crypt', [1]));

    // The `quests` frame, then the practice's `lucidity` frame, then the `inventory` frame carrying the coins and the item: one turn-in.
    rig.controller.dispatch(turnedIn('into-the-crypt'));
    rig.controller.dispatch(studying(60));
    expect(news).toEqual([]);
    const sabre = { kind: 'item', baseId: 'sabre', rarity: 'rare' } as const;
    rig.controller.dispatch(inventoryFrame(carrying({ coins: 350, bag: [item('sabre')] }), { rewarded: [sabre] }));
    expect(news).toEqual([{ kind: 'turnedIn', held: { questId: 'into-the-crypt', progress: [1] }, study: 'strike', coins: 250, items: [sabre] }]);
    // The chat says the coins and the item as before.
    expect(rig.controller.chatHistory).toEqual([
      { kind: 'coinsGained', coins: 250 },
      { kind: 'rewarded', contents: sabre },
    ]);

    // A gate that pays nothing but its teaching sends no `inventory` frame, so its `quests` frame is the turn-in.
    rig.controller.dispatch(holding('follow-through-task', [3]));
    rig.controller.dispatch(turnedIn('follow-through-task'));
    expect(news.slice(1)).toEqual([
      { kind: 'turnedIn', held: { questId: 'follow-through-task', progress: [3] }, study: 'strike', coins: undefined, items: [] },
    ]);

    // A turn-in still waiting as the player changes space is never told, nor is the new space's first `quests` frame.
    rig.controller.dispatch(holding('restless-graves', [4]));
    rig.controller.dispatch(turnedIn('restless-graves'));
    rig.controller.dispatch(enterSpaceFrame('Hall'));
    rig.controller.dispatch(purse(410));
    rig.controller.dispatch(holding('cracked-skulls', [3]));
    rig.controller.dispatch(enterSpaceFrame());
    rig.controller.dispatch(turnedIn('cracked-skulls'));
    rig.controller.dispatch(purse(500));
    expect(news).toHaveLength(2);
  });

  it('marks every carrier of a quest in view by what it has for the player, and none once the session ends', () => {
    const rig = makeRig();
    const marked = () => rig.questMarkers.at(-1);
    rig.controller.dispatch(enterSpaceFrame());
    rig.controller.dispatch({ tag: 'lucidity', payload: { ranks: [] } });
    rig.controller.dispatch({ tag: 'quests', payload: { active: [], done: [], bounties: [] } });
    expect(marked()).toEqual(new Map());
    const npcs = [
      ['npc:EdariaFighterHall/pugnax', 'fighterMaster'],
      ['npc:EdariaHealerHall/sana', 'healerMaster'],
      ['npc:EdariaLibrary/libus', undefined],
      ['npc:EdariaMysticTower/tacita', 'mysticMaster'],
      ['npc:Graveyard/memor', undefined],
      ['npc:EdariaShop/mercus', 'shopkeeper'],
    ] as const;
    for (const [id, service] of npcs) rig.controller.dispatch(entityFrame({ id, kind: 'npc', ...(service === undefined ? {} : { service }) }));
    expect(marked()).toEqual(
      new Map([
        ['npc:EdariaFighterHall/pugnax', 'offer'],
        ['npc:EdariaHealerHall/sana', 'offer'],
        ['npc:EdariaLibrary/libus', 'offer'],
        ['npc:EdariaMysticTower/tacita', 'offer'],
        ['npc:Graveyard/memor', 'offer'],
      ]),
    );
    rig.controller.dispatch(holding('fighter-trial', [0]));
    expect(marked()).toEqual(
      new Map([
        ['npc:EdariaFighterHall/pugnax', 'inProgress'],
        ['npc:EdariaLibrary/libus', 'offer'],
        ['npc:Graveyard/memor', 'offer'],
      ]),
    );
    rig.controller.dispatch(holding('fighter-trial', [1]));
    expect(marked()).toEqual(
      new Map([
        ['npc:EdariaFighterHall/pugnax', 'turnIn'],
        ['npc:EdariaLibrary/libus', 'offer'],
        ['npc:Graveyard/memor', 'offer'],
      ]),
    );
    rig.controller.onTeardown?.();
    expect(marked()).toEqual(new Map());
  });

  it("marks an NPC carrying the bounty board with an offer of the day's bounties as it comes into view, and none once it leaves", () => {
    const bounty = { day: 3, land: 'Meadow', monsterKind: 'ghost', objective: 'driveOff', count: 2, reward: { coins: 24, gear: 1 } } as const;
    const crier = 'npc:Meadow/crier';
    const rig = makeRig();
    const marked = () => rig.questMarkers.at(-1)?.get(crier);
    rig.controller.dispatch(enterSpaceFrame());
    rig.controller.dispatch({ tag: 'lucidity', payload: { ranks: [] } });
    rig.controller.dispatch({ tag: 'quests', payload: { active: [], done: [], bounties: [bounty] } });
    expect(marked()).toBeUndefined();
    rig.controller.dispatch(entityFrame({ id: crier, kind: 'npc', name: 'Crier', service: 'bountyBoard' }));
    expect(marked()).toBe('offer');
    rig.controller.dispatch({ tag: 'leave', payload: { entityId: crier, leftGame: false } });
    expect(marked()).toBeUndefined();
  });
});

describe('the service panel', () => {
  const MASTER = 'npc:Meadow/pugnax';
  const LIBUS = 'npc:EdariaLibrary/libus';

  /** Joins a meadow with a master a step south of the player, and clicks him. */
  function atMaster(): { rig: Rig; tick: (count?: number) => void } {
    const rig = makeRig();
    let time = 0;
    const tick = (count = 1): void => {
      for (let index = 0; index < count; index += 1) {
        rig.session.runTick(time);
        time += 100;
      }
    };
    rig.controller.dispatch(enterSpaceFrame());
    rig.controller.dispatch(sectorFrame(outdoorSector('Meadow', { x: 0, z: 0 })));
    rig.controller.dispatch(entityFrame({ facing: 30 }));
    rig.controller.dispatch(entityFrame({ id: MASTER, kind: 'npc', name: 'Pugnax', x: 10.3, z: 10.6, service: 'fighterMaster' }));
    rig.session.pressEntity(MASTER);
    tick(3);
    return { rig, tick };
  }

  it('opens on a click at an NPC with a service, speaking to them, without closing the input gate or stopping the player', () => {
    const { rig, tick } = atMaster();
    expect(rig.sent).toContainEqual({ tag: 'interact', payload: { carrierId: MASTER } });
    expect(rig.session.servicePanel?.id).toBe(MASTER);
    expect(rig.controller.presentedOverlay).toBeUndefined();

    tapGround(rig, UP_SCREEN);
    const before = rig.controller.entities.get('self')!.position;
    tick(2);
    expect(rig.controller.entities.get('self')!.position).not.toEqual(before);
    expect(rig.session.servicePanel?.id).toBe(MASTER);
  });

  it('speaks to an NPC with nothing to offer, and opens nothing', () => {
    const rig = makeRig();
    rig.controller.dispatch(enterSpaceFrame());
    rig.controller.dispatch(entityFrame());
    rig.controller.dispatch(entityFrame({ id: 'npc:Meadow/libus', kind: 'npc', x: 10.3, z: 10.6 }));
    rig.session.pressEntity('npc:Meadow/libus');
    expect(rig.sent.filter((message) => message.tag !== 'move')).toEqual([
      { tag: 'target', payload: { targetId: 'npc:Meadow/libus' } },
      { tag: 'interact', payload: { carrierId: 'npc:Meadow/libus' } },
    ]);
    expect(rig.session.servicePanel).toBeUndefined();
  });

  it('only selects an NPC beyond speaking distance: no word and no panel', () => {
    const rig = makeRig();
    rig.controller.dispatch(enterSpaceFrame());
    rig.controller.dispatch(entityFrame());
    rig.controller.dispatch(entityFrame({ id: MASTER, kind: 'npc', x: 10, z: 12.1, service: 'fighterMaster' }));
    rig.controller.dispatch({ tag: 'energy', payload: FULL });
    rig.session.pressEntity(MASTER);
    rig.session.runTick(0);
    expect(rig.sent.filter((message) => message.tag !== 'move')).toEqual([{ tag: 'target', payload: { targetId: MASTER } }]);
    expect(rig.session.target).toBe(MASTER);
    expect(rig.session.servicePanel).toBeUndefined();
  });

  it('sends each request to the NPC it is open for', () => {
    const { rig } = atMaster();
    rig.sent.length = 0;
    rig.session.acceptQuest('fighter-trial');
    rig.session.turnInQuest('follow-through-task');
    rig.session.study('guard');
    rig.session.abandonQuest('fighter-trial');
    expect(rig.sent).toEqual([
      { tag: 'acceptQuest', payload: { carrierId: MASTER, questId: 'fighter-trial' } },
      { tag: 'turnInQuest', payload: { carrierId: MASTER, questId: 'follow-through-task' } },
      { tag: 'study', payload: { carrierId: MASTER, teachingId: 'guard' } },
      { tag: 'abandonQuest', payload: { questId: 'fighter-trial' } },
    ]);
  });

  it('closes when the player walks out of speaking distance', () => {
    const { rig, tick } = atMaster();
    tapGround(rig, UP_SCREEN);
    tick(4);
    expect(rig.session.servicePanel?.id).toBe(MASTER);
    tick(8);
    expect(rig.session.servicePanel).toBeUndefined();
  });

  it('closes on a new space and on falling', () => {
    const door = atMaster();
    door.rig.controller.dispatch(enterSpaceFrame('Hall'));
    expect(door.rig.session.servicePanel).toBeUndefined();

    const fall = atMaster();
    fall.rig.controller.dispatch({ tag: 'condition', payload: { entityId: 'self', condition: 'fallen' } });
    expect(fall.rig.session.servicePanel).toBeUndefined();
  });

  it('sends nothing to a master once it is closed', () => {
    const { rig } = atMaster();
    rig.session.closeServicePanel();
    rig.sent.length = 0;
    rig.session.acceptQuest('fighter-trial');
    rig.session.turnInQuest('fighter-trial');
    rig.session.study('guard');
    expect(rig.sent).toEqual([]);
  });

  it('trades with no master', () => {
    const { rig } = atMaster();
    rig.sent.length = 0;
    rig.session.buy('dagger');
    rig.session.sell('cudgel');
    expect(rig.sent).toEqual([]);
    expect(rig.session.tradeLocked()).toBe(false);
  });
  it.each([
    ['Libus', 'npc:EdariaLibrary/libus'],
    ['Memor', 'npc:Graveyard/memor'],
  ])('opens at %s, who carries no service of his own but gives and takes quests', (name, carrierId) => {
    const rig = makeRig();
    rig.controller.dispatch(enterSpaceFrame());
    rig.controller.dispatch(entityFrame());
    rig.controller.dispatch(entityFrame({ id: carrierId, kind: 'npc', name, x: 10.3, z: 10.6 }));
    rig.session.pressEntity(carrierId);
    expect(rig.sent).toContainEqual({ tag: 'interact', payload: { carrierId } });
    expect(rig.session.servicePanel).toEqual({ id: carrierId, name, position: { x: 10.3, z: 10.6 }, service: undefined });
    rig.session.acceptQuest('newcomer-errand');
    expect(rig.sent.at(-1)).toEqual({ tag: 'acceptQuest', payload: { carrierId, questId: 'newcomer-errand' } });
  });

  it("closes a carrier's panel as its last quest for the player is turned in, when it has no service of its own", () => {
    const rig = makeRig();
    rig.controller.dispatch(enterSpaceFrame());
    rig.controller.dispatch(entityFrame());
    rig.controller.dispatch({ tag: 'quests', payload: { active: [{ questId: 'newcomer-errand', progress: [1, 1] }], done: [], bounties: [] } });
    rig.controller.dispatch(entityFrame({ id: LIBUS, kind: 'npc', name: 'Libus', x: 10.3, z: 10.6 }));
    rig.session.pressEntity(LIBUS);
    expect(rig.session.servicePanel?.id).toBe(LIBUS);

    rig.controller.dispatch({ tag: 'quests', payload: { active: [], done: ['newcomer-errand'], bounties: [] } });
    expect(rig.session.servicePanel).toBeUndefined();
  });

  it('speaks to a carrier of quests with nothing left for the player, and opens nothing', () => {
    const rig = makeRig();
    rig.controller.dispatch(enterSpaceFrame());
    rig.controller.dispatch(entityFrame());
    rig.controller.dispatch({ tag: 'quests', payload: { active: [], done: ['newcomer-errand'], bounties: [] } });
    rig.controller.dispatch(entityFrame({ id: LIBUS, kind: 'npc', name: 'Libus', x: 10.3, z: 10.6 }));
    rig.session.pressEntity(LIBUS);
    expect(rig.sent).toContainEqual({ tag: 'interact', payload: { carrierId: LIBUS } });
    expect(rig.session.servicePanel).toBeUndefined();
  });
});

describe('the bounty board', () => {
  const BOARD = 'fixture:Meadow/fixture-1';
  const BOARD_AT = { x: 16, z: 10 };
  const interacts = (rig: Rig) => rig.sent.filter((message) => message.tag === 'interact');
  const at = (rig: Rig) => rig.controller.entities.get('self')!.position;
  const away = (rig: Rig) => Math.hypot(at(rig).x - BOARD_AT.x, at(rig).z - BOARD_AT.z);

  /** Joins a meadow standing at (10, 10), with the board on a placement at (16, 10) that blocks the ground round its centre. */
  function nearBoard(): Rig {
    const rig = makeRig();
    rig.controller.dispatch(enterSpaceFrame());
    rig.controller.dispatch(
      sectorFrame(
        outdoorSector(
          'Meadow',
          { x: 0, z: 0 },
          {
            placements: [{ id: 'notice-board-1', modelId: 'box', ...BOARD_AT, yaw: 0, elevation: 0 }],
            fixtures: [{ id: 'fixture-1', placement: 'notice-board-1', service: 'bountyBoard' }],
          },
        ),
      ),
    );
    rig.controller.dispatch(entityFrame());
    rig.controller.dispatch({ tag: 'energy', payload: FULL });
    return rig;
  }

  it('is walked to on a press from afar, though its centre lies inside what it blocks, and used once in speaking distance, after the move that brought the player there', () => {
    const rig = nearBoard();
    rig.session.pressFixture(BOARD);
    expect(rig.session.servicePanel).toBeUndefined();
    expect(rig.pressMarks).toEqual([['show', BOARD_AT]]);
    tickUntil(rig, 0, 4000, () => interacts(rig).length > 0);
    rig.session.runTick(4050);
    expect(rig.pressMarks).toEqual([['show', BOARD_AT], ['lift']]);

    expect(away(rig)).toBeLessThanOrEqual(SOMNIO_CONSTANTS.speakingDistance);
    expect(rig.sent.slice(-2)).toEqual([
      { tag: 'move', payload: expect.objectContaining(at(rig)) },
      { tag: 'interact', payload: { carrierId: BOARD } },
    ]);
    expect(rig.session.servicePanel).toEqual({ id: BOARD, name: undefined, position: BOARD_AT, service: 'bountyBoard' });
    expect(rig.session.target).toBeUndefined();
    tickUntil(rig, 4000, 5000, () => false);
    expect(interacts(rig)).toHaveLength(1);
  });

  it('is used at once on a press from within speaking distance, and closes once the player walks away', () => {
    const rig = nearBoard();
    rig.session.pressFixture(BOARD);
    tickUntil(rig, 0, 4000, () => interacts(rig).length > 0);
    rig.sent.length = 0;
    rig.session.closeServicePanel();
    rig.session.pressFixture(BOARD);
    expect(interacts(rig)).toEqual([{ tag: 'interact', payload: { carrierId: BOARD } }]);
    expect(rig.session.servicePanel?.id).toBe(BOARD);
    expect(rig.session.predictor.walk).toBeUndefined();

    tapGround(rig, { x: 4, z: 10 }, 5000);
    tickUntil(rig, 5100, 9000, () => rig.session.servicePanel === undefined);
    expect(rig.session.servicePanel).toBeUndefined();
  });

  it("is marked with an offer from the day's bounties before it is first opened, as its sector arrives too, and as in progress once they are all taken", () => {
    const bounty = { day: 3, land: 'Meadow', monsterKind: 'ghost', objective: 'driveOff', count: 2, reward: { coins: 24, gear: 1 } } as const;
    const questId = bountyIdOf(bounty);
    const quests = (active: { questId: string; progress: number[]; definition: typeof bounty }[]): SomnioMessage => ({
      tag: 'quests',
      payload: { active, done: [], bounties: [bounty] },
    });
    const rig = makeRig();
    const marked = () => rig.questMarkers.at(-1)?.get(BOARD);
    rig.controller.dispatch(enterSpaceFrame());
    rig.controller.dispatch({ tag: 'lucidity', payload: { ranks: [] } });
    rig.controller.dispatch(quests([]));
    expect(marked()).toBeUndefined();
    rig.controller.dispatch(
      sectorFrame(
        outdoorSector(
          'Meadow',
          { x: 0, z: 0 },
          {
            placements: [{ id: 'notice-board-1', modelId: 'box', ...BOARD_AT, yaw: 0, elevation: 0 }],
            fixtures: [{ id: 'fixture-1', placement: 'notice-board-1', service: 'bountyBoard' }],
          },
        ),
      ),
    );
    expect(marked()).toBe('offer');
    rig.controller.dispatch(quests([{ questId, progress: [1], definition: bounty }]));
    expect(marked()).toBe('inProgress');
    rig.controller.dispatch(quests([{ questId, progress: [2], definition: bounty }]));
    expect(marked()).toBe('turnIn');
    expect(rig.controller.chatHistory).toEqual([{ kind: 'bountyDone' }]);
  });

  it('is not used once a new press lands on the way', () => {
    const rig = nearBoard();
    rig.session.pressFixture(BOARD);
    tickUntil(rig, 0, 300, () => false);
    rig.session.pressGround({ x: 10, z: 14 }, 350);
    rig.session.release({ x: 10, z: 14 });
    tickUntil(rig, 400, 4000, () => false);
    expect(interacts(rig)).toEqual([]);
  });
});

describe('the shop', () => {
  const MERCUS = 'npc:Meadow/mercus';
  const CUDGEL = item('cudgel');
  const DAGGER = item('dagger');

  const trades = (rig: Rig) => rig.sent.filter((message) => message.tag === 'buy' || message.tag === 'sell');

  /** Joins a meadow holding a cudgel, with Mercus a step south, and clicks him. */
  function atMercus(): { rig: Rig; repaints: () => number } {
    const rig = makeRig();
    rig.controller.dispatch(enterSpaceFrame());
    rig.controller.dispatch(sectorFrame(outdoorSector('Meadow', { x: 0, z: 0 })));
    rig.controller.dispatch(entityFrame({ facing: 30 }));
    rig.controller.dispatch(entityFrame({ id: MERCUS, kind: 'npc', name: 'Mercus', x: 10.3, z: 10.6, service: 'shopkeeper' }));
    rig.controller.dispatch(inventoryFrame(carrying({ coins: 100, bag: [CUDGEL] })));
    rig.session.pressEntity(MERCUS);
    rig.sent.length = 0;
    let repaints = 0;
    rig.session.onStateChanged = () => {
      repaints += 1;
    };
    return { rig, repaints: () => repaints };
  }

  it('asks the shopkeeper whose panel is open', () => {
    const { rig } = atMercus();
    rig.session.buy('dagger');
    rig.now = 5000;
    rig.session.sell(CUDGEL.id);
    expect(trades(rig)).toEqual([
      { tag: 'buy', payload: { carrierId: MERCUS, baseId: 'dagger' } },
      { tag: 'sell', payload: { carrierId: MERCUS, itemId: CUDGEL.id } },
    ]);
  });

  it('announces what a trade bought or sold, and not the coins it moved', () => {
    const { rig } = atMercus();
    rig.controller.dispatch(
      inventoryFrame(carrying({ coins: 40, bag: [CUDGEL, DAGGER] }), { trade: { kind: 'bought', baseId: 'dagger', rarity: 'plain', coins: 60 } }),
    );
    rig.controller.dispatch(inventoryFrame(carrying({ coins: 70, bag: [CUDGEL] }), { trade: { kind: 'sold', baseId: 'dagger', rarity: 'plain', coins: 30 } }));
    expect(rig.controller.chatHistory).toEqual([
      { kind: 'bought', baseId: 'dagger', coins: 60 },
      { kind: 'sold', baseId: 'dagger', coins: 30 },
    ]);
  });

  it('locks every trade from the request until a moment after its answer, and redraws once it gives way', () => {
    const { rig, repaints } = atMercus();
    rig.session.buy('dagger');
    expect(repaints()).toBe(1);
    expect(rig.session.tradeLocked()).toBe(true);
    rig.session.buy('sword');
    rig.session.sell(CUDGEL.id);
    expect(trades(rig)).toHaveLength(1);

    rig.now = 300;
    rig.controller.dispatch(
      inventoryFrame(carrying({ coins: 40, bag: [CUDGEL, DAGGER] }), { trade: { kind: 'bought', baseId: 'dagger', rarity: 'plain', coins: 60 } }),
    );
    const answered = repaints();
    rig.now = 799;
    rig.session.runTick(799);
    expect(rig.session.tradeLocked()).toBe(true);
    rig.now = 800;
    rig.session.runTick(800);
    rig.session.runTick(900);
    expect(rig.session.tradeLocked()).toBe(false);
    expect(repaints() - answered).toBe(1);
    rig.session.sell(CUDGEL.id);
    expect(trades(rig)).toHaveLength(2);
  });

  it('lets a trade the server refused go after a while', () => {
    const { rig, repaints } = atMercus();
    rig.session.buy('mace');
    rig.now = 1499;
    rig.session.runTick(1499);
    expect(rig.session.tradeLocked()).toBe(true);
    rig.now = 1500;
    rig.session.runTick(1500);
    expect(rig.session.tradeLocked()).toBe(false);
    expect(repaints()).toBe(2);
  });
});

describe('slot 1 at a nightmare', () => {
  const GHOST = 'monster:1';
  const GUARD = 'npc:Meadow/guard';
  const engages = (rig: Rig) => rig.sent.flatMap((message) => (message.tag === 'engage' ? [message.payload] : []));

  /** A player at (10, 10) with full pools, a nightmare out of their reach to the east, an NPC, and another dreamer. */
  function fighter(): Rig {
    const rig = makeRig();
    rig.controller.dispatch(enterSpaceFrame());
    rig.controller.dispatch(sectorFrame(outdoorSector('Meadow', { x: 0, z: 0 })));
    rig.controller.dispatch(entityFrame());
    rig.controller.dispatch(entityFrame({ id: GHOST, kind: 'monster', x: 14, z: 10 }));
    rig.controller.dispatch(entityFrame({ id: GUARD, kind: 'npc', name: 'Guard', x: 10, z: 14 }));
    rig.controller.dispatch(entityFrame({ id: 'far', kind: 'player', name: 'Far', x: 6, z: 10 }));
    rig.controller.dispatch({ tag: 'energy', payload: FULL });
    return rig;
  }

  it.each<[string, (rig: Rig) => void]>([
    ['without a target', () => {}],
    ['with an NPC as the target', (rig) => rig.session.selectEntity(GUARD)],
    ['with another dreamer as the target', (rig) => rig.session.selectEntity('far')],
    ['with themselves as the target', (rig) => rig.session.pressOwnFrame()],
    [
      'with the target driven off',
      (rig) => {
        rig.session.selectEntity(GHOST);
        rig.controller.dispatch({ tag: 'condition', payload: { entityId: GHOST, condition: 'fallen' } });
      },
    ],
    [
      'while fallen',
      (rig) => {
        rig.session.selectEntity(GHOST);
        rig.controller.dispatch({ tag: 'condition', payload: { entityId: 'self', condition: 'fallen' } });
      },
    ],
  ])('cannot be switched on %s by a dreamer who cannot mend', (_label, arrange) => {
    const rig = fighter();
    arrange(rig);
    expect([rig.session.engageable, rig.session.engageAction()]).toEqual([false, undefined]);
    rig.session.toggleEngage();
    expect(rig.session.engaged).toBe(false);
    expect(engages(rig)).toEqual([]);
  });

  it('is no Attack while a quest held forbids striking, as the server judges it, says so, and goes off as one is taken on', () => {
    const rig = fighter();
    rig.session.selectEntity(GHOST);
    rig.session.toggleEngage();
    expect([rig.session.engaged, rig.session.attackRefusal()]).toEqual([true, undefined]);
    rig.controller.dispatch({ tag: 'quests', payload: { active: [{ questId: 'healer-trial', progress: [0] }], done: [], bounties: [] } });
    rig.session.runTick(0);
    expect([rig.session.engaged, rig.session.engageAction(), rig.session.attackRefusal()]).toEqual([false, undefined, 'striking']);
    rig.session.toggleEngage();
    expect(rig.session.engaged).toBe(false);
    expect(engages(rig)).toEqual([{ on: true }]);
  });

  it('is Attack, switched on and off by the 1 key at a nightmare selected out of reach, and never walks the player toward it', () => {
    const rig = fighter();
    rig.session.selectEntity(GHOST);
    expect(rig.session.engageAction()).toBe('attack');
    let repaints = 0;
    rig.session.onStateChanged = () => (repaints += 1);
    rig.session.toggleEngage();
    expect(rig.session.engaged).toBe(true);
    for (let time = 0; time <= 1000; time += 100) rig.session.runTick(time);
    expect(rig.session.engaged).toBe(true);
    expect(rig.session.predictor.walk).toBeUndefined();
    expect(rig.controller.entities.get('self')!.position).toEqual({ x: 10, z: 10 });
    rig.session.toggleEngage();
    expect(rig.session.engaged).toBe(false);
    expect(engages(rig)).toEqual([{ on: true }, { on: false }]);
    expect(repaints).toBe(2);
  });

  /** The server switches it off at each of these on its own, so the client sends nothing for it. */
  it.each<[string, (rig: Rig) => void]>([
    ['a change of target to an NPC', (rig) => rig.session.selectEntity(GUARD)],
    ['a change of target to a dreamer, for one who cannot mend', (rig) => rig.session.selectEntity('far')],
    ['the target cleared', (rig) => rig.session.select(undefined)],
    ['the target driven off', (rig) => rig.controller.dispatch({ tag: 'condition', payload: { entityId: GHOST, condition: 'fallen' } })],
    ['the target out of view', (rig) => rig.controller.dispatch({ tag: 'leave', payload: { entityId: GHOST, leftGame: false } })],
    ['a fall', (rig) => rig.controller.dispatch({ tag: 'condition', payload: { entityId: 'self', condition: 'fallen' } })],
    ['a new space', (rig) => rig.controller.dispatch(enterSpaceFrame('Hall'))],
  ])('goes off with %s, sending no engage frame', (_label, end) => {
    const rig = fighter();
    rig.session.selectEntity(GHOST);
    rig.session.toggleEngage();
    end(rig);
    rig.session.runTick(100);
    expect(rig.session.engaged).toBe(false);
    expect(engages(rig)).toEqual([{ on: true }]);
  });

  it('stays on from one nightmare to the next, sending no engage frame', () => {
    const rig = fighter();
    rig.controller.dispatch(entityFrame({ id: 'monster:2', kind: 'monster', x: 14, z: 12 }));
    rig.session.selectEntity(GHOST);
    rig.session.toggleEngage();
    rig.session.selectEntity('monster:2');
    rig.session.runTick(100);
    expect(rig.session.engaged).toBe(true);
    expect(engages(rig)).toEqual([{ on: true }]);
  });

  it("slows the player when a blow names them as the attacker, and no longer than a swing slows, and not for anyone else's blow", () => {
    const rig = fighter();
    const stride = (from: number, to: number): number => {
      const before = rig.controller.entities.get('self')!.position;
      for (let time = from; time <= to; time += 100) rig.session.runTick(time);
      const after = rig.controller.entities.get('self')!.position;
      return Math.hypot(after.x - before.x, after.z - before.z);
    };
    tapGround(rig, UP_SCREEN);
    rig.session.runTick(0);
    rig.controller.dispatch({ tag: 'blow', payload: { attackerId: 'far', targetId: GHOST, hit: true } });
    const unslowed = stride(100, 300);
    rig.now = 400;
    rig.controller.dispatch({ tag: 'blow', payload: { attackerId: 'self', targetId: GHOST, hit: false } });
    // Three ticks inside the 0.4 s the swing slows, then three after it.
    const slowed = stride(500, 700);
    expect(slowed / unslowed).toBeCloseTo(0.7, 9);
    expect(stride(900, 1100) / unslowed).toBeCloseTo(1, 9);
  });
});

describe('the target', () => {
  const GHOST = 'monster:1';
  const targets = (rig: Rig) => rig.sent.flatMap((message) => (message.tag === 'target' ? [message.payload] : []));

  /** A player at (10, 10) in a meadow, a nightmare to the east, and Bren beside them. */
  function selecting(): Rig {
    const rig = makeRig();
    rig.controller.dispatch(enterSpaceFrame());
    rig.controller.dispatch(sectorFrame(outdoorSector('Meadow', { x: 0, z: 0 })));
    rig.controller.dispatch(entityFrame());
    rig.controller.dispatch(entityFrame({ id: GHOST, kind: 'monster', name: 'Ghost', x: 14, z: 10 }));
    rig.controller.dispatch(entityFrame({ id: 'bren', kind: 'player', name: 'Bren', x: 11, z: 10 }));
    rig.controller.dispatch({ tag: 'energy', payload: FULL });
    return rig;
  }

  it('is a nightmare a press lands on, which rings it and starts no walk', () => {
    const rig = selecting();
    rig.selections.length = 0;
    tapGround(rig, { x: 10, z: 14 });
    rig.session.selectEntity(GHOST);
    rig.session.runTick(200);

    expect(rig.session.target).toBe(GHOST);
    expect(targets(rig)).toEqual([{ targetId: GHOST }]);
    expect(rig.selections).toEqual([GHOST]);
    expect(rig.session.predictor.walk).toMatchObject({ kind: 'path', destination: { x: 10, z: 14 } });

    const idle = selecting();
    idle.session.selectEntity(GHOST);
    idle.session.runTick(100);
    expect(idle.session.predictor.walk).toBeUndefined();
  });

  it('stays the target through a walk on open ground, and is cleared and unringed on request', () => {
    const rig = selecting();
    rig.selections.length = 0;
    rig.session.selectEntity(GHOST);
    rig.session.release(undefined);
    tapGround(rig, { x: 10, z: 14 }, 100);
    expect(rig.session.target).toBe(GHOST);

    rig.session.select(undefined);
    rig.session.select(undefined);
    expect(targets(rig)).toEqual([{ targetId: GHOST }, {}]);
    expect(rig.selections).toEqual([GHOST, undefined]);
  });

  it('keeps the health the server sends of the target, and of no other', () => {
    const rig = selecting();
    rig.session.selectEntity(GHOST);
    let repaints = 0;
    rig.session.onStateChanged = () => (repaints += 1);
    rig.controller.dispatch({ tag: 'vitals', payload: { entityId: GHOST, health: 0.8 } });
    rig.controller.dispatch({ tag: 'vitals', payload: { entityId: 'bren', health: 0.4 } });
    rig.controller.dispatch({ tag: 'vitals', payload: { entityId: 'self', health: 1 } });

    expect([rig.session.vitalsOf(GHOST), rig.session.vitalsOf('bren'), rig.session.vitalsOf('self')]).toEqual([0.8, undefined, undefined]);
    expect(repaints).toBe(1);

    rig.session.pressPlayerName('Bren');
    expect(rig.session.vitalsOf(GHOST)).toBeUndefined();
    rig.controller.dispatch({ tag: 'vitals', payload: { entityId: 'bren', health: 0.4 } });
    expect(rig.session.vitalsOf('bren')).toBe(0.4);
  });

  it('is the dreamer whose name a press in the Players list lands on, whoever presses it, while they are in view', () => {
    const rig = selecting();
    rig.controller.dispatch({ tag: 'lucidity', payload: { role: 'fighter', ranks: [] } });
    rig.selections.length = 0;
    rig.session.pressPlayerName('Bren');
    rig.session.pressPlayerName('Bren');
    rig.session.pressPlayerName('Nobody');
    expect(rig.session.target).toBe('bren');
    expect(targets(rig)).toEqual([{ targetId: 'bren' }]);
    expect(rig.selections).toEqual(['bren']);
  });

  it('is cleared when it leaves, and with every new space, which tells the server nothing', () => {
    const gone = selecting();
    gone.session.selectEntity(GHOST);
    gone.controller.dispatch({ tag: 'leave', payload: { entityId: GHOST, leftGame: false } });
    gone.session.runTick(0);
    expect(gone.session.target).toBeUndefined();
    expect(targets(gone)).toEqual([{ targetId: GHOST }, {}]);

    const door = selecting();
    door.session.selectEntity(GHOST);
    door.controller.dispatch({ tag: 'vitals', payload: { entityId: GHOST, health: 0.5 } });
    door.controller.dispatch(enterSpaceFrame('Hall'));
    expect(door.session.target).toBeUndefined();
    expect(door.session.vitalsOf(GHOST)).toBeUndefined();
    expect(targets(door)).toEqual([{ targetId: GHOST }]);
    expect(door.selections.at(-1)).toBeUndefined();
  });

  it('stays through a fall, while a press selects nothing', () => {
    const rig = selecting();
    rig.session.selectEntity(GHOST);
    rig.controller.dispatch({ tag: 'condition', payload: { entityId: 'self', condition: 'fallen' } });
    rig.session.selectEntity('bren');
    expect(rig.session.target).toBe(GHOST);
    expect(targets(rig)).toEqual([{ targetId: GHOST }]);
  });
});

describe('the gaze lock', () => {
  const GHOST = 'monster:1';
  const targets = (rig: Rig) => rig.sent.flatMap((message) => (message.tag === 'target' ? [message.payload] : []));
  const engages = (rig: Rig) => rig.sent.flatMap((message) => (message.tag === 'engage' ? [message.payload] : []));

  /** A player at (10, 10) on a fine pointer, a nightmare to the east, Bren to the west, and the cursor far to the north. */
  function locking(): Rig {
    const rig = makeRig();
    rig.controller.dispatch(enterSpaceFrame());
    rig.controller.dispatch(sectorFrame(outdoorSector('Meadow', { x: 0, z: 0 })));
    rig.controller.dispatch(entityFrame());
    rig.controller.dispatch(entityFrame({ id: GHOST, kind: 'monster', name: 'Ghost', x: 14, z: 10 }));
    rig.controller.dispatch(entityFrame({ id: 'bren', kind: 'player', name: 'Bren', x: 7, z: 10 }));
    rig.controller.dispatch({ tag: 'energy', payload: FULL });
    rig.session.aimAt({ x: 10, z: -1000 });
    return rig;
  }

  const facing = (rig: Rig): number => rig.controller.entities.get('self')!.facing;

  it('locks on the nightmare a left press lands on and faces it whatever the cursor does, and faces the cursor again once the lock toggle lets go', () => {
    const rig = locking();
    rig.session.pressEntity(GHOST);
    expect([rig.session.target, rig.session.gazeLocked]).toEqual([GHOST, true]);
    expect(targets(rig)).toEqual([{ targetId: GHOST }]);
    for (let time = 0; time <= 200; time += 50) rig.session.runTick(time);
    expect(facing(rig)).toBeCloseTo(90, 0);

    tapGround(rig, { x: 10, z: 14 }, 250);
    rig.session.aimAt({ x: 10, z: 1000 });
    for (let time = 250; time <= 450; time += 50) rig.session.runTick(time);
    expect(rig.session.predictor.walk).toMatchObject({ kind: 'path', destination: { x: 10, z: 14 } });
    const self = rig.controller.entities.get('self')!;
    // Faced from where the last step began, a few centimetres back.
    expect(Math.abs(facing(rig) - headingFromVector(14 - self.position.x, 10 - self.position.z))).toBeLessThan(2);

    rig.session.toggleGazeLock();
    for (let time = 500; time <= 600; time += 50) rig.session.runTick(time);
    expect([rig.session.target, rig.session.gazeLocked]).toEqual([GHOST, false]);
    expect(Math.abs(((facing(rig) + 180) % 360) - 180)).toBeLessThan(0.5);
  });

  it('switches slot 1 on at a nightmare with the lock, after the target, and keeps both through a second left press on it', () => {
    const rig = locking();
    rig.session.pressEntity(GHOST);
    expect([rig.session.gazeLocked, rig.session.engaged]).toEqual([true, true]);
    expect(rig.sent.filter((message) => message.tag === 'target' || message.tag === 'engage')).toEqual([
      { tag: 'target', payload: { targetId: GHOST } },
      { tag: 'engage', payload: { on: true } },
    ]);

    rig.session.pressEntity(GHOST);
    expect([rig.session.target, rig.session.gazeLocked, rig.session.engaged]).toEqual([GHOST, true, true]);
    expect(targets(rig)).toEqual([{ targetId: GHOST }]);
    expect(engages(rig)).toEqual([{ on: true }]);
  });

  it('leaves the lock alone when the 1 key switches slot 1, and slot 1 alone when the lock toggle ends the lock', () => {
    const rig = locking();
    rig.session.pressEntity(GHOST);
    rig.session.toggleEngage();
    expect([rig.session.gazeLocked, rig.session.engaged]).toEqual([true, false]);
    rig.session.toggleEngage();
    expect([rig.session.gazeLocked, rig.session.engaged]).toEqual([true, true]);
    rig.session.toggleGazeLock();
    expect([rig.session.target, rig.session.gazeLocked, rig.session.engaged]).toEqual([GHOST, false, true]);
    expect(engages(rig)).toEqual([{ on: true }, { on: false }, { on: true }]);
  });

  it('sends nothing more for slot 1 when a left press locks on a target it already acts on', () => {
    const rig = locking();
    rig.session.selectEntity(GHOST);
    rig.session.toggleEngage();
    rig.session.pressEntity(GHOST);
    expect([rig.session.gazeLocked, rig.session.engaged]).toEqual([true, true]);
    expect(engages(rig)).toEqual([{ on: true }]);
  });

  it('is neither taken nor let go by a right press on the target, which changes nothing', () => {
    const rig = locking();
    rig.session.selectEntity(GHOST);
    expect([rig.session.gazeLocked, rig.session.engaged]).toEqual([false, false]);
    rig.session.pressEntity(GHOST);
    rig.session.selectEntity(GHOST);
    expect([rig.session.target, rig.session.gazeLocked, rig.session.engaged]).toEqual([GHOST, true, true]);
    expect(targets(rig)).toEqual([{ targetId: GHOST }]);
    expect(engages(rig)).toEqual([{ on: true }]);
  });

  it('marks the target as locked in the scene from the lock until it ends, and as plain at a new target', () => {
    const rig = locking();
    const marks = (): [string | undefined, TargetMark][] => rig.selections.map((id, index) => [id, rig.selectionMarks[index]!]);
    const ON = { locked: true, acting: true };
    const OFF = { locked: false, acting: false };
    rig.selections.length = 0;
    rig.selectionMarks.length = 0;

    rig.session.pressEntity(GHOST);
    expect(marks()).toEqual([
      [GHOST, OFF],
      [GHOST, ON],
    ]);
    rig.session.toggleGazeLock();
    expect(marks().at(-1)).toEqual([GHOST, { locked: false, acting: true }]);
    rig.session.pressEntity(GHOST);
    expect(marks().at(-1)).toEqual([GHOST, ON]);
    rig.session.selectEntity('bren');
    expect(marks().at(-1)).toEqual(['bren', OFF]);
    rig.session.pressEntity(GHOST);
    rig.controller.dispatch({ tag: 'condition', payload: { entityId: GHOST, condition: 'fallen' } });
    rig.session.runTick(0);
    expect(marks().at(-1)).toEqual([GHOST, OFF]);
  });

  it('marks slot 1 by colour and the lock by the ticks, apart from each other', () => {
    const rig = locking();
    rig.session.selectEntity(GHOST);
    expect(rig.selectionMarks.at(-1)).toEqual({ locked: false, acting: false });
    rig.session.toggleEngage();
    expect(rig.selectionMarks.at(-1)).toEqual({ locked: false, acting: true });
    rig.session.pressEntity(GHOST);
    expect(rig.selectionMarks.at(-1)).toEqual({ locked: true, acting: true });
    rig.session.toggleEngage();
    expect(rig.selectionMarks.at(-1)).toEqual({ locked: true, acting: false });
    rig.session.toggleEngage();
    rig.controller.dispatch({ tag: 'condition', payload: { entityId: 'self', condition: 'fallen' } });
    expect(rig.selectionMarks.at(-1)).toEqual({ locked: true, acting: false });
  });

  it('is not taken by a left press on a body slot 1 cannot act on: an NPC, or another dreamer for one who cannot mend', () => {
    const rig = locking();
    rig.controller.dispatch(entityFrame({ id: 'npc:Meadow/guard', kind: 'npc', name: 'Guard', x: 10, z: 6 }));
    rig.session.pressEntity('npc:Meadow/guard');
    expect([rig.session.target, rig.session.gazeLocked, rig.session.engaged]).toEqual(['npc:Meadow/guard', false, false]);
    rig.session.pressEntity('bren');
    expect([rig.session.target, rig.session.gazeLocked, rig.session.engaged]).toEqual(['bren', false, false]);
    expect(engages(rig)).toEqual([]);
  });

  it.each<[string, (rig: Rig) => void]>([
    ['the target is cleared', (rig) => rig.session.select(undefined)],
    ['a right press on another body makes it the target', (rig) => rig.session.selectEntity('bren')],
    ['the target leaves', (rig) => rig.controller.dispatch({ tag: 'leave', payload: { entityId: GHOST, leftGame: false } })],
    ['the target is driven off', (rig) => rig.controller.dispatch({ tag: 'condition', payload: { entityId: GHOST, condition: 'fallen' } })],
    ['a new space is entered', (rig) => rig.controller.dispatch(enterSpaceFrame('Hall'))],
  ])('ends when %s', (_label, end) => {
    const rig = locking();
    rig.session.pressEntity(GHOST);
    end(rig);
    rig.session.runTick(0);
    expect(rig.session.gazeLocked).toBe(false);
  });

  it('holds through a left press on the ground and the walk it makes', () => {
    const rig = locking();
    rig.session.pressEntity(GHOST);
    tapGround(rig, { x: 10, z: 14 });
    rig.session.runTick(0);
    expect(rig.session.gazeLocked).toBe(true);
  });

  it('is taken and let go by the lock button on any body targeted but the player, leaving slot 1 as it is', () => {
    const rig = locking();
    rig.controller.dispatch(entityFrame({ id: 'npc:Meadow/guard', kind: 'npc', name: 'Guard', x: 10, z: 6 }));
    expect(rig.session.gazeLockable).toBe(false);
    rig.session.toggleGazeLock();
    expect(rig.session.gazeLocked).toBe(false);

    rig.session.selectEntity('npc:Meadow/guard');
    expect(rig.session.gazeLockable).toBe(true);
    rig.session.toggleGazeLock();
    expect([rig.session.target, rig.session.gazeLocked, rig.session.engaged]).toEqual(['npc:Meadow/guard', true, false]);
    rig.session.toggleGazeLock();
    expect(rig.session.gazeLocked).toBe(false);

    rig.session.pressEntity(GHOST);
    rig.session.toggleGazeLock();
    expect([rig.session.target, rig.session.gazeLocked, rig.session.engaged]).toEqual([GHOST, false, true]);
    rig.session.toggleGazeLock();
    expect([rig.session.gazeLocked, rig.session.engaged]).toEqual([true, true]);
    expect(engages(rig)).toEqual([{ on: true }]);

    rig.session.pressOwnFrame();
    expect(rig.session.gazeLockable).toBe(false);
    rig.session.toggleGazeLock();
    expect([rig.session.target, rig.session.gazeLocked]).toEqual(['self', false]);
  });

  it('locks nothing at a nightmare already driven off', () => {
    const rig = locking();
    rig.controller.dispatch({ tag: 'condition', payload: { entityId: GHOST, condition: 'fallen' } });
    rig.session.pressEntity(GHOST);
    expect([rig.session.target, rig.session.gazeLocked]).toEqual([GHOST, false]);
  });
});

describe('a left press on a body', () => {
  const GHOST = 'monster:1';
  const GUARD = 'npc:Meadow/guard';
  const HEALER = { tag: 'lucidity' as const, payload: { role: 'healer' as const, ranks: [{ teachingId: 'touch', rank: 1, practice: 0 }] } };
  const at = (rig: Rig) => rig.controller.entities.get('self')!.position;
  const away = (rig: Rig, entityId: string): number => {
    const self = at(rig);
    const body = rig.controller.entities.get(entityId)!.position;
    return Math.hypot(body.x - self.x, body.z - self.z);
  };
  const interacts = (rig: Rig) => rig.sent.filter((message) => message.tag === 'interact');

  it('walks the player into reach of a nightmare and stops there, with slot 1 on', () => {
    const rig = meadowOfBodies();
    rig.session.pressEntity(GHOST);
    tickUntil(rig, 0, 4000, () => rig.session.predictor.walk === undefined);

    const reach = reachDistance(rig.controller.entities.get(GHOST)!.radius);
    expect(away(rig, GHOST)).toBeLessThanOrEqual(reach);
    expect(away(rig, GHOST)).toBeGreaterThan(reach - 0.5);
    expect(rig.session.engaged).toBe(true);
    tickUntil(rig, 4000, 4500, () => false);
    expect(away(rig, GHOST)).toBeLessThanOrEqual(reach);
  });

  it('follows a nightmare that moves on, and stands once in reach though it moves away again', () => {
    const rig = meadowOfBodies();
    rig.session.pressEntity(GHOST);
    let time = tickUntil(rig, 0, 400, () => false);
    rig.now = time;
    rig.controller.dispatch({ tag: 'moves', payload: { moves: [{ id: GHOST, x: 16, z: 16, facing: 0, gait: 'jog' }] } });
    time = tickUntil(rig, time, 5000, () => rig.session.predictor.walk === undefined);

    expect(rig.controller.entities.get(GHOST)!.position).toEqual({ x: 16, z: 16 });
    expect(away(rig, GHOST)).toBeLessThanOrEqual(reachDistance(rig.controller.entities.get(GHOST)!.radius));

    rig.now = time;
    rig.controller.dispatch({ tag: 'moves', payload: { moves: [{ id: GHOST, x: 22, z: 16, facing: 90, gait: 'jog' }] } });
    const stood = { ...at(rig) };
    tickUntil(rig, time, time + 1000, () => false);
    expect(at(rig)).toEqual(stood);
  });

  it('drops the press ring on the body it walks the player to, moves it with the body, and lifts it in reach, but drops none from within reach', () => {
    const rig = meadowOfBodies();
    rig.session.pressEntity(GHOST);
    expect(rig.pressMarks).toEqual([['show', { x: 16, z: 10 }]]);
    const time = tickUntil(rig, 0, 400, () => false);
    rig.now = time;
    rig.controller.dispatch({ tag: 'moves', payload: { moves: [{ id: GHOST, x: 16, z: 13, facing: 0, gait: 'jog' }] } });
    tickUntil(rig, time, 6000, () => rig.session.predictor.walk === undefined);
    rig.session.runTick(6050);
    expect(rig.pressMarks.filter(([kind]) => kind === 'show').at(-1)).toEqual(['show', { x: 16, z: 13 }]);
    expect(rig.pressMarks.at(-1)).toEqual(['lift']);

    rig.pressMarks.length = 0;
    rig.session.pressEntity(GHOST);
    expect(rig.pressMarks).toEqual([]);
  });

  it('walks on toward a nightmare that stepped back as the player came in range of where it stood', () => {
    const rig = meadowOfBodies();
    rig.session.pressEntity(GHOST);
    const reach = reachDistance(rig.controller.entities.get(GHOST)!.radius);
    const time = tickUntil(rig, 0, 4000, () => away(rig, GHOST) < reach + 0.3);
    rig.now = time;
    rig.controller.dispatch({ tag: 'moves', payload: { moves: [{ id: GHOST, x: 16.45, z: 10, facing: 90, gait: 'jog' }] } });
    tickUntil(rig, time, 6000, () => rig.session.predictor.walk === undefined);

    expect(rig.controller.entities.get(GHOST)!.position).toEqual({ x: 16.45, z: 10 });
    expect(away(rig, GHOST)).toBeLessThanOrEqual(reach);
  });

  it('stops in reach of a nightmare coming to meet the player, short of where the walk heads', () => {
    const rig = meadowOfBodies();
    rig.session.pressEntity(GHOST);
    const reach = reachDistance(rig.controller.entities.get(GHOST)!.radius);
    const time = tickUntil(rig, 0, 4000, () => away(rig, GHOST) < reach + 0.8);
    rig.now = time;
    rig.controller.dispatch({ tag: 'moves', payload: { moves: [{ id: GHOST, x: 15.6, z: 10, facing: 270, gait: 'jog' }] } });
    tickUntil(rig, time, 6000, () => rig.session.predictor.walk === undefined);

    expect(rig.controller.entities.get(GHOST)!.position).toEqual({ x: 15.6, z: 10 });
    expect(away(rig, GHOST)).toBeLessThanOrEqual(reach);
    expect(away(rig, GHOST)).toBeGreaterThan(reach - 0.15);
  });

  it('stops the walk toward a body when a right press makes another body the target', () => {
    const rig = meadowOfBodies();
    rig.session.pressEntity(GHOST);
    tickUntil(rig, 0, 300, () => false);
    rig.session.selectEntity('bren');
    expect([rig.session.target, rig.session.predictor.walk]).toEqual(['bren', undefined]);
    const stood = { ...at(rig) };
    tickUntil(rig, 350, 1000, () => false);
    expect(at(rig)).toEqual(stood);
  });

  it('stops on Escape where the player stands, a walk toward a body as a tap on the ground, lifting the ring, and leaves a leap be', () => {
    const rig = meadowOfBodies();
    expect(rig.session.stopWalk()).toBe(false);

    rig.session.pressEntity(GHOST);
    let time = tickUntil(rig, 0, 300, () => false);
    expect(rig.session.stopWalk()).toBe(true);
    expect([rig.session.predictor.walk, rig.pressMarks.at(-1)]).toEqual([undefined, ['lift']]);
    const stood = { ...at(rig) };
    rig.now = time;
    rig.controller.dispatch({ tag: 'moves', payload: { moves: [{ id: GHOST, x: 16, z: 13, facing: 0, gait: 'jog' }] } });
    time = tickUntil(rig, time, time + 1000, () => false);
    expect(at(rig)).toEqual(stood);

    tapGround(rig, { x: 10, z: 4 }, time);
    tickUntil(rig, time, time + 200, () => false);
    expect(rig.session.stopWalk()).toBe(true);
    expect(rig.session.predictor.walk).toBeUndefined();

    rig.session.predictor.leapAt({ x: 16, z: 13, radius: 0.3 }, 3, 12);
    expect(rig.session.stopWalk()).toBe(false);
    expect(rig.session.predictor.walk).toMatchObject({ kind: 'leap' });
  });

  it('stops the walk under way and walks nowhere from within reach', () => {
    const rig = meadowOfBodies();
    rig.controller.dispatch(entityFrame({ id: 'monster:2', kind: 'monster', name: 'Ghost', x: 10.65, z: 10 }));
    tapGround(rig, { x: 10, z: 4 });
    tickUntil(rig, 0, 100, () => false);
    const stood = { ...at(rig) };
    rig.session.pressEntity('monster:2');
    expect(rig.session.predictor.walk).toBeUndefined();
    tickUntil(rig, 150, 1000, () => false);
    expect(at(rig)).toEqual(stood);
    expect(rig.session.engaged).toBe(true);
  });

  it('ends the following on a press on the ground, whose walk goes where it lets go', () => {
    const rig = meadowOfBodies();
    rig.session.pressEntity(GHOST);
    let time = tickUntil(rig, 0, 300, () => false);
    rig.session.pressGround({ x: 10, z: 4 }, time);
    rig.now = time;
    rig.controller.dispatch({ tag: 'moves', payload: { moves: [{ id: GHOST, x: 16, z: 16, facing: 0, gait: 'jog' }] } });
    time = tickUntil(rig, time, time + 150, () => false);
    expect(rig.session.predictor.walk).toMatchObject({ kind: 'path', destination: { x: 16, z: 10 } });
    rig.session.release({ x: 10, z: 4 });
    // The gaze stays locked on the nightmare, so the player backs away from it at a walk.
    tickUntil(rig, time, 12000, () => rig.session.predictor.walk === undefined);
    expect(Math.hypot(at(rig).x - 10, at(rig).z - 4)).toBeLessThanOrEqual(PATH_FOLLOWING.arrivalMetres);
  });

  it('only selects a nightmare while a quest held forbids striking, walking nowhere', () => {
    const rig = meadowOfBodies();
    rig.controller.dispatch({ tag: 'quests', payload: { active: [{ questId: 'healer-trial', progress: [0] }], done: [], bounties: [] } });
    rig.session.pressEntity(GHOST);
    expect([rig.session.target, rig.session.gazeLocked, rig.session.engaged, rig.session.predictor.walk]).toEqual([GHOST, false, false, undefined]);
  });

  it('walks one who cannot mend up beside another dreamer, neither locking nor switching slot 1 on', () => {
    const rig = meadowOfBodies();
    rig.session.pressEntity('bren');
    expect([rig.session.target, rig.session.gazeLocked, rig.session.engaged]).toEqual(['bren', false, false]);
    expect(rig.session.predictor.walk).toMatchObject({ kind: 'path' });
    tickUntil(rig, 0, 4000, () => rig.session.predictor.walk === undefined);
    const beside = reachDistance(rig.controller.entities.get('bren')!.radius);
    expect(away(rig, 'bren')).toBeLessThanOrEqual(beside);
    expect(away(rig, 'bren')).toBeGreaterThan(beside - 0.5);
    expect(rig.sent.filter((message) => message.tag === 'engage' || message.tag === 'interact')).toEqual([]);
  });

  it('walks a Healer with the Moonstone up beside a dreamer with Mend on, a fallen one too', () => {
    const rig = meadowOfBodies();
    rig.controller.dispatch(HEALER);
    rig.controller.dispatch(MOONSTONE_IN_HAND);
    rig.session.pressEntity('bren');
    expect([rig.session.engaged, rig.session.gazeLocked, rig.session.engageAction()]).toEqual([true, true, 'mend']);
    tickUntil(rig, 0, 4000, () => rig.session.predictor.walk === undefined);
    expect(away(rig, 'bren')).toBeLessThanOrEqual(reachDistance(rig.controller.entities.get('bren')!.radius));

    rig.controller.dispatch({ tag: 'condition', payload: { entityId: 'bren', condition: 'fallen' } });
    rig.session.pressEntity('bren');
    tickUntil(rig, 4050, 8000, () => rig.session.predictor.walk === undefined);
    expect(away(rig, 'bren')).toBeLessThanOrEqual(reachDistance(rig.controller.entities.get('bren')!.radius));
  });

  it('walks up beside an NPC and asks it to go on as the player comes within speaking distance, after the move that brought them there', () => {
    const rig = meadowOfBodies();
    rig.session.pressEntity(GUARD);
    expect(interacts(rig)).toEqual([]);
    const time = tickUntil(rig, 0, 4000, () => interacts(rig).length > 0);

    expect(away(rig, GUARD)).toBeLessThanOrEqual(SOMNIO_CONSTANTS.speakingDistance);
    expect(rig.sent.slice(-2)).toEqual([
      { tag: 'move', payload: expect.objectContaining(at(rig)) },
      { tag: 'interact', payload: { carrierId: GUARD } },
    ]);
    expect([rig.session.target, rig.session.gazeLocked, rig.session.engaged]).toEqual([GUARD, false, false]);

    // It asks before the player stands beside the NPC, and the walk goes on there, asking nothing more.
    expect(away(rig, GUARD)).toBeGreaterThan(reachDistance(rig.controller.entities.get(GUARD)!.radius));
    expect(rig.session.predictor.walk).toMatchObject({ kind: 'path' });
    tickUntil(rig, time + 50, time + 4000, () => rig.session.predictor.walk === undefined);
    expect(away(rig, GUARD)).toBeLessThanOrEqual(reachDistance(rig.controller.entities.get(GUARD)!.radius));
    expect(interacts(rig)).toHaveLength(1);
  });

  it('asks an NPC behind a counter as the walk ends within speaking distance, on the step that brings the player there', () => {
    const rig = makeRig();
    rig.controller.dispatch(enterSpaceFrame());
    // The walk's nearest cell to the NPC, short of the counter, lies under 1.9 m from it.
    rig.controller.dispatch(sectorFrame(outdoorSector('Meadow', { x: 0, z: 0 }, { blockers: [{ id: 'counter', x: 0, z: 14.55, width: 20, depth: 0.85 }] })));
    rig.controller.dispatch(entityFrame());
    rig.controller.dispatch(entityFrame({ id: GUARD, kind: 'npc', name: 'Guard', x: 10, z: 16 }));
    rig.controller.dispatch({ tag: 'energy', payload: FULL });
    rig.session.pressEntity(GUARD);
    let time = 0;
    for (; away(rig, GUARD) > SOMNIO_CONSTANTS.speakingDistance + 0.05 && time <= 5000; time += 25) rig.session.runTick(time);
    expect(away(rig, GUARD)).toBeGreaterThan(SOMNIO_CONSTANTS.speakingDistance);
    expect([interacts(rig), rig.session.predictor.walk?.kind]).toEqual([[], 'path']);

    // One step on, the walk reaches its last cell and ends there, within speaking distance.
    rig.session.runTick(time + 75);

    expect(rig.session.predictor.walk).toBeUndefined();
    expect(away(rig, GUARD)).toBeLessThanOrEqual(SOMNIO_CONSTANTS.speakingDistance);
    expect(interacts(rig)).toEqual([{ tag: 'interact', payload: { carrierId: GUARD } }]);
  });

  it('asks nothing of an NPC once a press on a drop takes over its walk, though that walk ends within speaking distance in its first step', () => {
    const rig = makeRig();
    rig.controller.dispatch(enterSpaceFrame());
    rig.controller.dispatch(sectorFrame(outdoorSector('Meadow', { x: 0, z: 0 })));
    rig.controller.dispatch(entityFrame());
    rig.controller.dispatch(entityFrame({ id: GUARD, kind: 'npc', name: 'Guard', x: 10, z: 12.05 }));
    rig.controller.dispatch({ tag: 'energy', payload: FULL });
    rig.controller.dispatch({ tag: 'loot', payload: { lootId: 'loot-1', x: 10, z: 11.02, contents: { kind: 'item', baseId: 'dagger', rarity: 'magic' } } });
    rig.session.runTick(0);
    rig.session.pressEntity(GUARD);
    rig.session.pressLoot('loot-1');

    rig.session.runTick(50);

    // The step carries the player within speaking distance of the NPC and pickup reach of the drop at once.
    expect(away(rig, GUARD)).toBeLessThanOrEqual(SOMNIO_CONSTANTS.speakingDistance);
    expect(rig.sent.filter((message) => message.tag === 'pickUp')).toEqual([{ tag: 'pickUp', payload: { lootId: 'loot-1' } }]);
    expect([interacts(rig), rig.session.servicePanel]).toEqual([[], undefined]);
  });

  it('stops the walk where the player stands once the nightmare it heads for is driven off', () => {
    const rig = meadowOfBodies();
    rig.session.pressEntity(GHOST);
    const time = tickUntil(rig, 0, 500, () => false);
    expect(rig.session.predictor.walk).toMatchObject({ kind: 'path' });

    rig.controller.dispatch({ tag: 'condition', payload: { entityId: GHOST, condition: 'fallen' } });
    rig.session.runTick(time);
    const stood = { ...at(rig) };
    tickUntil(rig, time + 50, time + 1000, () => false);

    expect([rig.session.predictor.walk, at(rig), rig.pressMarks.at(-1)]).toEqual([undefined, stood, ['lift']]);
    expect(away(rig, GHOST)).toBeGreaterThan(reachDistance(rig.controller.entities.get(GHOST)!.radius) + 2);
  });

  it.each<[string, (rig: Rig) => void]>([
    ['while the player lies fallen', (rig) => rig.controller.dispatch({ tag: 'condition', payload: { entityId: 'self', condition: 'fallen' } })],
    ['under an overlay', (rig) => (rig.controller.presentedOverlay = { kind: 'gameMenu' })],
  ])('neither selects, locks, switches slot 1 on, nor walks on a press on a body %s', (_when, gate) => {
    const rig = meadowOfBodies();
    gate(rig);

    rig.session.pressEntity(GHOST);
    rig.session.pressEntity(GUARD);

    expect([rig.session.target, rig.session.gazeLocked, rig.session.engaged, rig.session.predictor.walk]).toEqual([undefined, false, false, undefined]);
    expect(rig.sent.filter((message) => ['target', 'engage', 'interact'].includes(message.tag))).toEqual([]);
  });

  it('stops a held press steering on Escape where the player stands, and the press then walks nowhere', () => {
    const rig = meadowOfBodies();
    rig.session.pressGround({ x: 10, z: 4 }, 0);
    const time = tickUntil(rig, 0, HOLD_TO_STEER_MS + 100, () => false);
    expect(rig.session.predictor.walk).toMatchObject({ kind: 'steer' });

    expect(rig.session.stopWalk()).toBe(true);
    const stood = { ...at(rig) };
    tickUntil(rig, time, time + 500, () => false);
    rig.session.release({ x: 10, z: 4 });

    expect([rig.session.predictor.walk, at(rig)]).toEqual([undefined, stood]);
  });
});

describe("a finger's press on a body", () => {
  const GHOST = 'monster:1';
  const engages = (rig: Rig) => rig.sent.filter((message) => message.tag === 'engage');

  it('only selects the body when it lifts after resting there, though no frame has run since', () => {
    const rig = meadowOfBodies({ coarsePointer: true });
    rig.session.holdEntity(GHOST, 0);
    rig.session.runTick(FINGER_HOLD_MS - 10);
    expect(rig.session.target).toBeUndefined();

    rig.now = FINGER_HOLD_MS + 10;
    rig.session.release({ x: 16, z: 10 });

    expect([rig.session.target, rig.session.gazeLocked, rig.session.engaged, rig.session.predictor.walk]).toEqual([GHOST, false, false, undefined]);
    expect(engages(rig)).toEqual([]);
  });

  it('leaves the ring of the walk under way when a finger resting on a body is let go', () => {
    const rig = meadowOfBodies({ coarsePointer: true });
    tapGround(rig, { x: 10, z: 4 });
    tickUntil(rig, 0, 100, () => false);
    expect(rig.pressMarks.at(-1)).toEqual(['show', { x: 10, z: 4 }]);

    rig.session.holdEntity(GHOST, 150);
    rig.session.letGo();

    expect(rig.pressMarks.at(-1)).toEqual(['show', { x: 10, z: 4 }]);
    expect(rig.session.predictor.walk).toMatchObject({ kind: 'path' });
  });

  it('acts as a left press when it lifts before the hold selects', () => {
    const rig = meadowOfBodies({ coarsePointer: true });
    rig.session.holdEntity(GHOST, 0);
    rig.session.runTick(FINGER_HOLD_MS - 50);
    expect(rig.session.target).toBeUndefined();
    rig.session.release({ x: 16, z: 10 });
    expect([rig.session.target, rig.session.gazeLocked, rig.session.engaged]).toEqual([GHOST, true, true]);
    expect(rig.session.predictor.walk).toMatchObject({ kind: 'path' });
  });

  it('only selects the body once it rests there, and the lift then does nothing', () => {
    const rig = meadowOfBodies({ coarsePointer: true });
    rig.session.holdEntity(GHOST, 0);
    rig.session.runTick(FINGER_HOLD_MS);
    expect([rig.session.target, rig.session.gazeLocked, rig.session.engaged]).toEqual([GHOST, false, false]);
    rig.session.release({ x: 16, z: 10 });
    expect([rig.session.engaged, rig.session.predictor.walk]).toEqual([false, undefined]);
    expect(engages(rig)).toEqual([]);
  });

  it('steers toward the ground under it once it slides, and walks on to where it lifts, selecting nothing', () => {
    const rig = meadowOfBodies({ coarsePointer: true });
    rig.session.holdEntity(GHOST, 0);
    rig.session.moveHold({ x: 10, z: 4 });
    rig.session.steer();
    rig.session.runTick(FINGER_HOLD_MS + 100);
    expect(rig.session.predictor.walk).toMatchObject({ kind: 'steer', toward: { x: 10, z: 4 } });
    rig.session.release({ x: 10, z: 4 });
    expect(rig.session.predictor.walk).toMatchObject({ kind: 'path', destination: { x: 10, z: 4 } });
    expect(rig.session.target).toBeUndefined();
  });
});

describe('the own frame', () => {
  const HEALER = { tag: 'lucidity' as const, payload: { role: 'healer' as const, ranks: [{ teachingId: 'touch', rank: 1, practice: 0 }] } };

  function standing(): Rig {
    const rig = makeRig();
    rig.controller.dispatch(enterSpaceFrame());
    rig.controller.dispatch(sectorFrame(outdoorSector('Meadow', { x: 0, z: 0 })));
    rig.controller.dispatch(entityFrame());
    rig.controller.dispatch(entityFrame({ id: 'bren', kind: 'player', name: 'Bren', x: 11, z: 10 }));
    rig.controller.dispatch({ tag: 'energy', payload: { ...FULL, healthCurrent: FULL.healthMax / 4 } });
    return rig;
  }

  it('makes the player their own target on a press, health read from their own pools, and moves on with the next frame', () => {
    const rig = standing();
    expect(rig.session.vitalsOf('self')).toBeUndefined();
    rig.session.pressOwnFrame();
    expect(rig.session.target).toBe('self');
    expect(rig.sent).toContainEqual({ tag: 'target', payload: { targetId: 'self' } });
    expect(rig.session.vitalsOf('self')).toBe(0.25);
    rig.controller.dispatch({ tag: 'energy', payload: { ...FULL, healthCurrent: FULL.healthMax / 2 } });
    expect(rig.session.vitalsOf('self')).toBe(0.5);
    rig.session.pressOwnFrame();
    expect(rig.session.target).toBe('self');
  });

  it('makes a Healer their own target too, keeping Mend on from the dreamer before, so it mends themselves', () => {
    const rig = standing();
    rig.controller.dispatch(HEALER);
    rig.controller.dispatch(MOONSTONE_IN_HAND);
    rig.session.selectEntity('bren');
    rig.session.toggleEngage();
    rig.session.pressOwnFrame();
    rig.session.runTick(0);
    expect([rig.session.target, rig.session.engaged, rig.session.engageAction()]).toEqual(['self', true, 'mend']);
    expect(rig.session.vitalsOf('self')).toBe(0.25);
  });

  it('does nothing while the player lies fallen', () => {
    const rig = standing();
    rig.controller.dispatch({ tag: 'condition', payload: { entityId: 'self', condition: 'fallen' } });
    rig.session.pressOwnFrame();
    expect(rig.session.target).toBeUndefined();
  });
});

describe('slot 1 at a dreamer', () => {
  const HEALER = { tag: 'lucidity' as const, payload: { role: 'healer' as const, ranks: [{ teachingId: 'touch', rank: 1, practice: 0 }] } };
  const engages = (rig: Rig) => rig.sent.flatMap((message) => (message.tag === 'engage' ? [message.payload] : []));

  function healer(): Rig {
    const rig = makeRig();
    rig.controller.dispatch(enterSpaceFrame());
    rig.controller.dispatch(sectorFrame(outdoorSector('Meadow', { x: 0, z: 0 })));
    rig.controller.dispatch(entityFrame());
    rig.controller.dispatch(entityFrame({ id: 'bren', kind: 'player', name: 'Bren', x: 11, z: 10 }));
    rig.controller.dispatch(entityFrame({ id: 'cara', kind: 'player', name: 'Cara', x: 9, z: 10 }));
    rig.controller.dispatch({ tag: 'energy', payload: FULL });
    rig.controller.dispatch(HEALER);
    rig.controller.dispatch(MOONSTONE_IN_HAND);
    return rig;
  }

  /** Targets the dreamer and switches Mend on. */
  function mend(rig: Rig, entityId: string): void {
    rig.session.selectEntity(entityId);
    rig.session.toggleEngage();
  }

  it('is Mend for a Healer with the Moonstone in hand, whose right press at a dreamer only targets them', () => {
    const rig = healer();
    rig.selections.length = 0;
    rig.session.selectEntity('bren');
    expect([rig.session.target, rig.session.engaged, rig.session.engageAction()]).toEqual(['bren', false, 'mend']);
    expect(rig.selections).toEqual(['bren']);
    rig.session.toggleEngage();
    expect(rig.session.engaged).toBe(true);
    rig.session.toggleEngage();
    expect(engages(rig)).toEqual([{ on: true }, { on: false }]);
  });

  it('is switched on as Mend by a left press at a dreamer for a Healer with the Moonstone in hand, and not with it put away', () => {
    const rig = healer();
    rig.session.pressEntity('bren');
    expect([rig.session.target, rig.session.gazeLocked, rig.session.engaged, rig.session.engageAction()]).toEqual(['bren', true, true, 'mend']);
    expect(engages(rig)).toEqual([{ on: true }]);

    const without = healer();
    without.controller.dispatch(MOONSTONE_PUT_AWAY);
    without.session.pressEntity('bren');
    expect([without.session.gazeLocked, without.session.engaged]).toEqual([false, false]);
    expect(engages(without)).toEqual([]);
  });

  it.each<[string, (rig: Rig) => void]>([
    ['for a Healer with the Moonstone put away', (rig) => rig.controller.dispatch(MOONSTONE_PUT_AWAY)],
    ['for a Fighter', (rig) => rig.controller.dispatch({ tag: 'lucidity', payload: { role: 'fighter', ranks: [] } })],
  ])('cannot be switched on %s', (_label, arrange) => {
    const rig = healer();
    arrange(rig);
    rig.session.selectEntity('bren');
    expect(rig.session.engageAction()).toBeUndefined();
    rig.session.toggleEngage();
    expect(rig.session.engaged).toBe(false);
    expect(engages(rig)).toEqual([]);
  });

  it('is nothing at an NPC, a master included', () => {
    const rig = healer();
    rig.controller.dispatch(entityFrame({ id: 'npc:Meadow/sana', kind: 'npc', name: 'Sana', x: 14, z: 10, service: 'healerMaster' }));
    rig.session.selectEntity('npc:Meadow/sana');
    expect([rig.session.target, rig.session.engageAction()]).toEqual(['npc:Meadow/sana', undefined]);
    rig.session.toggleEngage();
    expect(rig.session.engaged).toBe(false);
    expect(engages(rig)).toEqual([]);
  });

  it('stays on from one dreamer to the next, and at a nightmare, which the empty main hand attacks', () => {
    const rig = healer();
    rig.controller.dispatch(entityFrame({ id: 'monster:1', kind: 'monster', x: 14, z: 10 }));
    mend(rig, 'bren');
    rig.session.pressPlayerName('Cara');
    rig.session.runTick(0);
    expect([rig.session.target, rig.session.engaged]).toEqual(['cara', true]);
    rig.session.selectEntity('monster:1');
    rig.session.runTick(100);
    expect([rig.session.engaged, rig.session.engageAction()]).toEqual([true, 'attack']);
    expect(engages(rig)).toEqual([{ on: true }]);
  });

  it('stays on when the dreamer it mends falls, since Mend raises them', () => {
    const rig = healer();
    mend(rig, 'bren');
    rig.controller.dispatch({ tag: 'condition', payload: { entityId: 'bren', condition: 'fallen' } });
    rig.session.runTick(0);
    expect([rig.session.engaged, rig.session.engageAction()]).toEqual([true, 'mend']);
  });

  /** The server switches it off at each of these on its own, so the client sends nothing for it. */
  it.each<[string, (rig: Rig) => void]>([
    ['the target out of view', (rig) => rig.controller.dispatch({ tag: 'leave', payload: { entityId: 'bren', leftGame: false } })],
    ['the Moonstone put away', (rig) => rig.controller.dispatch(MOONSTONE_PUT_AWAY)],
    ['a fall', (rig) => rig.controller.dispatch({ tag: 'condition', payload: { entityId: 'self', condition: 'fallen' } })],
    ['a new space', (rig) => rig.controller.dispatch(enterSpaceFrame('Hall'))],
  ])('goes off with %s, sending no engage frame', (_label, end) => {
    const rig = healer();
    mend(rig, 'bren');
    end(rig);
    rig.session.runTick(0);
    expect(rig.session.engaged).toBe(false);
    expect(engages(rig)).toEqual([{ on: true }]);
  });

  describe('a raise the Healer gives', () => {
    const raising = (state: RaisingState, healerIds = ['self']) => raisingFrame('bren', healerIds, state);

    it('reports it done and broken, and says nothing of taking hold', () => {
      const rig = healer();
      mend(rig, 'bren');
      rig.controller.dispatch(raising('holding'));
      expect(rig.controller.chatHistory).toEqual([]);
      rig.controller.dispatch(raising('broken'));
      rig.controller.dispatch(raising('holding'));
      rig.controller.dispatch(raising('done'));
      expect(rig.controller.chatHistory).toEqual([
        { kind: 'raiseBrokenOther', targetName: 'Bren' },
        { kind: 'raisedOther', targetName: 'Bren' },
      ]);
    });

    it('reports losing hold when a snapshot leaves the Healer out while another holds on, and nothing of the other joining', () => {
      const rig = healer();
      mend(rig, 'bren');
      rig.controller.dispatch(raising('holding'));
      rig.controller.dispatch(raising('holding', ['self', 'cara']));
      expect(rig.controller.chatHistory).toEqual([]);
      rig.controller.dispatch(raising('holding', ['cara']));
      expect(rig.controller.chatHistory).toEqual([{ kind: 'raiseBrokenOther', targetName: 'Bren' }]);
    });

    it('reports losing hold once, and nothing when another Healer then begins anew', () => {
      const rig = healer();
      mend(rig, 'bren');
      rig.controller.dispatch(raising('holding'));
      rig.controller.dispatch(raising('broken'));
      rig.controller.dispatch(raising('holding', ['cara']));
      expect(rig.controller.chatHistory).toEqual([{ kind: 'raiseBrokenOther', targetName: 'Bren' }]);
    });

    it.each<[string, (rig: Rig) => void]>([
      ['switches Mend off', (rig) => rig.session.toggleEngage()],
      ['targets another dreamer', (rig) => rig.session.selectEntity('cara')],
      ['puts the Moonstone away', (rig) => rig.controller.dispatch(MOONSTONE_PUT_AWAY)],
      ['falls', (rig) => rig.controller.dispatch({ tag: 'condition', payload: { entityId: 'self', condition: 'fallen' } })],
    ])('says nothing of losing hold when the Healer first %s', (_label, letGo) => {
      for (const end of [raising('broken', ['self', 'cara']), raising('holding', ['cara'])]) {
        const rig = healer();
        mend(rig, 'bren');
        rig.controller.dispatch(raising('holding', ['self', 'cara']));
        letGo(rig);
        rig.controller.dispatch(end);
        expect(rig.controller.chatHistory.filter((line) => line.kind !== 'fell')).toEqual([]);
      }
    });

    it('tells every Healer named at the end that it is done, and no one who dropped out before it', () => {
      const named = healer();
      named.controller.dispatch(raising('done', ['cara', 'self']));
      expect(named.controller.chatHistory).toEqual([{ kind: 'raisedOther', targetName: 'Bren' }]);

      const dropped = healer();
      mend(dropped, 'bren');
      dropped.controller.dispatch(raising('holding', ['self', 'cara']));
      dropped.session.toggleEngage();
      dropped.controller.dispatch(raising('holding', ['cara']));
      dropped.controller.dispatch(raising('done', ['cara']));
      expect(dropped.controller.chatHistory).toEqual([]);
    });

    /** The dreamer took their raise along when they left, with no frame to say so. */
    it('says nothing of losing hold of a dreamer who left and came back to another Healer', () => {
      const rig = healer();
      mend(rig, 'bren');
      rig.controller.dispatch(raising('holding'));
      rig.controller.dispatch({ tag: 'leave', payload: { entityId: 'bren', leftGame: true } });
      rig.controller.dispatch(entityFrame({ id: 'bren', kind: 'player', name: 'Bren', x: 11, z: 10, condition: 'fallen' }));
      rig.controller.dispatch(raising('holding', ['cara']));
      expect([rig.session.target, rig.session.engaged]).toEqual([undefined, false]);
      expect(rig.controller.chatHistory.filter((line) => line.kind !== 'left' && line.kind !== 'joined')).toEqual([]);
    });
  });
});

describe('abilities', () => {
  const GHOST = 'monster:1';
  const uses = (rig: Rig) => rig.sent.flatMap((message) => (message.tag === 'useAbility' ? [message.payload.abilityId] : []));

  /** A Fighter at (10, 10) with Brace and Lunge learned and full pools, a nightmare a leap away to the north, and Bren beside them. */
  function fighter(): Rig {
    const rig = makeRig();
    rig.controller.dispatch(enterSpaceFrame());
    rig.controller.dispatch(sectorFrame(outdoorSector('Meadow', { x: 0, z: 0 })));
    rig.controller.dispatch(entityFrame());
    rig.controller.dispatch(entityFrame({ id: GHOST, kind: 'monster', name: 'Ghost', x: 10, z: 7 }));
    rig.controller.dispatch(entityFrame({ id: 'bren', kind: 'player', name: 'Bren', x: 11, z: 10 }));
    rig.controller.dispatch({ tag: 'energy', payload: FULL });
    rig.controller.dispatch(FIGHTER_KIT);
    return rig;
  }

  it('fills the belt with the abilities the ranks teach, in teaching order', () => {
    const rig = fighter();
    expect(rig.session.abilities).toEqual(['brace', 'lunge']);
    expect(rig.session.abilitySlots()).toEqual([
      { abilityId: 'brace', rank: 1, refusal: undefined, cooldown: undefined },
      { abilityId: 'lunge', rank: 2, refusal: 'recipient', cooldown: undefined },
    ]);
    rig.session.select(GHOST);
    expect(rig.session.abilitySlots()[1]).toEqual({ abilityId: 'lunge', rank: 2, refusal: undefined, cooldown: undefined });
  });

  it.each<[string, (rig: Rig) => void]>([
    ['the ability is not learned', (rig) => rig.controller.dispatch({ tag: 'lucidity', payload: { role: 'fighter', ranks: [] } })],
    ['the Balance is short of its cost', (rig) => rig.controller.dispatch({ tag: 'energy', payload: { ...FULL, balanceCurrent: 11 } })],
    ['the player lies fallen', (rig) => rig.controller.dispatch({ tag: 'condition', payload: { entityId: 'self', condition: 'fallen' } })],
    ['the target stands out of reach', (rig) => rig.controller.dispatch(entityFrame({ id: GHOST, kind: 'monster', name: 'Ghost', x: 10, z: 2 }))],
    [
      'its own cooldown runs',
      (rig) => rig.controller.dispatch({ tag: 'cooldowns', payload: { globalSeconds: 0, cooldowns: [{ abilityId: 'lunge', seconds: 2 }] } }),
    ],
    ['the global cooldown runs', (rig) => rig.controller.dispatch({ tag: 'cooldowns', payload: { globalSeconds: 0.5, cooldowns: [] } })],
  ])('neither asks for Lunge nor leaps while %s', (_label, arrange) => {
    const rig = fighter();
    rig.session.select(GHOST);
    arrange(rig);
    rig.session.useAbility('lunge');
    expect(uses(rig)).toEqual([]);
    expect(rig.session.predictor.walk).toBeUndefined();
  });

  it('keeps the walk under way going through an instant use, which holds nothing still', () => {
    const rig = fighter();
    tapGround(rig, { x: 10, z: 14 });
    const at = (): number => rig.controller.entities.get('self')!.position.z;
    for (let ms = 0; ms <= 300; ms += 25) rig.session.runTick(ms);
    rig.session.useAbility('brace');
    expect(uses(rig)).toEqual(['brace']);
    const before = at();

    for (let ms = 325; ms <= 600; ms += 25) rig.session.runTick(ms);

    expect(at()).toBeGreaterThan(before + 0.4);
    expect(rig.session.predictor.walk).toMatchObject({ kind: 'path', destination: { x: 10, z: 14 } });
  });

  it('keeps the cooldowns the server sends on its own clock, each begun as long before its end as it runs at the rank held, and asks again once they end', () => {
    const rig = fighter();
    rig.session.select(GHOST);
    rig.now = 1000;
    // Lunge runs 8 s at rank 2, so 6 s left of it began 2 s ago.
    rig.controller.dispatch({ tag: 'cooldowns', payload: { globalSeconds: 0.5, cooldowns: [{ abilityId: 'lunge', seconds: 6 }] } });
    expect(rig.session.abilitySlots()).toEqual([
      { abilityId: 'brace', rank: 1, refusal: undefined, cooldown: { startedAtMs: 750, endsAtMs: 1500, global: true } },
      { abilityId: 'lunge', rank: 2, refusal: undefined, cooldown: { startedAtMs: -1000, endsAtMs: 7000, global: false } },
    ]);
    rig.now = 1500;
    rig.session.useAbility('brace');
    rig.now = 6999;
    rig.session.useAbility('lunge');
    expect(uses(rig)).toEqual(['brace']);
    rig.now = 7000;
    expect(rig.session.abilitySlots()[1]!.cooldown).toBeUndefined();
    rig.session.useAbility('lunge');
    expect(uses(rig)).toEqual(['brace', 'lunge']);
  });

  it('runs its state hook as an ability comes in reach or leaves its cooldown, and not on a tick that changes neither', () => {
    const rig = fighter();
    let changes = 0;
    rig.session.onStateChanged = () => (changes += 1);
    rig.session.select(GHOST);
    rig.session.runTick(0);
    changes = 0;
    rig.session.runTick(50);
    rig.session.runTick(100);
    expect(changes).toBe(0);
    rig.controller.dispatch(entityFrame({ id: GHOST, kind: 'monster', name: 'Ghost', x: 10, z: 2 }));
    rig.session.runTick(150);
    expect(changes).toBe(1);
    rig.controller.dispatch({ tag: 'cooldowns', payload: { globalSeconds: 0, cooldowns: [{ abilityId: 'brace', seconds: 1 }] } });
    rig.session.runTick(200);
    changes = 0;
    rig.now = 1000;
    rig.session.runTick(250);
    expect(changes).toBe(1);
  });

  it('uses an ability once for two presses inside the round trip, sweeping the global cooldown from the first, until the answer comes', () => {
    const rig = fighter();
    rig.session.select(GHOST);
    rig.now = 1000;
    rig.session.useAbility('lunge');
    rig.now = 1100;
    rig.session.useAbility('lunge');
    rig.session.useAbility('brace');
    expect(uses(rig)).toEqual(['lunge']);
    expect(rig.session.abilitySlots()[0]!.cooldown).toEqual({ startedAtMs: 1000, endsAtMs: 1750, global: true });

    rig.controller.dispatch({ tag: 'cooldowns', payload: { globalSeconds: 0, cooldowns: [{ abilityId: 'lunge', seconds: 7.9 }] } });
    rig.session.useAbility('brace');
    expect(uses(rig)).toEqual(['lunge', 'brace']);
  });

  it('frees the belt once a use the server refused goes unanswered for a while', () => {
    const rig = fighter();
    rig.now = 1000;
    rig.session.useAbility('brace');
    // Past the global cooldown, still awaiting the answer.
    rig.now = 1900;
    rig.session.useAbility('brace');
    expect(uses(rig)).toEqual(['brace']);
    rig.now = 2000;
    rig.session.useAbility('brace');
    expect(uses(rig)).toEqual(['brace', 'brace']);
  });

  it('never leaps for a Lunge the server refuses, which no ability frame answers', () => {
    const rig = fighter();
    rig.session.select(GHOST);
    rig.now = 1000;
    rig.session.useAbility('lunge');
    for (let ms = 1000; ms <= 3000; ms += 50) {
      rig.now = ms;
      rig.session.runTick(ms);
    }
    expect(uses(rig)).toEqual(['lunge']);
    expect(rig.session.predictor.walk).toBeUndefined();
    expect(rig.controller.entities.get('self')!.position).toEqual({ x: 10, z: 10 });
  });

  it('starts a new space with no cooldowns until the snapshot its join sends', () => {
    const rig = fighter();
    rig.controller.dispatch({ tag: 'cooldowns', payload: { globalSeconds: 0.5, cooldowns: [{ abilityId: 'brace', seconds: 9 }] } });
    rig.controller.dispatch(enterSpaceFrame());
    rig.controller.dispatch(entityFrame());
    expect(rig.session.abilitySlots().map(({ cooldown }) => cooldown)).toEqual([undefined, undefined]);
    rig.controller.dispatch({ tag: 'cooldowns', payload: { globalSeconds: 0, cooldowns: [{ abilityId: 'brace', seconds: 4 }] } });
    expect(rig.session.abilitySlots()[0]!.cooldown).toEqual({ startedAtMs: -11000, endsAtMs: 4000, global: false });
  });

  it('plays an ability on whoever used it, saying when its nightmare evaded it, and ignores one this client does not know', () => {
    const rig = fighter();
    rig.controller.dispatch({ tag: 'ability', payload: { entityId: 'bren', abilityId: 'rally' } });
    rig.controller.dispatch({ tag: 'ability', payload: { entityId: 'bren', abilityId: 'dream-bolt', targetId: GHOST, evaded: true } });
    rig.controller.dispatch({ tag: 'ability', payload: { entityId: 'bren', abilityId: 'nightmare-song', targetId: GHOST } });
    expect(rig.shown).toEqual([
      ['showAbility', 'bren', 'rally', undefined, undefined],
      ['showAbility', 'bren', 'dream-bolt', GHOST, { evaded: true }],
    ]);
  });
});

describe('a channel', () => {
  /** A Healer who has learned Deep mend and Renewal, the Moonstone in hand, at (10, 10), with Bren beside them. */
  const HEALER_KIT: SomnioMessage = {
    tag: 'lucidity',
    payload: {
      role: 'healer',
      ranks: [
        { teachingId: 'touch', rank: 2, practice: 0 },
        { teachingId: 'deep-mend', rank: 1, practice: 0 },
        { teachingId: 'renewal', rank: 1, practice: 0 },
      ],
    },
  };
  const uses = (rig: Rig) => rig.sent.flatMap((message) => (message.tag === 'useAbility' ? [message.payload.abilityId] : []));

  function healer(): Rig {
    const rig = makeRig();
    rig.controller.dispatch(enterSpaceFrame());
    rig.controller.dispatch(sectorFrame(outdoorSector('Meadow', { x: 0, z: 0 })));
    rig.controller.dispatch(entityFrame());
    rig.controller.dispatch(entityFrame({ id: 'bren', kind: 'player', name: 'Bren', x: 12, z: 10 }));
    rig.controller.dispatch({ tag: 'energy', payload: FULL });
    rig.controller.dispatch(MOONSTONE_IN_HAND);
    rig.controller.dispatch(HEALER_KIT);
    return rig;
  }

  /** Ticks every 25 ms from `fromMs` to `toMs`, the session's clock with them. */
  const ticks = (rig: Rig, fromMs: number, toMs: number): void => {
    for (let ms = fromMs; ms <= toMs; ms += 25) {
      rig.now = ms;
      rig.session.runTick(ms);
    }
  };
  const at = (rig: Rig): { x: number; z: number } => ({ ...rig.controller.entities.get('self')!.position });
  /** The positions of the moves sent from the `from`th message on. */
  const movesFrom = (rig: Rig, from: number) =>
    rig.sent.slice(from).flatMap((message) => (message.tag === 'move' ? [{ x: message.payload.x, z: message.payload.z }] : []));
  /** The server's answer to a Deep mend it takes: the channel's start, then the cooldowns. */
  const channelStarts = (rig: Rig): void => {
    rig.controller.dispatch({ tag: 'ability', payload: { entityId: 'self', abilityId: 'deep-mend', phase: 'start', seconds: 1.5 } });
    rig.controller.dispatch({ tag: 'cooldowns', payload: { globalSeconds: 1.5, cooldowns: [{ abilityId: 'deep-mend', seconds: 6 }] } });
  };
  const channelEnds = (rig: Rig, phase: 'done' | 'broken'): void => {
    rig.controller.dispatch({ tag: 'ability', payload: { entityId: 'self', abilityId: 'deep-mend', phase } });
  };
  const near = (a: { x: number; z: number }, b: { x: number; z: number }): boolean => Math.hypot(a.x - b.x, a.z - b.z) <= PATH_FOLLOWING.arrivalMetres;

  it.each(['done', 'broken'] as const)(
    'holds a held steer still through the channel, after the report the heartbeat held back, and steers on toward the pointer once it is %s',
    (phase) => {
      const rig = healer();
      rig.session.pressGround({ x: 10, z: 14 }, 0);
      ticks(rig, 0, 300);
      expect(rig.session.predictor.walk?.kind).toBe('steer');
      rig.session.runTick(325);

      rig.session.useAbility('deep-mend');
      expect(rig.sent.slice(-2)).toEqual([
        { tag: 'move', payload: expect.objectContaining(rig.controller.entities.get('self')!.position) },
        { tag: 'useAbility', payload: { abilityId: 'deep-mend' } },
      ]);
      const still = at(rig);
      const sent = rig.sent.length;
      channelStarts(rig);
      rig.session.moveHold({ x: 12, z: 14 });
      ticks(rig, 350, 1800);

      expect(at(rig)).toEqual(still);
      expect(movesFrom(rig, sent)).toEqual([]);
      expect(rig.session.predictor.walk).toEqual({ kind: 'steer', toward: { x: 12, z: 14 } });

      channelEnds(rig, phase);
      ticks(rig, 1825, 2200);
      expect(at(rig).x).toBeGreaterThan(still.x);
      expect(at(rig).z).toBeGreaterThan(still.z);
    },
  );

  it('walks on to where a press let go during the channel once it lands', () => {
    const rig = healer();
    rig.session.pressGround({ x: 10, z: 14 }, 0);
    ticks(rig, 0, 300);
    rig.session.useAbility('deep-mend');
    channelStarts(rig);
    const still = at(rig);
    const sent = rig.sent.length;

    rig.session.release({ x: 11, z: 13 });
    ticks(rig, 325, 1800);
    expect(at(rig)).toEqual(still);
    expect(movesFrom(rig, sent)).toEqual([]);
    expect(rig.session.predictor.walk).toMatchObject({ kind: 'path', destination: { x: 11, z: 13 } });

    channelEnds(rig, 'done');
    ticks(rig, 1825, 5000);
    expect(near(at(rig), { x: 11, z: 13 })).toBe(true);
  });

  it('walks on along a tapped path once the channel breaks', () => {
    const rig = healer();
    tapGround(rig, { x: 10, z: 14 });
    ticks(rig, 0, 300);
    expect(at(rig).z).toBeGreaterThan(10);
    rig.session.useAbility('deep-mend');
    channelStarts(rig);
    const still = at(rig);
    const sent = rig.sent.length;

    ticks(rig, 325, 1800);
    expect(movesFrom(rig, sent)).toEqual([]);
    channelEnds(rig, 'broken');
    ticks(rig, 1825, 5000);
    expect(at(rig)).not.toEqual(still);
    expect(near(at(rig), { x: 10, z: 14 })).toBe(true);
  });

  it('ends the waiting walk on a new press, whose walk moves the player at once and so breaks the channel', () => {
    const rig = healer();
    tapGround(rig, { x: 10, z: 14 });
    ticks(rig, 0, 300);
    rig.session.useAbility('deep-mend');
    channelStarts(rig);
    ticks(rig, 325, 500);
    const sent = rig.sent.length;

    rig.session.pressGround({ x: 8, z: 12 }, 525);
    expect(rig.session.predictor.walk).toBeUndefined();
    rig.session.release({ x: 8, z: 12 });
    ticks(rig, 525, 700);

    expect(rig.session.channelOf('self')).toBeDefined();
    expect(movesFrom(rig, sent).length).toBeGreaterThan(0);
    expect(rig.session.predictor.walk).toMatchObject({ kind: 'path', destination: { x: 8, z: 12 } });
  });

  it('ends the waiting walk on a press on a drop, walking the player to it and picking it up while the channel is under way', () => {
    const rig = healer();
    rig.controller.dispatch({ tag: 'loot', payload: { lootId: 'loot-1', x: 8, z: 12, contents: { kind: 'item', baseId: 'dagger', rarity: 'magic' } } });
    tapGround(rig, { x: 10, z: 14 });
    ticks(rig, 0, 300);
    rig.session.useAbility('deep-mend');
    channelStarts(rig);
    ticks(rig, 325, 500);
    const sent = rig.sent.length;

    rig.session.pressLoot('loot-1');
    ticks(rig, 525, 700);
    expect(rig.session.channelOf('self')).toBeDefined();
    expect(movesFrom(rig, sent).length).toBeGreaterThan(0);
    expect(rig.session.predictor.walk).toMatchObject({ kind: 'path', destination: { x: 8, z: 12 } });

    ticks(rig, 725, 3000);
    expect(rig.sent.filter((message) => message.tag === 'pickUp')).toEqual([{ tag: 'pickUp', payload: { lootId: 'loot-1' } }]);
  });

  it('walks on once a use the server never answers has waited as long as any use does', () => {
    const rig = healer();
    tapGround(rig, { x: 10, z: 14 });
    ticks(rig, 0, 300);
    rig.session.useAbility('deep-mend');
    const sent = rig.sent.length;

    ticks(rig, 325, 1275);
    expect(movesFrom(rig, sent)).toEqual([]);
    ticks(rig, 1300, 1400);
    expect(movesFrom(rig, sent).length).toBeGreaterThan(0);
  });

  it("keeps each user's channel from its start, or from its seconds left, until it lands or breaks", () => {
    const rig = healer();
    rig.now = 1000;
    rig.controller.dispatch({ tag: 'ability', payload: { entityId: 'bren', abilityId: 'deep-mend', targetId: 'self', phase: 'start', seconds: 1.5 } });
    expect(rig.session.channelOf('bren')).toEqual({ abilityId: 'deep-mend', startedAtMs: 1000, endsAtMs: 2500 });
    rig.now = 1500;
    rig.controller.dispatch({ tag: 'ability', payload: { entityId: 'bren', abilityId: 'deep-mend', targetId: 'self', phase: 'channel', seconds: 1 } });
    expect(rig.session.channelOf('bren')).toEqual({ abilityId: 'deep-mend', startedAtMs: 1000, endsAtMs: 2500 });
    rig.controller.dispatch({ tag: 'ability', payload: { entityId: 'bren', abilityId: 'deep-mend', targetId: 'self', phase: 'done' } });
    expect(rig.session.channelOf('bren')).toBeUndefined();

    // One learned of only under way counts from then.
    rig.controller.dispatch({ tag: 'ability', payload: { entityId: 'bren', abilityId: 'deep-mend', phase: 'channel', seconds: 0.5 } });
    expect(rig.session.channelOf('bren')).toEqual({ abilityId: 'deep-mend', startedAtMs: 1500, endsAtMs: 2000 });
    rig.controller.dispatch({ tag: 'ability', payload: { entityId: 'bren', abilityId: 'deep-mend', phase: 'broken' } });
    expect(rig.session.channelOf('bren')).toBeUndefined();
    expect(rig.shown.filter(([name]) => name === 'showAbility')).toEqual([
      ['showAbility', 'bren', 'deep-mend', 'self', { phase: 'start', seconds: 1.5 }],
      ['showAbility', 'bren', 'deep-mend', 'self', { phase: 'channel', seconds: 1 }],
      ['showAbility', 'bren', 'deep-mend', 'self', { phase: 'done' }],
      ['showAbility', 'bren', 'deep-mend', undefined, { phase: 'channel', seconds: 0.5 }],
      ['showAbility', 'bren', 'deep-mend', undefined, { phase: 'broken' }],
    ]);
  });

  it('forgets a channel whose user leaves, and every channel with the space', () => {
    const rig = healer();
    rig.controller.dispatch({ tag: 'ability', payload: { entityId: 'bren', abilityId: 'deep-mend', phase: 'start', seconds: 1.5 } });
    rig.controller.dispatch({ tag: 'leave', payload: { entityId: 'bren', leftGame: false } });
    expect(rig.session.channelOf('bren')).toBeUndefined();
    rig.controller.dispatch({ tag: 'ability', payload: { entityId: 'self', abilityId: 'deep-mend', phase: 'start', seconds: 1.5 } });
    rig.controller.dispatch(enterSpaceFrame());
    expect(rig.session.channelOf('self')).toBeUndefined();
  });

  it('asks for no ability while a channel of the player runs, and greys every slot out', () => {
    const rig = healer();
    rig.controller.dispatch({ tag: 'ability', payload: { entityId: 'self', abilityId: 'deep-mend', phase: 'start', seconds: 1.5 } });
    expect(rig.session.abilitySlots().map(({ refusal }) => refusal)).toEqual(['channelling', 'channelling']);
    rig.session.useAbility('renewal');
    expect(uses(rig)).toEqual([]);
    rig.controller.dispatch({ tag: 'ability', payload: { entityId: 'self', abilityId: 'deep-mend', phase: 'done' } });
    rig.session.useAbility('renewal');
    expect(uses(rig)).toEqual(['renewal']);
  });
});

describe('effects', () => {
  const GHOST = 'monster:1';

  function holding(): Rig {
    const rig = makeRig();
    rig.controller.dispatch(enterSpaceFrame());
    rig.controller.dispatch(sectorFrame(outdoorSector('Meadow', { x: 0, z: 0 })));
    rig.controller.dispatch(entityFrame());
    rig.controller.dispatch(entityFrame({ id: GHOST, kind: 'monster', name: 'Ghost', x: 14, z: 10 }));
    rig.controller.dispatch(entityFrame({ id: 'bren', kind: 'player', name: 'Bren', x: 11, z: 10 }));
    return rig;
  }

  it("keeps the player's and the target's, each ending on the session's clock or lasting while its holder does, and drops the target's with it", () => {
    const rig = holding();
    rig.now = 1000;
    rig.controller.dispatch({ tag: 'effects', payload: { entityId: 'self', effects: [{ effectId: 'braced', seconds: 4 }, { effectId: 'unknown' }] } });
    rig.controller.dispatch({ tag: 'effects', payload: { entityId: GHOST, effects: [{ effectId: 'challenged', seconds: 6 }] } });
    expect(rig.session.effectsOf('self')).toEqual([{ effectId: 'braced', endsAtMs: 5000 }]);
    // Only a target's effects are kept.
    expect(rig.session.effectsOf(GHOST)).toEqual([]);
    // The scene draws the ones kept, with the seconds the frame gave.
    expect(rig.shown).toEqual([['showEffects', 'self', [{ effectId: 'braced', seconds: 4 }]]]);

    rig.session.select(GHOST);
    rig.controller.dispatch({ tag: 'effects', payload: { entityId: GHOST, effects: [{ effectId: 'challenged' }] } });
    expect(rig.session.effectsOf(GHOST)).toEqual([{ effectId: 'challenged' }]);
    rig.session.select('bren');
    expect(rig.session.effectsOf(GHOST)).toEqual([]);
    // The player's own outlast a target of their own.
    rig.session.pressOwnFrame();
    rig.session.select(undefined);
    expect(rig.session.effectsOf('self')).toEqual([{ effectId: 'braced', endsAtMs: 5000 }]);

    rig.controller.dispatch(enterSpaceFrame());
    expect(rig.session.effectsOf('self')).toEqual([]);
  });
});

describe('compassPoint', () => {
  /** `x` runs east and `z` south, so a voice at positive `z` lies to the south. */
  it.each([
    [{ x: 0, z: 5 }, 'south'],
    [{ x: 5, z: 5 }, 'south-east'],
    [{ x: 5, z: 0 }, 'east'],
    [{ x: 5, z: -5 }, 'north-east'],
    [{ x: 0, z: -5 }, 'north'],
    [{ x: -5, z: -5 }, 'north-west'],
    [{ x: -5, z: 0 }, 'west'],
    [{ x: -5, z: 5 }, 'south-west'],
    [{ x: -1, z: 5 }, 'south'],
  ] as const)('names a voice at %j the %s', (to, direction) => {
    expect(compassPoint({ x: 0, z: 0 }, to)).toBe(direction);
  });

  it('names no direction for a voice on the spot', () => {
    expect(compassPoint({ x: 0, z: 0 }, { x: 0.05, z: 0 })).toBeUndefined();
  });
});
