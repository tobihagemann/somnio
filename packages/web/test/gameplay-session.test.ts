import { describe, expect, it } from 'vitest';
import {
  ConnectionController,
  GameplaySession,
  HOLD_TO_STEER_MS,
  PATH_FOLLOWING,
  REMOTE_INTERPOLATION_SECONDS,
  compassPoint,
  noopRenderSurface,
} from '@/client';
import type { ClientEntity, SpeechBubbleRequest } from '@/client';
import { GameplayTransport } from '@/transport';
import { fakeSocketFactory } from './helpers/fakeSocket';
import { TEST_REGISTRY, interiorSector, outdoorSector } from '../../core/test/support/worldFixture.ts';
import { clientEntity, enterSpaceFrame, entityFrame, makeDoor, sectorFrame } from './helpers/worldFixture';
import { fullPools, headingFromVector } from '@somnio/core';
import type { RaisingState, SomnioMessage } from '@somnio/protocol';

/**
 * The gameplay half of the client.
 *
 * The self/remote split of the position frames and the door latch are the places a slip stays
 * invisible until a player notices rubber-banding or lands in the wrong space, which is why they
 * are pinned here.
 */

const FULL = fullPools([]);
const MOONSTONE_IN_HAND = { slot: 2, itemId: 'moonstone', quantity: 1, equippedHand: 'right' as const };
const MOONSTONE_PUT_AWAY = { slot: 2, itemId: 'moonstone', quantity: 1 };

interface Rig {
  session: GameplaySession;
  controller: ConnectionController;
  sent: SomnioMessage[];
  /** Every `updatePosition` call. */
  positions: { id: string; x: number; z: number }[];
  gaits: { id: string; gait: string }[];
  /** Every `showSelection` call's entity. */
  selections: (string | undefined)[];
  /** Every `showSelection` call's `locked`, in step with `selections`. */
  selectionLocks: boolean[];
  /** Every `showBlow`, `showRaising`, `showMend`, and `updateCondition` call, by name. */
  shown: unknown[][];
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
  const selectionLocks: Rig['selectionLocks'] = [];
  const shown: Rig['shown'] = [];
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
      showSelection: (id, locked) => {
        selections.push(id);
        selectionLocks.push(locked);
      },
      showBlow: (...blow) => shown.push(['showBlow', ...blow]),
      showRaising: (...raising) => shown.push(['showRaising', ...raising]),
      showMend: (...mend) => shown.push(['showMend', ...mend]),
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
    selectionLocks,
    shown,
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
    ['a press on their own body', (rig) => rig.session.pressSelf()],
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
    rig.session.pressEntity('monster:1');
    rig.session.release({ x: 10, z: 6 });
    expect(rig.pressMarks).toEqual([['show', { x: 14, z: 10 }], ['lift']]);
  });

  it('stops where the player stands on a press on their own body', () => {
    const { rig, ticks, at } = standing();
    tapGround(rig, { x: 14, z: 10 });
    ticks(0, 300);
    const stopped = at();

    rig.session.pressSelf();
    ticks(350, 1000);

    expect(rig.session.predictor.walk).toBeUndefined();
    expect(at()).toEqual(stopped);
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

  it('faces its target on a coarse pointer while it walks another way', () => {
    const { rig, ticks } = standing({ coarsePointer: true });
    rig.controller.dispatch(entityFrame({ id: 'monster:1', kind: 'monster', x: 10, z: 6 }));
    rig.session.pressEntity('monster:1');
    tapGround(rig, { x: 14, z: 10 });

    ticks(0, 200);

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

  /** Joins the meadow, walks south into the door's trigger, and stops there waiting for the server. */
  function waitAtDoor(): { rig: Rig; tick: () => void; framesAfter: (count: number) => SomnioMessage[] } {
    const rig = makeRig();
    let time = 0;
    const tick = (): void => {
      rig.session.runTick(time);
      time += 100;
    };
    rig.controller.dispatch(enterSpaceFrame());
    rig.controller.dispatch(sectorFrame(meadow));
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
    ticks(12);
    expect(doorsAsked()).toBe(1);

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

describe('inventory activation', () => {
  it('reports the purse balance to chat instead of equipping it', () => {
    const rig = makeRig();
    rig.controller.connectionState = 'attached';

    rig.session.activateInventoryRow({ slot: 0, itemId: 'purse', quantity: 7 });

    expect(rig.sent).toEqual([]);
    expect(rig.controller.chatHistory.at(-1)).toEqual({ kind: 'purseBalance', coins: 7 });
  });

  /** Unequipped asks for the right hand; already-equipped leaves the hand out to clear it. */
  it.each(
    ['dagger', 'cudgel', 'sword', 'mace'].flatMap((itemId) => [
      [itemId, {}, { slot: 4, hand: 'right' }],
      [itemId, { equippedHand: 'right' }, { slot: 4 }],
    ]) as [string, { equippedHand?: 'right' }, { slot: number; hand?: 'right' }][],
  )('toggles the %s from %j with %j', (itemId, equipped, expected) => {
    const rig = makeRig();
    rig.controller.connectionState = 'attached';

    rig.session.activateInventoryRow({ slot: 4, itemId, quantity: 1, ...equipped });

    expect(rig.sent).toEqual([{ tag: 'equipToggle', payload: expected }]);
  });

  it('does nothing for an item it does not know', () => {
    const rig = makeRig();
    rig.controller.connectionState = 'attached';

    rig.session.activateInventoryRow({ slot: 1, itemId: 'lantern', quantity: 1 });

    expect(rig.sent).toEqual([]);
    expect(rig.controller.chatHistory).toEqual([]);
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

  it('stores the inventory rows and asks for a repaint', () => {
    const rig = makeRig();
    let repaints = 0;
    rig.session.onStateChanged = () => {
      repaints += 1;
    };
    const rows = [
      { slot: 0, itemId: 'purse', quantity: 100 },
      { slot: 1, itemId: 'cudgel', quantity: 1, equippedHand: 'right' as const },
    ];

    rig.controller.dispatch({ tag: 'inventory', payload: { rows } });

    expect(rig.session.inventory).toEqual(rows);
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

describe('the Moonstone', () => {
  it.each([
    ['takes it in hand when it is put away', {}, { tag: 'equipToggle', payload: { slot: 2, hand: 'right' } }],
    ['uses it once it is in hand', { equippedHand: 'right' }, { tag: 'useItem', payload: { slot: 2 } }],
  ] as const)('%s', (_label, equipped, expected) => {
    const rig = makeRig();
    rig.controller.connectionState = 'attached';

    rig.session.activateInventoryRow({ slot: 2, itemId: 'moonstone', quantity: 1, ...equipped });

    expect(rig.sent).toEqual([expected]);
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

  it('counts a raise given to the player down by whole seconds, and reports it breaking and being drawn back', () => {
    const rig = makeRig();
    rig.controller.dispatch(enterSpaceFrame());
    rig.controller.dispatch(entityFrame({ condition: 'fallen' }));
    rig.controller.dispatch(entityFrame({ id: 'healer', name: 'Lumi' }));
    rig.now = 1000;
    rig.controller.dispatch(raisingFrame('self', ['healer'], 'holding'));
    expect(rig.session.raise).toEqual({ healerNames: ['Lumi'], secondsLeft: 6 });
    rig.session.runTick(3500);
    expect(rig.session.raise).toEqual({ healerNames: ['Lumi'], secondsLeft: 4 });

    rig.controller.dispatch(raisingFrame('self', ['healer'], 'broken'));
    expect(rig.session.raise).toBeUndefined();
    expect(rig.controller.chatHistory).toEqual([{ kind: 'raiseBroken', healerNames: ['Lumi'] }]);

    rig.controller.dispatch(raisingFrame('self', ['healer'], 'holding'));
    rig.controller.dispatch(raisingFrame('self', ['healer'], 'done', 1));
    expect(rig.session.raise).toBeUndefined();
    expect(rig.controller.chatHistory.at(-1)).toEqual({ kind: 'raised', healerNames: ['Lumi'] });
  });

  it('names every Healer holding on to the raise given to the player, and counts down at once at their pace', () => {
    const rig = makeRig();
    rig.controller.dispatch(enterSpaceFrame());
    rig.controller.dispatch(entityFrame({ condition: 'fallen' }));
    rig.controller.dispatch(entityFrame({ id: 'healer', name: 'Lumi' }));
    rig.controller.dispatch(entityFrame({ id: 'other', name: 'Bren' }));
    rig.controller.dispatch(raisingFrame('self', ['healer'], 'holding'));
    rig.controller.dispatch(raisingFrame('self', ['healer', 'other'], 'holding', 0, 3));
    expect(rig.session.raise).toEqual({ healerNames: ['Lumi', 'Bren'], secondsLeft: 3 });
    rig.session.runTick(1600);
    expect(rig.session.raise).toEqual({ healerNames: ['Lumi', 'Bren'], secondsLeft: 2 });

    rig.controller.dispatch(raisingFrame('self', ['healer', 'other'], 'done', 1));
    expect(rig.controller.chatHistory).toEqual([{ kind: 'raised', healerNames: ['Lumi', 'Bren'] }]);
  });

  /** The tick's timestamp is when the frame began, which can be a little before the snapshot arrived. */
  it('never counts the raise given to the player up on a frame that began before its snapshot arrived', () => {
    const rig = makeRig();
    rig.controller.dispatch(enterSpaceFrame());
    rig.controller.dispatch(entityFrame({ condition: 'fallen' }));
    rig.controller.dispatch(entityFrame({ id: 'healer', name: 'Lumi' }));
    rig.now = 1000;
    rig.controller.dispatch(raisingFrame('self', ['healer'], 'holding', 0, 3));
    rig.session.runTick(999);
    expect(rig.session.raise).toEqual({ healerNames: ['Lumi'], secondsLeft: 3 });
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

  it('leaves a raise given to someone else to the scene', () => {
    const rig = makeRig();
    rig.controller.dispatch(enterSpaceFrame());
    rig.controller.dispatch(entityFrame());
    rig.controller.dispatch(raisingFrame('peer', ['healer'], 'holding'));
    expect(rig.session.raise).toBeUndefined();
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
    rig.controller.dispatch(raisingFrame('peer', ['self'], 'broken'));
    rig.controller.dispatch({ tag: 'mend', payload: { targetId: 'peer' } });

    expect(rig.shown).toEqual([
      ['showBlow', 'monster:1', 'peer', true],
      ['showBlow', 'peer', 'monster:1', false],
      ['updateCondition', 'peer', 'fallen'],
      ['showRaising', 'peer', { progress: 0.25, seconds: 4.5 }],
      ['showRaising', 'peer', undefined],
      ['showMend', 'peer'],
    ]);
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
  const purse = (quantity: number) => ({ tag: 'inventory' as const, payload: { rows: [{ slot: 0, itemId: 'purse', quantity }] } });
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
        task: { role: 'fighter', teachingId: 'follow-through', progress: 3 },
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

  it('reports a new role, a new rank, and a task reaching its goal', () => {
    const rig = makeRig();
    rig.controller.dispatch(enterSpaceFrame());
    const trial = (progress: number) => ({ role: 'fighter' as const, progress });
    rig.controller.dispatch({ tag: 'lucidity', payload: { ranks: [], task: trial(0) } });

    rig.controller.dispatch({ tag: 'lucidity', payload: { ranks: [], task: trial(1) } });
    expect(rig.controller.chatHistory).toEqual([{ kind: 'taskDone' }]);

    rig.controller.dispatch({ tag: 'lucidity', payload: { role: 'fighter', ranks: [strike(1)], study: 'strike' } });
    expect(rig.controller.chatHistory.slice(1)).toEqual([
      { kind: 'becameRole', role: 'fighter' },
      { kind: 'rankGained', teachingId: 'strike', rank: 1 },
    ]);

    // Practice alone is no news; the rank it earns is.
    rig.controller.dispatch({ tag: 'lucidity', payload: { role: 'fighter', ranks: [strike(1, 10)], study: 'strike' } });
    rig.controller.dispatch({ tag: 'lucidity', payload: { role: 'fighter', ranks: [strike(2, 5)], study: 'strike' } });
    expect(rig.controller.chatHistory.slice(3)).toEqual([{ kind: 'rankGained', teachingId: 'strike', rank: 2 }]);
  });
});

describe('the service panel', () => {
  const MASTER = 'npc:Meadow/pugnax';

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
    expect(rig.sent).toContainEqual({ tag: 'talk', payload: { npcId: MASTER } });
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
    expect(rig.sent).toEqual([
      { tag: 'target', payload: { targetId: 'npc:Meadow/libus' } },
      { tag: 'talk', payload: { npcId: 'npc:Meadow/libus' } },
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
    rig.session.askTask();
    rig.session.askTask('follow-through');
    rig.session.completeTask();
    rig.session.study('guard');
    rig.session.abandonTask();
    expect(rig.sent).toEqual([
      { tag: 'askTask', payload: { npcId: MASTER } },
      { tag: 'askTask', payload: { npcId: MASTER, teachingId: 'follow-through' } },
      { tag: 'completeTask', payload: { npcId: MASTER } },
      { tag: 'study', payload: { npcId: MASTER, teachingId: 'guard' } },
      { tag: 'abandonTask', payload: {} },
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
    rig.session.askTask();
    rig.session.completeTask();
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
});

describe('the shop', () => {
  const MERCUS = 'npc:Meadow/mercus';
  const rows = (purse: number, ...weapons: { itemId: string; equippedHand?: 'right' }[]) => [
    { slot: 0, itemId: 'purse', quantity: purse },
    ...weapons.map((weapon, index) => ({ slot: index + 1, quantity: 1, ...weapon })),
  ];

  const trades = (rig: Rig) => rig.sent.filter((message) => message.tag === 'buy' || message.tag === 'sell');

  /** Joins a meadow holding a cudgel, with Mercus a step south, and clicks him. */
  function atMercus(): { rig: Rig; repaints: () => number } {
    const rig = makeRig();
    rig.controller.dispatch(enterSpaceFrame());
    rig.controller.dispatch(sectorFrame(outdoorSector('Meadow', { x: 0, z: 0 })));
    rig.controller.dispatch(entityFrame({ facing: 30 }));
    rig.controller.dispatch(entityFrame({ id: MERCUS, kind: 'npc', name: 'Mercus', x: 10.3, z: 10.6, service: 'shopkeeper' }));
    rig.controller.dispatch({ tag: 'inventory', payload: { rows: rows(100, { itemId: 'cudgel', equippedHand: 'right' }) } });
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
    rig.session.sell('cudgel');
    expect(trades(rig)).toEqual([
      { tag: 'buy', payload: { npcId: MERCUS, itemId: 'dagger' } },
      { tag: 'sell', payload: { npcId: MERCUS, itemId: 'cudgel' } },
    ]);
  });

  it('announces what a trade bought or sold, and not the coins it moved', () => {
    const { rig } = atMercus();
    rig.controller.dispatch({
      tag: 'inventory',
      payload: { rows: rows(40, { itemId: 'cudgel', equippedHand: 'right' }, { itemId: 'dagger' }), trade: { kind: 'bought', itemId: 'dagger', coins: 60 } },
    });
    rig.controller.dispatch({
      tag: 'inventory',
      payload: { rows: rows(70, { itemId: 'cudgel', equippedHand: 'right' }), trade: { kind: 'sold', itemId: 'dagger', coins: 30 } },
    });
    rig.controller.dispatch({ tag: 'inventory', payload: { rows: rows(85), trade: { kind: 'sold', itemId: 'cudgel', coins: 15 } } });
    expect(rig.controller.chatHistory).toEqual([
      { kind: 'bought', itemId: 'dagger', coins: 60 },
      { kind: 'sold', itemId: 'dagger', coins: 30, emptiedHand: false },
      { kind: 'sold', itemId: 'cudgel', coins: 15, emptiedHand: true },
    ]);
  });

  it('locks every trade from the request until a moment after its answer, and redraws once it gives way', () => {
    const { rig, repaints } = atMercus();
    rig.session.buy('dagger');
    expect(repaints()).toBe(1);
    expect(rig.session.tradeLocked()).toBe(true);
    rig.session.buy('sword');
    rig.session.sell('cudgel');
    expect(trades(rig)).toHaveLength(1);

    rig.now = 300;
    rig.controller.dispatch({
      tag: 'inventory',
      payload: { rows: rows(40, { itemId: 'cudgel', equippedHand: 'right' }, { itemId: 'dagger' }), trade: { kind: 'bought', itemId: 'dagger', coins: 60 } },
    });
    const answered = repaints();
    rig.now = 799;
    rig.session.runTick(799);
    expect(rig.session.tradeLocked()).toBe(true);
    rig.now = 800;
    rig.session.runTick(800);
    rig.session.runTick(900);
    expect(rig.session.tradeLocked()).toBe(false);
    expect(repaints() - answered).toBe(1);
    rig.session.sell('cudgel');
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
    ['with an NPC as the target', (rig) => rig.session.pressEntity(GUARD)],
    ['with another dreamer as the target', (rig) => rig.session.pressEntity('far')],
    ['with themselves as the target', (rig) => rig.session.pressOwnFrame()],
    [
      'with the target driven off',
      (rig) => {
        rig.session.pressEntity(GHOST);
        rig.controller.dispatch({ tag: 'condition', payload: { entityId: GHOST, condition: 'fallen' } });
      },
    ],
    [
      'while fallen',
      (rig) => {
        rig.session.pressEntity(GHOST);
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

  it('is Attack, switched on and off at a nightmare targeted out of reach, and never walks the player toward it', () => {
    const rig = fighter();
    rig.session.pressEntity(GHOST);
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
    ['a change of target to an NPC', (rig) => rig.session.pressEntity(GUARD)],
    ['a change of target to a dreamer, for one who cannot mend', (rig) => rig.session.pressEntity('far')],
    ['the target cleared', (rig) => rig.session.select(undefined)],
    ['the target driven off', (rig) => rig.controller.dispatch({ tag: 'condition', payload: { entityId: GHOST, condition: 'fallen' } })],
    ['the target out of view', (rig) => rig.controller.dispatch({ tag: 'leave', payload: { entityId: GHOST, leftGame: false } })],
    ['a fall', (rig) => rig.controller.dispatch({ tag: 'condition', payload: { entityId: 'self', condition: 'fallen' } })],
    ['a new space', (rig) => rig.controller.dispatch(enterSpaceFrame('Hall'))],
  ])('goes off with %s, sending no engage frame', (_label, end) => {
    const rig = fighter();
    rig.session.pressEntity(GHOST);
    rig.session.toggleEngage();
    end(rig);
    rig.session.runTick(100);
    expect(rig.session.engaged).toBe(false);
    expect(engages(rig)).toEqual([{ on: true }]);
  });

  it('stays on from one nightmare to the next, sending no engage frame', () => {
    const rig = fighter();
    rig.controller.dispatch(entityFrame({ id: 'monster:2', kind: 'monster', x: 14, z: 12 }));
    rig.session.pressEntity(GHOST);
    rig.session.toggleEngage();
    rig.session.pressEntity('monster:2');
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
    rig.session.pressEntity(GHOST);
    rig.session.runTick(200);

    expect(rig.session.target).toBe(GHOST);
    expect(targets(rig)).toEqual([{ targetId: GHOST }]);
    expect(rig.selections).toEqual([GHOST]);
    expect(rig.session.predictor.walk).toMatchObject({ kind: 'path', destination: { x: 10, z: 14 } });

    const idle = selecting();
    idle.session.pressEntity(GHOST);
    idle.session.runTick(100);
    expect(idle.session.predictor.walk).toBeUndefined();
  });

  it('stays the target through a walk on open ground, and is cleared and unringed on request', () => {
    const rig = selecting();
    rig.selections.length = 0;
    rig.session.pressEntity(GHOST);
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
    rig.session.pressEntity(GHOST);
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
    gone.session.pressEntity(GHOST);
    gone.controller.dispatch({ tag: 'leave', payload: { entityId: GHOST, leftGame: false } });
    gone.session.runTick(0);
    expect(gone.session.target).toBeUndefined();
    expect(targets(gone)).toEqual([{ targetId: GHOST }, {}]);

    const door = selecting();
    door.session.pressEntity(GHOST);
    door.controller.dispatch({ tag: 'vitals', payload: { entityId: GHOST, health: 0.5 } });
    door.controller.dispatch(enterSpaceFrame('Hall'));
    expect(door.session.target).toBeUndefined();
    expect(door.session.vitalsOf(GHOST)).toBeUndefined();
    expect(targets(door)).toEqual([{ targetId: GHOST }]);
    expect(door.selections.at(-1)).toBeUndefined();
  });

  it('stays through a fall, while a press selects nothing', () => {
    const rig = selecting();
    rig.session.pressEntity(GHOST);
    rig.controller.dispatch({ tag: 'condition', payload: { entityId: 'self', condition: 'fallen' } });
    rig.session.pressEntity('bren');
    expect(rig.session.target).toBe(GHOST);
    expect(targets(rig)).toEqual([{ targetId: GHOST }]);
  });
});

describe('the gaze lock', () => {
  const GHOST = 'monster:1';
  const targets = (rig: Rig) => rig.sent.flatMap((message) => (message.tag === 'target' ? [message.payload] : []));

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

  it('targets the body a right press lands on and faces it whatever the cursor does, and faces the cursor again once a right press lands on the ground', () => {
    const rig = locking();
    rig.session.toggleGazeOn(GHOST);
    expect([rig.session.target, rig.session.gazeLocked]).toEqual([GHOST, true]);
    expect(targets(rig)).toEqual([{ targetId: GHOST }]);
    for (let time = 0; time <= 200; time += 50) rig.session.runTick(time);
    expect(facing(rig)).toBeCloseTo(90, 9);

    tapGround(rig, { x: 10, z: 14 }, 250);
    rig.session.aimAt({ x: 10, z: 1000 });
    for (let time = 250; time <= 450; time += 50) rig.session.runTick(time);
    expect(rig.session.predictor.walk).toMatchObject({ kind: 'path', destination: { x: 10, z: 14 } });
    const self = rig.controller.entities.get('self')!;
    expect(Math.abs(facing(rig) - headingFromVector(14 - self.position.x, 10 - self.position.z))).toBeLessThan(1);

    rig.session.unlockGaze();
    for (let time = 500; time <= 600; time += 50) rig.session.runTick(time);
    expect([rig.session.target, rig.session.gazeLocked]).toEqual([GHOST, false]);
    expect(facing(rig)).toBeCloseTo(0, 0);
  });

  it('lets go on a second right press on the target and keeps it, and locks again on a third', () => {
    const rig = locking();
    rig.session.toggleGazeOn(GHOST);
    rig.session.toggleGazeOn(GHOST);
    expect([rig.session.target, rig.session.gazeLocked]).toEqual([GHOST, false]);
    expect(targets(rig)).toEqual([{ targetId: GHOST }]);

    rig.session.toggleGazeOn(GHOST);
    expect([rig.session.target, rig.session.gazeLocked]).toEqual([GHOST, true]);
    expect(targets(rig)).toEqual([{ targetId: GHOST }]);
  });

  it('targets another body a right press lands on while locked, and stays locked on it', () => {
    const rig = locking();
    rig.session.toggleGazeOn(GHOST);
    rig.session.toggleGazeOn('bren');
    expect([rig.session.target, rig.session.gazeLocked]).toEqual(['bren', true]);
    expect(targets(rig)).toEqual([{ targetId: GHOST }, { targetId: 'bren' }]);
  });

  it('marks the target as locked in the scene from the lock until it ends, and as plain at a new target', () => {
    const rig = locking();
    const marks = (): [string | undefined, boolean][] => rig.selections.map((id, index) => [id, rig.selectionLocks[index]!]);
    rig.selections.length = 0;
    rig.selectionLocks.length = 0;

    rig.session.toggleGazeOn(GHOST);
    expect(marks()).toEqual([
      [GHOST, false],
      [GHOST, true],
    ]);
    rig.session.toggleGazeOn(GHOST);
    expect(marks().at(-1)).toEqual([GHOST, false]);
    rig.session.toggleGazeOn(GHOST);
    rig.session.unlockGaze();
    expect(marks().at(-1)).toEqual([GHOST, false]);
    rig.session.toggleGazeOn(GHOST);
    rig.session.pressEntity('bren');
    expect(marks().at(-1)).toEqual(['bren', false]);
    rig.session.toggleGazeOn(GHOST);
    rig.controller.dispatch({ tag: 'condition', payload: { entityId: GHOST, condition: 'fallen' } });
    rig.session.runTick(0);
    expect(marks().at(-1)).toEqual([GHOST, false]);
  });

  it('locks on an NPC and another dreamer alike, and never on the player themselves', () => {
    const rig = locking();
    rig.controller.dispatch(entityFrame({ id: 'npc:Meadow/guard', kind: 'npc', name: 'Guard', x: 10, z: 6 }));
    rig.session.toggleGazeOn('npc:Meadow/guard');
    expect([rig.session.target, rig.session.gazeLocked]).toEqual(['npc:Meadow/guard', true]);
    rig.session.toggleGazeOn('bren');
    expect([rig.session.target, rig.session.gazeLocked]).toEqual(['bren', true]);

    const own = locking();
    own.session.toggleGazeOn('self');
    expect([own.session.target, own.session.gazeLocked]).toEqual([undefined, false]);
    expect(targets(own)).toEqual([]);
  });

  it.each<[string, (rig: Rig) => void]>([
    ['the target is cleared', (rig) => rig.session.select(undefined)],
    ['a left press on another body makes it the target', (rig) => rig.session.pressEntity('bren')],
    ['the target leaves', (rig) => rig.controller.dispatch({ tag: 'leave', payload: { entityId: GHOST, leftGame: false } })],
    ['the target is driven off', (rig) => rig.controller.dispatch({ tag: 'condition', payload: { entityId: GHOST, condition: 'fallen' } })],
    ['a new space is entered', (rig) => rig.controller.dispatch(enterSpaceFrame('Hall'))],
  ])('ends when %s', (_label, end) => {
    const rig = locking();
    rig.session.toggleGazeOn(GHOST);
    end(rig);
    rig.session.runTick(0);
    expect(rig.session.gazeLocked).toBe(false);
  });

  it('holds through a left press on the target itself and through a walk', () => {
    const rig = locking();
    rig.session.toggleGazeOn(GHOST);
    rig.session.pressEntity(GHOST);
    tapGround(rig, { x: 10, z: 14 });
    rig.session.runTick(0);
    expect(rig.session.gazeLocked).toBe(true);
  });

  it('locks nothing at a nightmare already driven off', () => {
    const rig = locking();
    rig.controller.dispatch({ tag: 'condition', payload: { entityId: GHOST, condition: 'fallen' } });
    rig.session.toggleGazeOn(GHOST);
    expect([rig.session.target, rig.session.gazeLocked]).toEqual([GHOST, false]);
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
    rig.controller.dispatch({ tag: 'inventory', payload: { rows: [MOONSTONE_IN_HAND] } });
    rig.session.pressEntity('bren');
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
    rig.controller.dispatch({ tag: 'inventory', payload: { rows: [MOONSTONE_IN_HAND] } });
    return rig;
  }

  /** Targets the dreamer and switches Mend on. */
  function mend(rig: Rig, entityId: string): void {
    rig.session.pressEntity(entityId);
    rig.session.toggleEngage();
  }

  it('is Mend for a Healer with the Moonstone in hand, whose press at a dreamer only targets them', () => {
    const rig = healer();
    rig.selections.length = 0;
    rig.session.pressEntity('bren');
    expect([rig.session.target, rig.session.engaged, rig.session.engageAction()]).toEqual(['bren', false, 'mend']);
    expect(rig.selections).toEqual(['bren']);
    rig.session.toggleEngage();
    expect(rig.session.engaged).toBe(true);
    rig.session.toggleEngage();
    expect(engages(rig)).toEqual([{ on: true }, { on: false }]);
  });

  it.each<[string, (rig: Rig) => void]>([
    ['for a Healer with the Moonstone put away', (rig) => rig.controller.dispatch({ tag: 'inventory', payload: { rows: [MOONSTONE_PUT_AWAY] } })],
    ['for a Fighter', (rig) => rig.controller.dispatch({ tag: 'lucidity', payload: { role: 'fighter', ranks: [] } })],
  ])('cannot be switched on %s', (_label, arrange) => {
    const rig = healer();
    arrange(rig);
    rig.session.pressEntity('bren');
    expect(rig.session.engageAction()).toBeUndefined();
    rig.session.toggleEngage();
    expect(rig.session.engaged).toBe(false);
    expect(engages(rig)).toEqual([]);
  });

  it('is nothing at an NPC, a master included', () => {
    const rig = healer();
    rig.controller.dispatch(entityFrame({ id: 'npc:Meadow/sana', kind: 'npc', name: 'Sana', x: 14, z: 10, service: 'healerMaster' }));
    rig.session.pressEntity('npc:Meadow/sana');
    expect([rig.session.target, rig.session.engageAction()]).toEqual(['npc:Meadow/sana', undefined]);
    rig.session.toggleEngage();
    expect(rig.session.engaged).toBe(false);
    expect(engages(rig)).toEqual([]);
  });

  it('stays on from one dreamer to the next, and goes off at a nightmare, which the Moonstone does not swing at, sending no engage frame', () => {
    const rig = healer();
    rig.controller.dispatch(entityFrame({ id: 'monster:1', kind: 'monster', x: 14, z: 10 }));
    mend(rig, 'bren');
    rig.session.pressPlayerName('Cara');
    rig.session.runTick(0);
    expect([rig.session.target, rig.session.engaged]).toEqual(['cara', true]);
    rig.session.pressEntity('monster:1');
    rig.session.runTick(100);
    expect([rig.session.engaged, rig.session.engageAction()]).toEqual([false, undefined]);
    rig.session.toggleEngage();
    expect(rig.session.engaged).toBe(false);
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
    ['the Moonstone put away', (rig) => rig.controller.dispatch({ tag: 'inventory', payload: { rows: [MOONSTONE_PUT_AWAY] } })],
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
      ['targets another dreamer', (rig) => rig.session.pressEntity('cara')],
      ['puts the Moonstone away', (rig) => rig.controller.dispatch({ tag: 'inventory', payload: { rows: [MOONSTONE_PUT_AWAY] } })],
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
