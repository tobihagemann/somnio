import { describe, expect, it } from 'vitest'
import {
  ConnectionController,
  GameplaySession,
  goldBalance,
  inventoryRowFromWire,
  noHeldKeys,
} from '@/client'
import type { InventoryRow } from '@/client'
import { GameplayTransport } from '@/transport'
import { AI_TICK_INTERPOLATION_SECONDS, PEER_INTERPOLATION_SECONDS } from '@/client'
import { fakeSocketFactory } from './helpers/fakeSocket'
import type { SomnioMessage } from '@/protocol'
import type { WorldEntity } from '@/core'

/**
 * The gameplay half of the ported `ClientViewModel`.
 *
 * The wire-to-domain conversions and the `serverPosition` self/peer discrimination are the two
 * places a transcription slip stays invisible until a player notices the wrong hand or
 * rubber-banding, which is why they are pinned here.
 */

interface Rig {
  session: GameplaySession
  controller: ConnectionController
  sent: SomnioMessage[]
  /** Every `animateEntity` call, so a tween's duration is observable. */
  tweens: { id: number; duration: number }[]
  /** Every direct `updatePosition` call — the self path, which must never tween. */
  directWrites: { id: number; x: number; y: number }[]
  clearedRemainders: number
}

function makeRig(): Rig {
  const { factory } = fakeSocketFactory()
  const sent: SomnioMessage[] = []
  const tweens: Rig['tweens'] = []
  const directWrites: Rig['directWrites'] = []
  let clearedRemainders = 0

  const controller = new ConnectionController({
    transport: new GameplayTransport(factory),
    resolveURL: () => 'ws://test/ws',
    renderSurface: {
      load: () => {},
      showSplash: () => {},
      placeEntity: () => {},
      removeEntity: () => {},
      updatePosition: (id, position) => directWrites.push({ id, x: position.x, y: position.y }),
      updateSubpixelPosition: () => {},
      animateEntity: (id, _position, _facing, duration) => tweens.push({ id, duration }),
      updateTempo: () => {},
      updateDayNightTint: () => {},
      showSpeechBubble: () => {},
    },
  })

  const session = new GameplaySession({
    controller,
    send: (message) => sent.push(message),
    input: { snapshot: () => noHeldKeys(), setGameplayActive: () => {}, clearHeldKeys: () => {} },
    measureText: (line) => line.length * 6,
  })
  const originalClear = session.predictor.clearMovementRemainder.bind(session.predictor)
  session.predictor.clearMovementRemainder = (): void => {
    clearedRemainders += 1
    originalClear()
  }

  return {
    session,
    controller,
    sent,
    tweens,
    directWrites,
    get clearedRemainders() {
      return clearedRemainders
    },
  }
}

function entity(overrides: Partial<WorldEntity> = {}): WorldEntity {
  return {
    id: 1,
    kind: 'player',
    figure: 1,
    gender: 0,
    position: { x: 100, y: 100 },
    facing: 0,
    tempo: 2,
    maskSize: { width: 32, height: 48 },
    name: 'Tester',
    ...overrides,
  }
}

describe('the wire-to-domain inventory conversion', () => {
  /**
   * The shift is off by one in the natural transcription: wire 0 means "no hand", and 1/2 map onto
   * `Hand`'s left/right. Getting it backwards shows `[L]` for a right-hand item *and* sends the wrong
   * hand back when the row is double-clicked, so the toggle visibly does the opposite of the ask.
   */
  it.each([
    [0, undefined],
    [1, 0],
    [2, 1],
  ] as const)('maps wire hand %s onto %s', (wire, expected) => {
    const row = inventoryRowFromWire({ slot: 3, category: 1, itemId: 0, extras: [], equippedHand: wire })
    expect(row.equippedHand).toBe(expected)
  })

  it('reads the purse balance from the gold extra and defaults to zero without it', () => {
    const purse: InventoryRow = {
      slot: 0,
      category: 0,
      itemId: 0,
      extras: [{ key: 'gold', value: 42 }],
      equippedHand: undefined,
    }
    expect(goldBalance(purse)).toBe(42)
    expect(goldBalance({ ...purse, extras: [{ key: 'silver', value: 9 }] })).toBe(0)
  })
})

describe('serverPosition discrimination', () => {
  function attach(rig: Rig, entities: readonly WorldEntity[]): void {
    for (const each of entities) rig.controller.entities.set(each.id, each)
    rig.controller.selfEntityIndex = 1
    rig.controller.connectionState = 'attached'
  }

  /**
   * The self branch writes directly and clears the sub-pixel carry. Tweening self instead would
   * fight the predictor, which writes the same node every frame and drives the camera — the
   * de-centring the comment in `handleServerPosition` warns about.
   */
  it('applies a self snapBack directly and clears the movement remainder', () => {
    const rig = makeRig()
    attach(rig, [entity()])

    rig.controller.dispatch({
      tag: 'serverPosition',
      payload: { entityIndex: 1, x: 200, y: 210, facing: 90, tempo: 2 },
    })

    expect(rig.directWrites).toEqual([{ id: 1, x: 200, y: 210 }])
    expect(rig.tweens).toEqual([])
    expect(rig.clearedRemainders).toBe(1)
  })

  /**
   * Peers arrive on the 2 Hz heartbeat and NPCs/monsters on the 50 ms AI tick, so each tweens across
   * its own gap. Swapping the two durations makes peers stutter and monsters lag — both visible, and
   * neither caught by anything that only checks a tween happened.
   */
  it.each([
    ['peer', PEER_INTERPOLATION_SECONDS],
    ['npc', AI_TICK_INTERPOLATION_SECONDS],
    ['monster', AI_TICK_INTERPOLATION_SECONDS],
  ] as const)('tweens a %s across its own cadence', (kind, duration) => {
    const rig = makeRig()
    attach(rig, [entity(), entity({ id: 2, kind })])

    rig.controller.dispatch({
      tag: 'serverPosition',
      payload: { entityIndex: 2, x: 300, y: 300, facing: 0, tempo: 2 },
    })

    expect(rig.tweens).toEqual([{ id: 2, duration }])
    expect(rig.directWrites).toEqual([])
  })

  /**
   * An unknown tempo keeps the entity's current one, matching
   * `ClientViewModel.handleServerPosition`. Falling back to the default here — which is right for
   * entity *creation* — would animate the same frame differently from the native client.
   */
  it('keeps the current tempo when the raw value is unknown', () => {
    const rig = makeRig()
    attach(rig, [entity(), entity({ id: 2, kind: 'peer', tempo: 4 })])

    rig.controller.dispatch({
      tag: 'serverPosition',
      payload: { entityIndex: 2, x: 300, y: 300, facing: 0, tempo: 99 },
    })

    expect(rig.controller.entities.get(2)?.tempo).toBe(4)
  })

  it('ignores a position for an entity it does not know', () => {
    const rig = makeRig()
    attach(rig, [entity()])

    rig.controller.dispatch({
      tag: 'serverPosition',
      payload: { entityIndex: 99, x: 1, y: 1, facing: 0, tempo: 2 },
    })

    expect(rig.tweens).toEqual([])
    expect(rig.directWrites).toEqual([])
  })
})

describe('outbound chat', () => {
  it('does not send while unattached, and sends once attached', () => {
    const rig = makeRig()
    rig.controller.selfEntityIndex = 1
    rig.controller.entities.set(1, entity())

    rig.session.submitChat('hello')
    expect(rig.sent).toEqual([])

    rig.controller.connectionState = 'attached'
    rig.session.submitChat('hello')
    expect(rig.sent.map((message) => message.tag)).toEqual(['clientSay'])
  })

  it('drops a blank line rather than sending an empty frame', () => {
    const rig = makeRig()
    rig.controller.selfEntityIndex = 1
    rig.controller.entities.set(1, entity())
    rig.controller.connectionState = 'attached'

    rig.session.submitChat('   ')

    expect(rig.sent).toEqual([])
  })

  /** The cap is in UTF-8 bytes, so a string of multi-byte characters truncates well before 256 of them. */
  it('truncates outbound text on byte length, not code-unit length', () => {
    const rig = makeRig()
    rig.controller.selfEntityIndex = 1
    rig.controller.entities.set(1, entity())
    rig.controller.connectionState = 'attached'

    rig.session.submitChat('ä'.repeat(200))

    const frame = rig.sent[0]
    if (frame?.tag !== 'clientSay') throw new Error('expected a clientSay frame')
    expect(new TextEncoder().encode(frame.payload.text).length).toBeLessThanOrEqual(256)
  })
})

describe('inventory activation', () => {
  it('reports the purse balance to chat instead of equipping it', () => {
    const rig = makeRig()
    rig.controller.connectionState = 'attached'

    rig.session.activateInventoryRow({
      slot: 0,
      category: 0,
      itemId: 0,
      extras: [{ key: 'gold', value: 7 }],
      equippedHand: undefined,
    })

    expect(rig.sent).toEqual([])
    expect(rig.controller.chatHistory.at(-1)).toEqual({ kind: 'purseBalance', coins: 7 })
  })

  /** Unequipped sends the right hand; already-equipped sends "no hand" to clear it. */
  it.each([
    [undefined, 2],
    [1, 0],
  ] as const)('toggles the cudgel from hand %s with wire hand %s', (equippedHand, expected) => {
    const rig = makeRig()
    rig.controller.connectionState = 'attached'

    rig.session.activateInventoryRow({ slot: 4, category: 1, itemId: 0, extras: [], equippedHand })

    const frame = rig.sent[0]
    if (frame?.tag !== 'equipToggle') throw new Error('expected an equipToggle frame')
    expect(frame.payload).toEqual({ slot: 4, hand: expected })
  })
})

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
    const rig = makeRig()
    rig.controller.entities.set(7, entity({ id: 7, kind, name: 'Wirt' }))

    rig.controller.dispatch({ tag: 'serverSay', payload: { entityIndex: 7, text: 'Willkommen!' } })

    expect(rig.controller.chatHistory.at(-1)).toEqual({
      kind: expected,
      senderName: 'Wirt',
      message: 'Willkommen!',
    })
  })

  it('ignores serverSay for an entity it does not know', () => {
    const rig = makeRig()

    rig.controller.dispatch({ tag: 'serverSay', payload: { entityIndex: 99, text: 'ghost' } })

    expect(rig.controller.chatHistory).toEqual([])
  })

  /**
   * `onStateChanged` is the *only* repaint hook `AppShell` wires for session state, so dropping the
   * notification freezes the HUD bars and the items panel for the rest of the session while the
   * values themselves stay correct. `ui.test.ts` renders both from hand-built values, which is
   * exactly why a broken notification is invisible there.
   */
  it('stores energy and asks for a repaint', () => {
    const rig = makeRig()
    let repaints = 0
    rig.session.onStateChanged = () => {
      repaints += 1
    }
    const energy = { hpCurrent: 40, hpMax: 80, balanceCurrent: 5, balanceMax: 10, manaCurrent: 1, manaMax: 4 }

    rig.controller.dispatch({ tag: 'energy', payload: energy })

    expect(rig.session.energy).toEqual(energy)
    expect(repaints).toBe(1)
  })

  it('converts the inventory rows and asks for a repaint', () => {
    const rig = makeRig()
    let repaints = 0
    rig.session.onStateChanged = () => {
      repaints += 1
    }

    rig.controller.dispatch({
      tag: 'inventory',
      payload: {
        rows: [{ slot: 2, category: 1, itemId: 0, extras: [{ key: 'gold', value: 9 }], equippedHand: 2 }],
      },
    })

    expect(rig.session.inventory).toEqual([
      { slot: 2, category: 1, itemId: 0, extras: [{ key: 'gold', value: 9 }], equippedHand: 1 },
    ])
    expect(repaints).toBe(1)
  })

  it('renders an admin broadcast into the scrollback', () => {
    const rig = makeRig()

    rig.controller.dispatch({ tag: 'adminSay', payload: { text: 'Server restarting.' } })

    expect(rig.controller.chatHistory.at(-1)).toEqual({
      kind: 'adminBroadcast',
      message: 'Server restarting.',
    })
  })
})
