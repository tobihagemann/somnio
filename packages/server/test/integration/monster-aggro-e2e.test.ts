import { describe, expect, it } from 'vitest'
import { WIRE_ENTITY_TYPE } from '@somnio/protocol'
import { SOMNIO_CONSTANTS, feetCenter, headingFromVector } from '@somnio/core'
import type { GridPoint } from '@somnio/core'
import { ConnectionOutbox } from '../../src/connection/outbox.ts'
import { PerSectorActor } from '../../src/world/perSectorActor.ts'
import { collectMessages, entities, serverPositions } from '../support/frames.ts'
import { testLogger } from '../support/logger.ts'
import { makeCharacter, makeMonsterSpawn, makeSector } from '../support/sectorFactory.ts'

/** Threshold 3 materializes exactly one monster in a 7-tick window: it spawns on tick 4, the next would be tick 8. */
const SPAWN_THRESHOLD = 3
const MONSTER_ORIGIN: GridPoint = { x: 200, y: 200 }
const MONSTER_SIZE = { width: 32, height: 48 }

function aggroActor(): PerSectorActor {
  return new PerSectorActor(
    makeSector('Aggro', {
      dimensions: { width: 8, height: 8 },
      monsterSpawns: [makeMonsterSpawn(MONSTER_ORIGIN)],
    }),
    { logger: testLogger(), monsterSpawnThreshold: SPAWN_THRESHOLD }
  )
}

/** Top-left of a player sprite whose feet center lands at `(x, y)`. */
function originForFeetCenter(x: number, y: number): GridPoint {
  return { x: x - 16, y: y - 40 }
}

const monsterCenter = feetCenter(MONSTER_ORIGIN, MONSTER_SIZE)

describe('monster aggro end to end', () => {
  it('idles when no player is within the aggro radius', async () => {
    const actor = aggroActor()
    const outbox = new ConnectionOutbox(4096)
    actor.attach(makeCharacter({ x: 900, y: 900 }, 'far', 'Aggro'), [], outbox)
    for (let tick = 0; tick < 7; tick += 1) actor.runAITick()
    const messages = await collectMessages(outbox)
    expect(entities(messages).some((entity) => entity.type === WIRE_ENTITY_TYPE.monster)).toBe(true)
    expect(serverPositions(messages)).toEqual([])
  })

  it('chases a player who enters the aggro radius', async () => {
    const actor = aggroActor()
    const outbox = new ConnectionOutbox(4096)
    const player = originForFeetCenter(monsterCenter.x + 150, monsterCenter.y)
    actor.attach(makeCharacter(player, 'near', 'Aggro'), [], outbox)
    for (let tick = 0; tick < 7; tick += 1) actor.runAITick()
    const chase = serverPositions(await collectMessages(outbox))
    expect(chase.length).toBeGreaterThanOrEqual(4)
    const target = feetCenter(player, SOMNIO_CONSTANTS.playerSpriteSize)
    const distances = chase.map((frame) => {
      const center = feetCenter({ x: frame.x, y: frame.y }, MONSTER_SIZE)
      return Math.hypot(center.x - target.x, center.y - target.y)
    })
    for (let index = 1; index < distances.length; index += 1) {
      expect(distances[index]).toBeLessThanOrEqual(distances[index - 1]!)
    }
    expect(distances.at(-1)!).toBeLessThan(Math.hypot(monsterCenter.x - target.x, monsterCenter.y - target.y))
  })

  it('targets the nearest of multiple players in the aggro radius', async () => {
    const actor = aggroActor()
    const outboxA = new ConnectionOutbox(4096)
    const outboxB = new ConnectionOutbox(4096)
    // A is 150 px due east, B 100 px due north: B is closer, so the monster faces exactly north.
    actor.attach(
      makeCharacter(originForFeetCenter(monsterCenter.x + 150, monsterCenter.y), 'a', 'Aggro'),
      [],
      outboxA
    )
    actor.attach(
      makeCharacter(originForFeetCenter(monsterCenter.x, monsterCenter.y - 100), 'b', 'Aggro'),
      [],
      outboxB
    )
    for (let tick = 0; tick <= SPAWN_THRESHOLD; tick += 1) actor.runAITick()
    const frame = serverPositions(await collectMessages(outboxA))[0]!
    expect(frame.facing).toBe(headingFromVector(0, -100))
    expect(frame.y).toBeLessThan(MONSTER_ORIGIN.y)
    expect(frame.x).toBe(MONSTER_ORIGIN.x)
  })

  it('stops chasing after the player leaves the aggro radius', async () => {
    const chasing = aggroActor()
    const chasingOutbox = new ConnectionOutbox(4096)
    chasing.attach(
      makeCharacter(originForFeetCenter(monsterCenter.x + 150, monsterCenter.y), 'near', 'Aggro'),
      [],
      chasingOutbox
    )
    for (let tick = 0; tick < 7; tick += 1) chasing.runAITick()
    expect(serverPositions(await collectMessages(chasingOutbox)).length).toBeGreaterThanOrEqual(4)

    const idle = aggroActor()
    const idleOutbox = new ConnectionOutbox(4096)
    idle.attach(makeCharacter({ x: 900, y: 900 }, 'far', 'Aggro'), [], idleOutbox)
    for (let tick = 0; tick < 7; tick += 1) idle.runAITick()
    expect(serverPositions(await collectMessages(idleOutbox))).toEqual([])
  })
})
