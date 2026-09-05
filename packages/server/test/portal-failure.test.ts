import { describe, expect, it } from 'vitest'
import { SOMNIO_PROTOCOL_CONSTANTS } from '@somnio/protocol'
import type { SectorObject } from '@somnio/core'
import { ConnectionActor } from '../src/connection/connectionActor.ts'
import { PORTAL_LOST, handleEnterPortal } from '../src/handlers/gameplay.ts'
import { collectMessages } from './support/frames.ts'
import { makeCharacter, makeSector } from './support/sectorFactory.ts'
import { makeStubConnectionDependencies } from './support/stubDependencies.ts'

/** One object carrying more than `maxFrameLength` of `modelID` makes the destination's `enterSector` encode throw. */
const oversized: SectorObject = {
  x: 0,
  y: 0,
  modelID: 'a'.repeat(SOMNIO_PROTOCOL_CONSTANTS.maxFrameLength + 1),
  sourceWidth: 32,
  sourceHeight: 32,
  priority: 0,
  rotation: 0,
}

const portalToB = {
  x: 0,
  y: 0,
  width: 256,
  height: 256,
  targetSectorName: 'B',
  direction: 'outboundTrigger' as const,
}

describe('a portal hop whose destination cannot attach', () => {
  it('puts the player back in the source sector under a live index', async () => {
    const dependencies = await makeStubConnectionDependencies({
      sectors: new Map([
        ['A', makeSector('A', { portals: [portalToB] })],
        ['B', makeSector('B', { objects: [oversized] })],
      ]),
    })
    const sectorA = dependencies.worldRouter.sector('A')!
    const sectorB = dependencies.worldRouter.sector('B')!
    const connection = new ConnectionActor(dependencies)
    const accountId = crypto.randomUUID()
    dependencies.worldRouter.register(connection, accountId, 'hopper')
    const index = sectorA.attach(makeCharacter({ x: 64, y: 64 }, 'hopper', 'A'), [], connection.outbox)
    connection.markAttached(index, 'A', accountId)

    const outcome = handleEnterPortal({ portalIndex: 0 }, index, 'A', connection, dependencies)

    expect(outcome).not.toBe(PORTAL_LOST)
    expect(outcome).toMatchObject({ sectorName: 'A' })
    const restoredIndex = (outcome as { entityIndex: number }).entityIndex
    expect(sectorA.snapshotForPlayer(restoredIndex)?.character.name).toBe('hopper')
    expect(sectorB.snapshotForCheckpoint()).toEqual([])
    // The client reloads on the second `enterSector`, which is what puts the restored slot on screen.
    const tags = (await collectMessages(connection.outbox)).map((message) => message.tag)
    expect(tags.filter((tag) => tag === 'enterSector').length).toBe(2)
  })
})
