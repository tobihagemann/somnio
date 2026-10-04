import { describe, expect, it } from 'vitest';
import { ConnectionController, GameplaySession, REMOTE_INTERPOLATION_SECONDS, noHeldKeys, noopRenderSurface } from '@/client';
import type { ClientEntity, HeldKeys } from '@/client';
import { GameplayTransport } from '@/transport';
import { fakeSocketFactory } from './helpers/fakeSocket';
import { TEST_REGISTRY, interiorSector, outdoorSector } from '../../core/test/support/worldFixture.ts';
import { clientEntity, enterSpaceFrame, entityFrame, makeDoor, sectorFrame } from './helpers/worldFixture';
import type { SomnioMessage } from '@somnio/protocol';

/**
 * The gameplay half of the client.
 *
 * The self/remote split of the position frames and the door latch are the places a slip stays
 * invisible until a player notices rubber-banding or lands in the wrong space, which is why they
 * are pinned here.
 */

interface Rig {
  session: GameplaySession;
  controller: ConnectionController;
  sent: SomnioMessage[];
  /** Every `updatePosition` call. */
  positions: { id: string; x: number; z: number }[];
  gaits: { id: string; gait: string }[];
  held: HeldKeys;
  /** The clock remote reports are stamped with. */
  now: number;
}

function makeRig(): Rig {
  const { factory } = fakeSocketFactory();
  const sent: SomnioMessage[] = [];
  const positions: Rig['positions'] = [];
  const gaits: Rig['gaits'] = [];

  const controller = new ConnectionController({
    transport: new GameplayTransport(factory),
    resolveURL: () => 'ws://test/ws',
    registry: TEST_REGISTRY,
    renderSurface: {
      ...noopRenderSurface,
      updatePosition: (id, position) => positions.push({ id, x: position.x, z: position.z }),
      updateGait: (id, gait) => gaits.push({ id, gait }),
    },
  });

  const rig: Rig = { session: undefined as unknown as GameplaySession, controller, sent, positions, gaits, held: noHeldKeys(), now: 0 };
  rig.session = new GameplaySession({
    controller,
    send: (message) => sent.push(message),
    input: { snapshot: () => rig.held, setGameplayActive: () => {}, clearHeldKeys: () => {} },
    measureText: (line) => line.length * 6,
    now: () => rig.now,
  });
  return rig;
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

describe('the door latch', () => {
  const HELD_S: HeldKeys = { ...noHeldKeys(), s: true };
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
    rig.held = HELD_S;
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

    const frames = framesAfter(5);
    expect(frames[0]).toMatchObject({ tag: 'move', payload: { x: 4.5, z: 5 } });
    expect(frames.filter((message) => message.tag === 'useDoor')).toEqual([{ tag: 'useDoor', payload: { sector: 'Hall', doorId: 'entry' } }]);
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
    expect(rig.sent).toEqual([{ tag: 'clientSay', payload: { text: 'hello' } }]);
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
  it.each([
    [{}, { slot: 4, hand: 'right' }],
    [{ equippedHand: 'right' }, { slot: 4 }],
  ] as const)('toggles the cudgel from %j with %j', (equipped, expected) => {
    const rig = makeRig();
    rig.controller.connectionState = 'attached';

    rig.session.activateInventoryRow({ slot: 4, itemId: 'cudgel', quantity: 1, ...equipped });

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

    rig.controller.dispatch({ tag: 'serverSay', payload: { entityId: 'npc:Meadow/wirt', text: 'Willkommen!' } });

    expect(rig.controller.chatHistory.at(-1)).toEqual({
      kind: expected,
      senderName: 'Wirt',
      message: 'Willkommen!',
    });
  });

  it('ignores serverSay for an entity it does not know', () => {
    const rig = makeRig();

    rig.controller.dispatch({ tag: 'serverSay', payload: { entityId: 'stranger', text: 'ghost' } });

    expect(rig.controller.chatHistory).toEqual([]);
  });

  /**
   * `onStateChanged` is the *only* repaint hook `AppShell` wires for session state, so dropping the
   * notification freezes the HUD bars and the items panel for the rest of the session while the
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
