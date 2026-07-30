import { describe, expect, it } from 'vitest'
import { PORTAL_DIRECTIONS, sectorFromWire } from '@/core'
import type { Sector, WorldEntity } from '@/core'
import type { WireSector } from '@/protocol'
import type { SomnioMessage } from '@/protocol'
import {
  FACING_EMIT_THRESHOLD_DEGREES,
  GameplayPredictor,
  MAX_TICK_ELAPSED_MS,
  POSITION_HEARTBEAT_INTERVAL_MS,
  entityBlockers,
  noHeldKeys,
  resolvedMove,
  velocityFromHeld,
} from '@/client'
import type { HeldKeys, PredictorSession } from '@/client'
import type { ConnectionState, OverlayKind } from '@/client'
import { noopRenderSurface } from '@/client'
import type { WorldRenderSurface } from '@/client'

/**
 * Deterministic prediction-tick suite. Every positional expectation below is a **Swift-computed**
 * literal: the arithmetic chain of `runOneGameplayTick` was run through the real
 * `OrthographicCameraRig.worldMovement`, `Heading`, `RelativeDirection`, and `Tempo` for the same
 * key-hold sequences, and the printed positions and remainders are pinned here verbatim.
 *
 * Re-deriving them in JavaScript would defeat the point — the suite exists to catch this port
 * drifting from the Swift predictor, and expectations computed by the port itself cannot do that.
 */

/** Held W only. Screen-up under the yawed camera, so both world axes move. */
const HELD_W: HeldKeys = { ...noHeldKeys(), w: true }

/**
 * Travel heading for held W, and the facing the fixtures use so the step is `forward` with a 1.0
 * speed multiplier. Swift prints the travel heading as 214.99998 — the `Float` narrowing of
 * `atan2f` lands just under 215 — and facing 210 buckets it as forward either way.
 */
const FORWARD_FACING = 210

function wireSector(overrides: Partial<WireSector> = {}): WireSector {
  return {
    name: 'testsector',
    version: 3,
    dimensions: { width: 20, height: 20 },
    floorMaterialID: 'grass-meadow',
    light: { indoor: false, brightness: 100 },
    objects: [],
    collisionMasks: [],
    portals: [],
    npcs: [],
    monsterSpawns: [],
    floorPatches: [],
    ...overrides,
  }
}

function entity(overrides: Partial<WorldEntity> = {}): WorldEntity {
  return {
    id: 1,
    kind: 'player',
    figure: 1,
    gender: 0,
    position: { x: 1000, y: 1000 },
    facing: FORWARD_FACING,
    tempo: 2,
    maskSize: { width: 32, height: 48 },
    name: 'Tester',
    ...overrides,
  }
}

interface Rig {
  predictor: GameplayPredictor
  session: PredictorSession & {
    connectionState: ConnectionState
    presentedOverlay: OverlayKind | undefined
    isChatInputFocused: boolean
  }
  sent: SomnioMessage[]
  held: HeldKeys
  /** Cursor-derived facing; `undefined` leaves the entity's own facing alone. */
  mouseFacing: number | undefined
  gateWrites: boolean[]
  self(): WorldEntity
  positionsRendered: { x: number; y: number }[]
}

function makeRig(
  options: {
    sector?: Sector
    entities?: WorldEntity[]
    held?: HeldKeys
    renderSurface?: WorldRenderSurface
  } = {}
): Rig {
  const entities = new Map<number, WorldEntity>()
  for (const each of options.entities ?? [entity()]) entities.set(each.id, each)
  const sent: SomnioMessage[] = []
  const gateWrites: boolean[] = []
  const positionsRendered: { x: number; y: number }[] = []

  // Typed through the mutable shape the rig exposes, so a test assigning a bogus state or overlay is
  // a compile error rather than a silently-closed gate.
  const session: Rig['session'] = {
    connectionState: 'attached',
    presentedOverlay: undefined,
    isChatInputFocused: false,
    entities,
    selfEntityIndex: 1,
    currentSector: options.sector ?? sectorFromWire(wireSector()),
  }

  const rig: Rig = {
    predictor: undefined as unknown as GameplayPredictor,
    session,
    sent,
    held: options.held ?? HELD_W,
    mouseFacing: undefined,
    gateWrites,
    self: () => {
      const found = entities.get(1)
      if (found === undefined) throw new Error('self entity missing')
      return found
    },
    positionsRendered,
  }

  const renderSurface: WorldRenderSurface = options.renderSurface ?? {
    ...noopRenderSurface,
    updateSubpixelPosition: (_id, position) => {
      positionsRendered.push({ x: position.x, y: position.y })
    },
  }

  rig.predictor = new GameplayPredictor({
    session,
    input: {
      snapshot: () => rig.held,
      setGameplayActive: (active) => gateWrites.push(active),
    },
    renderSurface,
    send: (message) => sent.push(message),
    mouseFacing: () => rig.mouseFacing,
  })
  return rig
}

/** Runs the priming tick plus `steps` further ticks spaced `stepMs` apart. */
function runTicks(rig: Rig, steps: number, stepMs: number): void {
  rig.predictor.runTick(0)
  for (let index = 1; index <= steps; index += 1) {
    rig.predictor.runTick(index * stepMs)
  }
}

describe('elapsed-time handling', () => {
  it('does not move on the first tick, having no previous timestamp to measure from', () => {
    const rig = makeRig()

    rig.predictor.runTick(0)

    expect(rig.self().position).toEqual({ x: 1000, y: 1000 })
  })

  it('walks the Swift-computed path over four 16 ms ticks', () => {
    const rig = makeRig()

    runTicks(rig, 4, 16)

    // Swift, held W at tempo `default` from (1000, 1000):
    //   tick 1 -> (999, 999)   tick 2 -> (998, 997)
    //   tick 3 -> (997, 996)   tick 4 -> (996, 995)
    expect(rig.self().position).toEqual({ x: 996, y: 995 })
  })

  it('carries the sub-pixel remainder Swift carries', () => {
    const rig = makeRig()

    rig.predictor.runTick(0)
    rig.predictor.runTick(16)

    // Dropping this carry truncates every tick's fraction, producing a systematic speed deficit
    // that reads as "slightly slow" and that no manual walk reveals.
    expect(rig.predictor._movementRemainder.dx).toBeCloseTo(0.08227770183832628, 15)
    expect(rig.predictor._movementRemainder.dy).toBeCloseTo(-0.31064327086238697, 15)
  })

  it('advances by the same distance whether one 100 ms tick or a 5 s stall is reported', () => {
    const stalled = makeRig()
    const clamped = makeRig()

    stalled.predictor.runTick(0)
    stalled.predictor.runTick(5000)
    clamped.predictor.runTick(0)
    clamped.predictor.runTick(MAX_TICK_ELAPSED_MS)

    // Swift clamps a single tick to 100 ms, landing on (994, 992) either way. Without the clamp
    // the stalled rig would teleport roughly 50x further.
    expect(stalled.self().position).toEqual({ x: 994, y: 992 })
    expect(clamped.self().position).toEqual(stalled.self().position)
  })

  it('scales the step by tempo', () => {
    const rig = makeRig({ held: { ...HELD_W, leftShift: true } })

    runTicks(rig, 3, 100)

    // Swift at run tempo (150 px/s), 100 ms ticks: (991, 988) -> (983, 975) -> (974, 963).
    expect(rig.self().position).toEqual({ x: 974, y: 963 })
  })

  it('renders the sub-pixel position rather than the rounded grid position', () => {
    const rig = makeRig()

    rig.predictor.runTick(0)
    rig.predictor.runTick(16)

    const rendered = rig.positionsRendered.at(-1)
    // 999 + 0.0822777..., 999 + (-0.3106432...). A renderer fed only the integer position shows
    // left/right jitter, because a screen-straight walk alternates world directions tick to tick.
    expect(rendered?.x).toBeCloseTo(999.0822777018383, 12)
    expect(rendered?.y).toBeCloseTo(998.689356729138, 12)
  })
})

describe('collision resolution', () => {
  /**
   * A mask covering the pixels immediately west of the player's feet box. The X candidate's feet
   * overlap it; the Y candidate's do not, because the feet box's left edge sits exactly on the
   * mask's exclusive right edge.
   */
  const westWall = { x: 990, y: 1020, width: 10, height: 40 }

  it('slides along a blocked axis instead of sticking', () => {
    const rig = makeRig({ sector: sectorFromWire(wireSector({ collisionMasks: [westWall] })) })

    rig.predictor.runTick(0)
    rig.predictor.runTick(16)

    // X is refused, Y commits. Testing both axes against the *origin* instead of resolving X
    // first would let the diagonal step cut the corner.
    expect(rig.self().position).toEqual({ x: 1000, y: 999 })
  })

  it('drops the carried fraction only on the axis collision cut', () => {
    const rig = makeRig({ sector: sectorFromWire(wireSector({ collisionMasks: [westWall] })) })

    rig.predictor.runTick(0)
    rig.predictor.runTick(16)

    // Keeping the X carry would let it accumulate against the wall and then release as a jump the
    // moment the player steps clear of it.
    expect(rig.predictor._movementRemainder.dx).toBe(0)
    expect(rig.predictor._movementRemainder.dy).toBeCloseTo(-0.31064327086238697, 15)
  })

  it('treats a peer as solid', () => {
    // Feet boxes flush along the exclusive edge: no overlap now, overlap after one step west.
    const peer = entity({ id: 2, kind: 'peer', position: { x: 968, y: 1000 }, name: 'Peer' })
    const rig = makeRig({ entities: [entity(), peer] })

    rig.predictor.runTick(0)
    rig.predictor.runTick(16)

    // X is refused by the peer, Y still commits — a peer is a wall you slide along, not one you
    // walk through.
    expect(rig.self().position).toEqual({ x: 1000, y: 999 })
  })

  it('lets the player slide free of a monster already overlapping their feet box', () => {
    const overlapping = entity({ id: 3, kind: 'monster', position: { x: 1000, y: 1000 } })
    const rig = makeRig({ entities: [entity(), overlapping] })

    rig.predictor.runTick(0)
    rig.predictor.runTick(16)

    // Soft-solid: a hard block here would trap the player with no escape, because monsters move
    // on the 50 ms AI tick and can lag onto the player's own box.
    expect(rig.self().position).toEqual({ x: 999, y: 999 })
  })

  it('blocks a monster the player is clear of', () => {
    const playerFeet = { x: 1000, y: 1032, width: 32, height: 16 }
    const clear = entity({ id: 3, kind: 'monster', position: { x: 900, y: 900 } })
    const overlapping = entity({ id: 4, kind: 'monster', position: { x: 1000, y: 1000 } })

    // The distinction is the whole of "soft-solid": one is a blocker, the other is dropped.
    expect(entityBlockers([clear], 1, playerFeet)).toHaveLength(1)
    expect(entityBlockers([overlapping], 1, playerFeet)).toHaveLength(0)
  })

  it('excludes NPCs from the movement blocker set so the slide reaches their feet box', () => {
    const npc = entity({ id: 5, kind: 'npc', position: { x: 968, y: 1000 }, name: 'Wirt' })

    // If NPCs blocked movement the step would stop one pixel short, the feet boxes would never
    // overlap, and the bump would never fire.
    expect(entityBlockers([npc], 1, { x: 1000, y: 1032, width: 32, height: 16 })).toEqual([])
  })

  it('resolves each axis against the already-resolved X', () => {
    const sector = sectorFromWire(wireSector({ collisionMasks: [westWall] }))

    const resolved = resolvedMove({ x: 1000, y: 1000 }, { x: 999, y: 999 }, sector, [])

    expect(resolved).toEqual({ x: 1000, y: 999 })
  })
})

describe('triggers', () => {
  /**
   * An `arrivalPlacement` portal first, so a filtered re-enumeration of only the triggers would
   * report index 0 for the second one.
   */
  const portals = [
    {
      direction: PORTAL_DIRECTIONS.arrivalPlacement,
      x: 0,
      y: 0,
      width: 32,
      height: 32,
      targetSectorName: 'nordwiese',
    },
    {
      direction: PORTAL_DIRECTIONS.outboundTrigger,
      x: 960,
      y: 1000,
      width: 64,
      height: 64,
      targetSectorName: 'nordwald',
    },
  ]

  it('sends the portal offset within the full portals array', () => {
    const rig = makeRig({ sector: sectorFromWire(wireSector({ portals })) })

    rig.predictor.runTick(0)
    rig.predictor.runTick(16)

    const entered = rig.sent.filter((message) => message.tag === 'enterPortal')
    expect(entered).toHaveLength(1)
    // The server indexes `staticSector.portals[portalIndex]` against the *full* array. Reporting 0
    // here — the offset within the filtered trigger list — teleports the player through the wrong
    // portal, or gets rejected as a `snapBack`.
    expect(entered[0]?.tag === 'enterPortal' && entered[0].payload.portalIndex).toBe(1)
  })

  it('latches the portal so one contact fires exactly one switch', () => {
    const rig = makeRig({ sector: sectorFromWire(wireSector({ portals })) })

    runTicks(rig, 4, 16)

    expect(rig.sent.filter((message) => message.tag === 'enterPortal')).toHaveLength(1)
  })

  it('suppresses the position heartbeat on the tick a portal fires', () => {
    const rig = makeRig({ sector: sectorFromWire(wireSector({ portals })) })

    rig.predictor.runTick(0)
    const beforePortal = rig.sent.filter((message) => message.tag === 'clientPosition').length
    rig.predictor.runTick(16)

    // A trailing `clientPosition` would apply old-sector coordinates in the new sector, snapping
    // the player off the arrival placement.
    expect(rig.sent.filter((message) => message.tag === 'clientPosition')).toHaveLength(beforePortal)
  })

  it('re-sends the NPC bump every overlapping tick, with no latch', () => {
    const npc = entity({ id: 7, kind: 'npc', position: { x: 968, y: 1000 }, name: 'Wirt' })
    const rig = makeRig({ entities: [entity(), npc] })

    runTicks(rig, 3, 16)

    const bumps = rig.sent.filter((message) => message.tag === 'bumpNPC')
    // Continuous rather than latched: the server's `targetingEntity` gate makes repeats no-ops,
    // and the faithful legacy behaviour re-sent at tick rate.
    expect(bumps.length).toBeGreaterThan(1)
    expect(bumps.every((message) => message.tag === 'bumpNPC' && message.payload.npcIndex === 7)).toBe(true)
  })

  it('blocks the step at the NPC threshold', () => {
    const npc = entity({ id: 7, kind: 'npc', position: { x: 968, y: 1000 }, name: 'Wirt' })
    const rig = makeRig({ entities: [entity(), npc] })

    runTicks(rig, 3, 16)

    // Blocked at the threshold, so the player stops against the NPC rather than through it.
    expect(rig.self().position).toEqual({ x: 1000, y: 1000 })
  })
})

describe('emission gates', () => {
  /**
   * A count, not a pattern match: this is the assertion that catches a tick emitting on every
   * frame. Over two seconds of 16 ms ticks a 2 Hz heartbeat produces the priming emit plus one
   * per interval; an ungated tick would produce 126.
   */
  it('emits position at 2 Hz over a fixed interval', () => {
    const rig = makeRig()

    runTicks(rig, 125, 16)

    const emits = rig.sent.filter((message) => message.tag === 'clientPosition')
    // t = 0 (first change, nothing throttling it yet), then 512, 1024, 1536.
    expect(emits).toHaveLength(4)
    expect(POSITION_HEARTBEAT_INTERVAL_MS).toBe(500)
  })

  /**
   * The facing threshold needs its own pair of assertions, because a count alone cannot
   * distinguish a 1-degree threshold from 0 or 10 unless the driven sequence happens to straddle
   * it. Both rigs are stationary so position and tempo cannot be what changes.
   */
  it('does not emit for a sub-threshold facing change', () => {
    const rig = makeRig({ held: noHeldKeys() })
    rig.mouseFacing = 90
    rig.predictor.runTick(0)
    const baseline = rig.sent.length

    rig.mouseFacing = 90.5
    rig.predictor.runTick(1000)

    // Swift's `angularDistance(90 -> 90.5)` is 0.5, at or under the threshold. Without this gate a
    // cursor jittering by fractions of a degree reports on every heartbeat.
    expect(rig.sent).toHaveLength(baseline)
  })

  it('emits exactly once for a super-threshold facing change', () => {
    const rig = makeRig({ held: noHeldKeys() })
    rig.mouseFacing = 90
    rig.predictor.runTick(0)
    const baseline = rig.sent.length

    rig.mouseFacing = 91.5
    rig.predictor.runTick(1000)

    // `angularDistance(90 -> 91.5)` is 1.5, past the threshold.
    expect(rig.sent).toHaveLength(baseline + 1)
    expect(FACING_EMIT_THRESHOLD_DEGREES).toBe(1)
  })

  it('measures the facing delta across the 0/360 seam', () => {
    const rig = makeRig({ held: noHeldKeys() })
    rig.mouseFacing = 359.5
    rig.predictor.runTick(0)
    const baseline = rig.sent.length

    rig.mouseFacing = 0.5
    rig.predictor.runTick(1000)

    // The real turn is 1 degree, not 359. A naive subtraction would report every seam crossing.
    expect(rig.sent).toHaveLength(baseline)
  })

  it('reports the final position after a throttled move rather than dropping it', () => {
    const rig = makeRig()

    // t = 512 is the first tick past the 500 ms interval, so the final tick here is an emit.
    runTicks(rig, 32, 16)

    const emits = rig.sent.filter((message) => message.tag === 'clientPosition')
    const last = emits.at(-1)
    // The last-emitted snapshot is deliberately left unchanged while throttled, so the next tick
    // past the interval still sees the move as pending.
    expect(last?.tag === 'clientPosition' && last.payload.x).toBe(rig.self().position.x)
    expect(last?.tag === 'clientPosition' && last.payload.y).toBe(rig.self().position.y)
  })

  it('always reports entity index 0, the server-side self alias', () => {
    const rig = makeRig()

    runTicks(rig, 1, 16)

    const emit = rig.sent.find((message) => message.tag === 'clientPosition')
    expect(emit?.tag === 'clientPosition' && emit.payload.entityIndex).toBe(0)
  })
})

describe('the input gate', () => {
  it('is open while attached with no overlay and no chat focus', () => {
    const rig = makeRig()

    rig.predictor.runTick(0)

    expect(rig.gateWrites).toEqual([true])
  })

  it('stays open through a sector hop so held keys survive', () => {
    const rig = makeRig()
    rig.session.connectionState = 'awaitingEnterSector'

    rig.predictor.runTick(0)

    // The `selfEntityIndex` guard is what stops movement in the gap, not the gate — keys keep
    // being consumed and held WASD resumes motion on arrival.
    expect(rig.gateWrites).toEqual([true])
  })

  it('closes while an overlay is presented', () => {
    const rig = makeRig()
    rig.session.presentedOverlay = { kind: 'gameMenu' }

    rig.predictor.runTick(0)

    expect(rig.gateWrites).toEqual([false])
  })

  it('closes while the chat input is focused', () => {
    const rig = makeRig()
    rig.session.isChatInputFocused = true

    rig.predictor.runTick(0)

    expect(rig.gateWrites).toEqual([false])
  })

  it('closes when disconnected', () => {
    const rig = makeRig()
    rig.session.connectionState = 'awaitingLoginResult'

    rig.predictor.runTick(0)

    expect(rig.gateWrites).toEqual([false])
  })

  it('keeps reporting the gate closed across ticks while an overlay is up', () => {
    const rig = makeRig()
    rig.session.presentedOverlay = { kind: 'gameMenu' }
    // Only the gate *write* is asserted, deliberately. `runTick` returns early on chat focus but not
    // on an overlay, and this rig's stub sink keeps reporting the held key, so the character does
    // move here by design — there is no position to assert. That the production sampler clears its
    // bitset when the gate closes is covered in `browser-host.test.ts`, which drives a real
    // `KeyboardSampler`; the earlier comment here claimed a position check this test never had.
    rig.predictor.runTick(0)
    rig.predictor.runTick(16)

    expect(rig.gateWrites).toEqual([false, false])
  })

  it('returns before touching the world while chat is focused', () => {
    const rig = makeRig()
    rig.session.isChatInputFocused = true

    rig.predictor.runTick(0)
    rig.predictor.runTick(16)

    expect(rig.self().position).toEqual({ x: 1000, y: 1000 })
    expect(rig.sent).toHaveLength(0)
  })
})

describe('reset', () => {
  it('drops the carry, the clocks, and the portal latch', () => {
    const rig = makeRig()
    runTicks(rig, 4, 16)

    rig.predictor.reset()
    rig.predictor.runTick(1000)

    // A carried remainder or a stale tick timestamp would bias the first tick in a new sector; a
    // stale portal latch would hold the arrival portal shut.
    expect(rig.predictor._movementRemainder).toEqual({ dx: 0, dy: 0 })
    expect(rig.self().position).toEqual({ x: 996, y: 995 })
  })
})

describe('velocity', () => {
  it('normalizes a diagonal so eight-way movement is not faster', () => {
    const diagonal = velocityFromHeld({ ...noHeldKeys(), w: true, d: true })

    expect(Math.hypot(diagonal.dx, diagonal.dy)).toBeCloseTo(1, 12)
  })

  it('cancels opposing keys to a standstill', () => {
    expect(velocityFromHeld({ ...noHeldKeys(), a: true, d: true })).toEqual({ dx: 0, dy: 0 })
  })
})
