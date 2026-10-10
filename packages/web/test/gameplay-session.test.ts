import { describe, expect, it } from 'vitest';
import { ConnectionController, GameplaySession, REMOTE_INTERPOLATION_SECONDS, compassPoint, noHeldKeys, noopRenderSurface } from '@/client';
import type { ClientEntity, HeldKeys, SpeechBubbleRequest } from '@/client';
import { GameplayTransport } from '@/transport';
import { fakeSocketFactory } from './helpers/fakeSocket';
import { TEST_REGISTRY, interiorSector, outdoorSector } from '../../core/test/support/worldFixture.ts';
import { clientEntity, enterSpaceFrame, entityFrame, makeDoor, sectorFrame } from './helpers/worldFixture';
import { fullPools } from '@somnio/core';
import type { SomnioMessage } from '@somnio/protocol';

/**
 * The gameplay half of the client.
 *
 * The self/remote split of the position frames and the door latch are the places a slip stays
 * invisible until a player notices rubber-banding or lands in the wrong space, which is why they
 * are pinned here.
 */

const FULL = fullPools([]);

interface Rig {
  session: GameplaySession;
  controller: ConnectionController;
  sent: SomnioMessage[];
  /** Every `updatePosition` call. */
  positions: { id: string; x: number; z: number }[];
  gaits: { id: string; gait: string }[];
  /** Every `showSelection` call. */
  selections: (string | undefined)[];
  /** Every `showBlow`, `showRaising`, and `updateCondition` call, by name. */
  shown: unknown[][];
  /** Every `showSpeechBubble` call. */
  bubbles: SpeechBubbleRequest[];
  /** What the scene answers a bubble with: whether it pinned it at the edge. */
  pinsBubbles: boolean;
  held: HeldKeys;
  /** The clock remote reports are stamped with. */
  now: number;
}

function makeRig(): Rig {
  const { factory } = fakeSocketFactory();
  const sent: SomnioMessage[] = [];
  const positions: Rig['positions'] = [];
  const gaits: Rig['gaits'] = [];
  const selections: Rig['selections'] = [];
  const shown: Rig['shown'] = [];
  const bubbles: Rig['bubbles'] = [];

  const controller = new ConnectionController({
    transport: new GameplayTransport(factory),
    resolveURL: () => 'ws://test/ws',
    registry: TEST_REGISTRY,
    renderSurface: {
      ...noopRenderSurface,
      updatePosition: (id, position) => positions.push({ id, x: position.x, z: position.z }),
      updateGait: (id, gait) => gaits.push({ id, gait }),
      showSelection: (id) => selections.push(id),
      showBlow: (...blow) => shown.push(['showBlow', ...blow]),
      showRaising: (...raising) => shown.push(['showRaising', ...raising]),
      updateCondition: (...condition) => shown.push(['updateCondition', ...condition]),
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
    shown,
    bubbles,
    pinsBubbles: false,
    held: noHeldKeys(),
    now: 0,
  };
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

describe('the Mondstein', () => {
  it.each([
    ['takes it in hand when it is put away', {}, { tag: 'equipToggle', payload: { slot: 2, hand: 'right' } }],
    ['uses it once it is in hand', { equippedHand: 'right' }, { tag: 'useItem', payload: { slot: 2 } }],
  ] as const)('%s', (_label, equipped, expected) => {
    const rig = makeRig();
    rig.controller.connectionState = 'attached';

    rig.session.activateInventoryRow({ slot: 2, itemId: 'mondstein', quantity: 1, ...equipped });

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

  it('counts a raise given to the player down by whole seconds, and reports being drawn back', () => {
    const rig = makeRig();
    rig.controller.dispatch(enterSpaceFrame());
    rig.controller.dispatch(entityFrame({ condition: 'fallen' }));
    rig.controller.dispatch(entityFrame({ id: 'healer', name: 'Lumi' }));
    const raising = { healerId: 'healer', targetId: 'self' };
    rig.now = 1000;
    rig.controller.dispatch({ tag: 'raising', payload: { ...raising, state: 'begun', seconds: 6 } });
    expect(rig.session.raise).toEqual({ healerName: 'Lumi', secondsLeft: 6 });
    rig.session.runTick(3500);
    expect(rig.session.raise).toEqual({ healerName: 'Lumi', secondsLeft: 4 });

    rig.controller.dispatch({ tag: 'raising', payload: { ...raising, state: 'broken', seconds: 0 } });
    expect(rig.session.raise).toBeUndefined();
    expect(rig.controller.chatHistory).toEqual([]);

    rig.controller.dispatch({ tag: 'raising', payload: { ...raising, state: 'begun', seconds: 6 } });
    rig.controller.dispatch({ tag: 'raising', payload: { ...raising, state: 'done', seconds: 0 } });
    expect(rig.session.raise).toBeUndefined();
    expect(rig.controller.chatHistory.at(-1)).toEqual({ kind: 'raised', healerName: 'Lumi' });
  });

  it('leaves a raise given to someone else to the scene', () => {
    const rig = makeRig();
    rig.controller.dispatch(enterSpaceFrame());
    rig.controller.dispatch(entityFrame());
    rig.controller.dispatch({ tag: 'raising', payload: { healerId: 'healer', targetId: 'peer', state: 'begun', seconds: 6 } });
    expect(rig.session.raise).toBeUndefined();
  });

  it('shows the scene every blow, every raise begun and ended, and every change of condition', () => {
    const rig = makeRig();
    rig.controller.dispatch(enterSpaceFrame());
    rig.controller.dispatch(entityFrame());
    rig.controller.dispatch(entityFrame({ id: 'peer', kind: 'player' }));
    rig.shown.length = 0;

    rig.controller.dispatch({ tag: 'blow', payload: { attackerId: 'monster:1', targetId: 'peer', hit: true } });
    rig.controller.dispatch({ tag: 'blow', payload: { attackerId: 'peer', hit: false } });
    rig.controller.dispatch({ tag: 'condition', payload: { entityId: 'peer', condition: 'fallen' } });
    const raising = { healerId: 'self', targetId: 'peer', seconds: 0 };
    rig.controller.dispatch({ tag: 'raising', payload: { ...raising, state: 'begun', seconds: 6 } });
    rig.controller.dispatch({ tag: 'raising', payload: { ...raising, state: 'broken' } });

    expect(rig.shown).toEqual([
      ['showBlow', 'monster:1', 'peer', true],
      ['showBlow', 'peer', undefined, false],
      ['updateCondition', 'peer', 'fallen'],
      ['showRaising', 'peer', 6],
      ['showRaising', 'peer', undefined],
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
        role: 'kaempfer',
        ranks: [strike(3)],
        study: 'strike',
        task: { role: 'kaempfer', teachingId: 'follow-through', progress: 3 },
      },
    });

    expect(rig.controller.chatHistory).toEqual([]);
    expect(rig.session.lucidity.role).toBe('kaempfer');

    // Nor after a door: the new space's first frames restate what the player already knew.
    rig.controller.dispatch(enterSpaceFrame('Hall'));
    rig.controller.dispatch(purse(100));
    rig.controller.dispatch({ tag: 'lucidity', payload: { role: 'kaempfer', ranks: [strike(3)] } });
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
    const trial = (progress: number) => ({ role: 'kaempfer' as const, progress });
    rig.controller.dispatch({ tag: 'lucidity', payload: { ranks: [], task: trial(0) } });

    rig.controller.dispatch({ tag: 'lucidity', payload: { ranks: [], task: trial(1) } });
    expect(rig.controller.chatHistory).toEqual([{ kind: 'taskDone' }]);

    rig.controller.dispatch({ tag: 'lucidity', payload: { role: 'kaempfer', ranks: [strike(1)], study: 'strike' } });
    expect(rig.controller.chatHistory.slice(1)).toEqual([
      { kind: 'becameRole', role: 'kaempfer' },
      { kind: 'rankGained', teachingId: 'strike', rank: 1 },
    ]);

    // Practice alone is no news; the rank it earns is.
    rig.controller.dispatch({ tag: 'lucidity', payload: { role: 'kaempfer', ranks: [strike(1, 10)], study: 'strike' } });
    rig.controller.dispatch({ tag: 'lucidity', payload: { role: 'kaempfer', ranks: [strike(2, 5)], study: 'strike' } });
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
    rig.controller.dispatch(entityFrame({ id: MASTER, kind: 'npc', name: 'Pugnax', x: 10.3, z: 10.6, service: 'kaempferMaster' }));
    rig.session.pressAt(MASTER, time);
    tick(3);
    return { rig, tick };
  }

  it('opens on a click at an NPC with a service, speaking to them, without closing the input gate or stopping the player', () => {
    const { rig, tick } = atMaster();
    expect(rig.sent).toContainEqual({ tag: 'talk', payload: { npcId: MASTER } });
    expect(rig.session.servicePanel?.id).toBe(MASTER);
    expect(rig.controller.presentedOverlay).toBeUndefined();

    rig.held = { ...noHeldKeys(), w: true };
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
    rig.session.pressAt('npc:Meadow/libus', 0);
    expect(rig.sent).toEqual([{ tag: 'talk', payload: { npcId: 'npc:Meadow/libus' } }]);
    expect(rig.session.servicePanel).toBeUndefined();
  });

  it('does nothing at an NPC beyond speaking distance: no word, no panel, and no swing', () => {
    const rig = makeRig();
    rig.controller.dispatch(enterSpaceFrame());
    rig.controller.dispatch(entityFrame());
    rig.controller.dispatch(entityFrame({ id: MASTER, kind: 'npc', x: 10, z: 12.1, service: 'kaempferMaster' }));
    rig.controller.dispatch({ tag: 'energy', payload: FULL });
    expect(rig.session.clickAction(MASTER)).toBeUndefined();
    rig.session.pressAt(MASTER, 0);
    rig.session.runTick(0);
    expect(rig.sent.filter((message) => message.tag !== 'move')).toEqual([]);
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
    rig.held = { ...noHeldKeys(), w: true };
    tick(8);
    expect(rig.session.servicePanel?.id).toBe(MASTER);
    tick(12);
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
});

describe('a swing', () => {
  const GHOST = 'monster:1';
  const CUDGEL = { slot: 1, itemId: 'cudgel', quantity: 1, equippedHand: 'right' as const };
  const swings = (rig: Rig) => rig.sent.flatMap((message) => (message.tag === 'swing' ? [message.payload] : []));

  /** A player facing south at (10, 10) with full pools, and a nightmare where `ghost` puts it, or none for `null`. */
  function fighter(ghost: { x: number; z: number } | null = { x: 10, z: 10.7 }): Rig {
    const rig = makeRig();
    rig.controller.dispatch(enterSpaceFrame());
    rig.controller.dispatch(sectorFrame(outdoorSector('Meadow', { x: 0, z: 0 })));
    rig.controller.dispatch(entityFrame());
    if (ghost !== null) rig.controller.dispatch(entityFrame({ id: GHOST, kind: 'monster', ...ghost }));
    rig.controller.dispatch({ tag: 'energy', payload: FULL });
    return rig;
  }

  it('meets the nightmare in reach in front of the player, on a click at anything that is neither an NPC nor theirs to tend', () => {
    const rig = fighter();
    rig.controller.dispatch(entityFrame({ id: 'peer', kind: 'player', x: 12, z: 10 }));
    rig.session.pressAt(undefined, 0);
    rig.session.release();
    rig.session.pressAt('peer', 2000);
    rig.session.release();
    rig.session.pressAt(GHOST, 4000);
    expect(swings(rig)).toEqual([{ targetId: GHOST }, { targetId: GHOST }, { targetId: GHOST }]);
  });

  it.each<[string, { x: number; z: number } | null]>([
    ['with no nightmare near', null],
    ['with the nightmare behind the player', { x: 10, z: 9.3 }],
    ['with the nightmare out of reach', { x: 10, z: 10.9 }],
  ])('meets the air %s', (_label, ghost) => {
    const rig = fighter(ghost);
    rig.session.pressAt(undefined, 0);
    expect(swings(rig)).toEqual([{}]);
  });

  it('keeps swinging at the swing rhythm while the button is held, and stops when it comes up', () => {
    const rig = fighter();
    rig.session.pressAt(undefined, 0);
    for (let time = 100; time <= 2000; time += 100) rig.session.runTick(time);
    expect(swings(rig)).toHaveLength(3);
    rig.session.release();
    for (let time = 2100; time <= 4000; time += 100) rig.session.runTick(time);
    expect(swings(rig)).toHaveLength(3);
  });

  /** A second pointer can press while the first still holds; its press is the one that counts from then on. */
  it('ends a swing still held when the next press asks an NPC to go on', () => {
    const rig = fighter(null);
    rig.controller.dispatch(entityFrame({ id: 'npc:Meadow/guard', kind: 'npc', name: 'Guard', x: 10, z: 11.5 }));
    rig.session.pressAt(undefined, 0);
    rig.session.pressAt('npc:Meadow/guard', 100);
    expect(rig.sent.at(-1)).toEqual({ tag: 'talk', payload: { npcId: 'npc:Meadow/guard' } });
    for (let time = 200; time <= 2000; time += 100) rig.session.runTick(time);
    expect(swings(rig)).toHaveLength(1);
  });

  it('stops swinging when the page loses the pointer with the button still down', () => {
    const rig = fighter();
    rig.session.pressAt(undefined, 0);
    rig.session.handleVisibilityLoss();
    for (let time = 100; time <= 2000; time += 100) rig.session.runTick(time);
    expect(swings(rig)).toHaveLength(1);
  });

  it('stops swinging when the chat input takes focus with the button still down, and does not start again when it lets go', () => {
    const rig = fighter();
    rig.session.pressAt(undefined, 0);
    rig.controller.setChatInputFocused(true);
    for (let time = 100; time <= 2000; time += 100) rig.session.runTick(time);
    rig.controller.setChatInputFocused(false);
    for (let time = 2100; time <= 4000; time += 100) rig.session.runTick(time);
    expect(swings(rig)).toHaveLength(1);
  });

  it('swings past a nightmare that is already fading', () => {
    const rig = fighter();
    rig.controller.dispatch({ tag: 'condition', payload: { entityId: GHOST, condition: 'fallen' } });
    rig.session.pressAt(GHOST, 0);
    expect(swings(rig)).toEqual([{}]);
  });

  it('keeps the shorter rhythm of Follow-through', () => {
    const rig = fighter();
    rig.controller.dispatch({ tag: 'lucidity', payload: { role: 'kaempfer', ranks: [{ teachingId: 'follow-through', rank: 3, practice: 0 }] } });
    rig.session.pressAt(undefined, 0);
    for (let time = 100; time <= 1400; time += 100) rig.session.runTick(time);
    expect(swings(rig)).toHaveLength(3);
  });

  it.each<[string, (rig: Rig) => void]>([
    ['with less balance than what is in hand costs', (rig) => rig.controller.dispatch({ tag: 'energy', payload: { ...FULL, balanceCurrent: 17 } })],
    [
      'with the Mondstein in hand',
      (rig) => rig.controller.dispatch({ tag: 'inventory', payload: { rows: [{ slot: 2, itemId: 'mondstein', quantity: 1, equippedHand: 'right' }] } }),
    ],
    ["while holding the Heiler's trial", (rig) => rig.controller.dispatch({ tag: 'lucidity', payload: { ranks: [], task: { role: 'heiler', progress: 0 } } })],
    ['while fallen', (rig) => rig.controller.dispatch({ tag: 'condition', payload: { entityId: 'self', condition: 'fallen' } })],
    ['under an overlay', (rig) => (rig.controller.presentedOverlay = { kind: 'gameMenu' })],
  ])('does not swing %s', (_label, arrange) => {
    const rig = fighter();
    rig.controller.dispatch({ tag: 'inventory', payload: { rows: [CUDGEL] } });
    arrange(rig);
    rig.session.pressAt(undefined, 0);
    rig.session.runTick(100);
    expect(swings(rig)).toEqual([]);
  });

  it('reports where the player stands before the swing, so the server judges the reach from there', () => {
    const rig = fighter();
    rig.session.runTick(0);
    rig.held = { ...noHeldKeys(), s: true };
    rig.session.runTick(16);
    rig.sent.length = 0;
    rig.session.pressAt(undefined, 16);
    expect(rig.sent.map((message) => message.tag)).toEqual(['move', 'swing']);
    expect(rig.sent[0]).toMatchObject({ payload: rig.controller.entities.get('self')!.position });
  });

  it('slows the player for the swing, and no longer', () => {
    const rig = fighter(null);
    const stride = (from: number, to: number): number => {
      const before = rig.controller.entities.get('self')!.position;
      for (let time = from; time <= to; time += 100) rig.session.runTick(time);
      const after = rig.controller.entities.get('self')!.position;
      return Math.hypot(after.x - before.x, after.z - before.z);
    };
    rig.held = { ...noHeldKeys(), w: true };
    rig.session.runTick(0);
    rig.session.pressAt(undefined, 0);
    rig.session.release();
    // Three ticks inside the 0.4 s the swing slows, then three after it.
    const slowed = stride(100, 300);
    expect(slowed / stride(500, 700)).toBeCloseTo(0.7, 9);
  });
});

describe('tending', () => {
  const HEILER = { tag: 'lucidity' as const, payload: { role: 'heiler' as const, ranks: [{ teachingId: 'touch', rank: 1, practice: 0 }] } };
  const tends = (rig: Rig) => rig.sent.flatMap((message) => (message.tag === 'tend' ? [message.payload] : []));

  function healer(): Rig {
    const rig = makeRig();
    rig.controller.dispatch(enterSpaceFrame());
    rig.controller.dispatch(sectorFrame(outdoorSector('Meadow', { x: 0, z: 0 })));
    rig.controller.dispatch(entityFrame());
    rig.controller.dispatch(entityFrame({ id: 'bren', kind: 'player', name: 'Bren', x: 11, z: 10 }));
    rig.controller.dispatch(entityFrame({ id: 'cara', kind: 'player', name: 'Cara', x: 9, z: 10 }));
    rig.controller.dispatch({ tag: 'energy', payload: FULL });
    rig.controller.dispatch(HEILER);
    rig.controller.dispatch({ tag: 'inventory', payload: { rows: [{ slot: 2, itemId: 'mondstein', quantity: 1, equippedHand: 'right' }] } });
    return rig;
  }

  it('tends the dreamer a Heiler clicks, marks them, and lets go on a second click', () => {
    const rig = healer();
    expect(rig.session.clickAction('bren')).toBe('tend');
    rig.session.pressAt('bren', 0);
    expect(rig.session.tending).toBe('bren');
    rig.session.pressAt('bren', 100);
    expect(rig.session.tending).toBeUndefined();
    expect(tends(rig)).toEqual([{ targetId: 'bren' }, {}]);
    expect(rig.selections.slice(-2)).toEqual(['bren', undefined]);
  });

  it('turns to another dreamer on a click at them, and lets go on a click anywhere else', () => {
    const rig = healer();
    rig.session.pressAt('bren', 0);
    rig.session.pressAt('cara', 100);
    expect(rig.session.tending).toBe('cara');
    rig.session.pressAt(undefined, 200);
    expect(rig.session.tending).toBeUndefined();
    expect(tends(rig)).toEqual([{ targetId: 'bren' }, { targetId: 'cara' }, {}]);
  });

  it('lets go when the dreamer tended leaves, and with every new space', () => {
    const gone = healer();
    gone.session.pressAt('bren', 0);
    gone.controller.dispatch({ tag: 'leave', payload: { entityId: 'bren', leftGame: false } });
    gone.session.runTick(0);
    expect(gone.session.tending).toBeUndefined();
    expect(tends(gone)).toEqual([{ targetId: 'bren' }, {}]);

    const door = healer();
    door.session.pressAt('bren', 0);
    door.controller.dispatch(enterSpaceFrame('Hall'));
    expect(door.session.tending).toBeUndefined();
    // The server holds it per space, so there is nothing to take back.
    expect(tends(door)).toEqual([{ targetId: 'bren' }]);
    expect(door.selections.at(-1)).toBeUndefined();
  });

  /** The server lets go for a dreamer who falls and drops what they send while fallen, so there is nothing to tell it. */
  it('lets go on falling, without a word to the server', () => {
    const rig = healer();
    rig.session.pressAt('bren', 0);
    rig.controller.dispatch({ tag: 'condition', payload: { entityId: 'self', condition: 'fallen' } });
    expect(rig.session.tending).toBeUndefined();
    expect(rig.selections.at(-1)).toBeUndefined();

    rig.controller.dispatch({ tag: 'leave', payload: { entityId: 'bren', leftGame: false } });
    rig.session.runTick(0);
    expect(tends(rig)).toEqual([{ targetId: 'bren' }]);
  });

  it('is not what a click at a dreamer does for anyone but a Heiler', () => {
    const rig = healer();
    rig.controller.dispatch({ tag: 'lucidity', payload: { role: 'kaempfer', ranks: [] } });
    expect(rig.session.clickAction('bren')).toBe('swing');
    rig.session.pressAt('bren', 0);
    expect(rig.session.tending).toBeUndefined();
    expect(tends(rig)).toEqual([]);
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
