import { describe, expect, it } from 'vitest'
import type { NPCDialogState } from '@somnio/core'
import type { NPCDialogStateKey } from '@somnio/data'
import { ConnectionActor } from '../src/connection/connectionActor.ts'
import { ConnectionOutbox, collectOutbox } from '../src/connection/outbox.ts'
import { WorldRouter } from '../src/world/worldRouter.ts'
import { collectMessages, serverSays } from './support/frames.ts'
import { testLogger } from './support/logger.ts'
import { makeCharacter, makeNPC, makeSector } from './support/sectorFactory.ts'
import { makeStubConnectionDependencies } from './support/stubDependencies.ts'
import {
  RepositoryFailure,
  StubCharacterRepository,
  StubNPCDialogStateRepository,
} from './support/stubRepositories.ts'

class RecordingDialogRepository extends StubNPCDialogStateRepository {
  readonly upserted: NPCDialogState[] = []
  readonly resets: NPCDialogStateKey[] = []
  readonly rows: NPCDialogState[]
  nextUpsertThrows = false
  nextResetThrows = false
  upsertCalls = 0
  resetCalls = 0

  constructor(rows: NPCDialogState[] = []) {
    super()
    this.rows = rows
  }

  override loadAll(sectorName: string): Promise<NPCDialogState[]> {
    return Promise.resolve(this.rows.filter((row) => row.sectorName === sectorName))
  }

  override upsert(state: NPCDialogState): Promise<void> {
    this.upsertCalls += 1
    if (this.nextUpsertThrows) {
      this.nextUpsertThrows = false
      return Promise.reject(new RepositoryFailure())
    }
    this.upserted.push(state)
    return Promise.resolve()
  }

  override reset(sectorName: string, npcIndex: number): Promise<void> {
    this.resetCalls += 1
    if (this.nextResetThrows) {
      this.nextResetThrows = false
      return Promise.reject(new RepositoryFailure())
    }
    this.resets.push({ sectorName, npcIndex })
    return Promise.resolve()
  }
}

function sectorWithScript(name: string, dialogScript: string) {
  return makeSector(name, { npcs: [makeNPC({ x: 0, y: 0 }, dialogScript)] })
}

async function routerOver(
  sectors: Map<string, ReturnType<typeof makeSector>>,
  dialogRepo = new RecordingDialogRepository()
) {
  return WorldRouter.create(sectors, new StubCharacterRepository(), dialogRepo, testLogger())
}

function bump(router: WorldRouter, sectorName: string, playerName: string) {
  const sector = router.sector(sectorName)!
  const outbox = new ConnectionOutbox(1024)
  const entityIndex = sector.attach(makeCharacter({ x: 1, y: 1 }, playerName, sectorName), [], outbox)
  sector.handleBumpNPC(1, entityIndex)
  return outbox
}

async function emptyRouterConnections(count: number) {
  const dependencies = await makeStubConnectionDependencies()
  const router = dependencies.worldRouter
  const connections = Array.from({ length: count }, () => ({
    actor: new ConnectionActor(dependencies),
    accountId: crypto.randomUUID(),
  }))
  return { router, connections }
}

describe('WorldRouter.runAITickAcrossSectors', () => {
  it('persists a single-step wrap reset and skips the empty-script no-op', async () => {
    const dialogRepo = new RecordingDialogRepository()
    const router = await routerOver(
      new Map([
        ['A', sectorWithScript('A', 'hi $name.')],
        ['B', sectorWithScript('B', '')],
      ]),
      dialogRepo
    )
    bump(router, 'A', 'alice')
    bump(router, 'B', 'bob')
    await router.runAITickAcrossSectors()
    expect(dialogRepo.upserted).toEqual([])
    expect(dialogRepo.resets).toEqual([{ sectorName: 'A', npcIndex: 1 }])
  })

  it('init pre-loads the persisted cursor from the repository', async () => {
    const dialogRepo = new RecordingDialogRepository([{ sectorName: 'A', npcIndex: 1, scriptStep: 2 }])
    const router = await routerOver(
      new Map([['A', sectorWithScript('A', 'first line.\n---\nsecond line.')]]),
      dialogRepo
    )
    const outbox = bump(router, 'A', 'alice')
    router.sector('A')!.runAITick()
    const says = serverSays(await collectMessages(outbox))
    expect(says).toContain('second line.')
    expect(says).not.toContain('first line.')
  })

  it('persists a non-final dialog upsert through the repository', async () => {
    const dialogRepo = new RecordingDialogRepository()
    const router = await routerOver(
      new Map([['A', sectorWithScript('A', 'first.\n---\nsecond.\n---\nthird.')]]),
      dialogRepo
    )
    bump(router, 'A', 'alice')
    await router.runAITickAcrossSectors()
    expect(dialogRepo.upserted).toEqual([{ sectorName: 'A', npcIndex: 1, scriptStep: 2 }])
  })

  it('tolerates a transient upsert failure', async () => {
    const dialogRepo = new RecordingDialogRepository()
    dialogRepo.nextUpsertThrows = true
    const router = await routerOver(
      new Map([['A', sectorWithScript('A', 'first.\n---\nsecond.\n---\nthird.')]]),
      dialogRepo
    )
    bump(router, 'A', 'alice')
    await router.runAITickAcrossSectors()
    await router.runAITickAcrossSectors()
    expect(dialogRepo.upsertCalls).toBeGreaterThanOrEqual(1)
  })

  it('tolerates a transient reset failure', async () => {
    const dialogRepo = new RecordingDialogRepository()
    dialogRepo.nextResetThrows = true
    const router = await routerOver(new Map([['A', sectorWithScript('A', 'Once: $name.')]]), dialogRepo)
    bump(router, 'A', 'alice')
    await router.runAITickAcrossSectors()
    await router.runAITickAcrossSectors()
    expect(dialogRepo.resetCalls).toBeGreaterThanOrEqual(1)
  })
})

describe('WorldRouter connections', () => {
  it('broadcastToAllConnections fans out an identical frame to every attached connection', async () => {
    const { router, connections } = await emptyRouterConnections(2)
    for (const { actor, accountId } of connections) {
      router.register(actor, accountId, `player-${accountId}`)
      actor.markAttached(1, 'X', accountId)
    }
    router.broadcastToAllConnections({ tag: 'dateTick', payload: { hour: 7, minute: 33 } })
    const frames = await Promise.all(
      connections.map(({ actor }) => {
        actor.outbox.finish()
        return collectOutbox(actor.outbox)
      })
    )
    expect(frames[0]!.length).toBe(1)
    expect(frames[1]!.length).toBe(1)
    expect(frames[0]![0]).toBe(frames[1]![0])
  })

  it('broadcastToAllConnections skips connections still awaiting login', async () => {
    const { router, connections } = await emptyRouterConnections(1)
    const { actor, accountId } = connections[0]!
    router.register(actor, accountId, 'TestPlayer')
    router.broadcastToAllConnections({ tag: 'dateTick', payload: { hour: 1, minute: 0 } })
    actor.outbox.finish()
    expect(await collectOutbox(actor.outbox)).toEqual([])
  })

  it('loggedInPlayerCount counts only attached connections', async () => {
    const { router, connections } = await emptyRouterConnections(2)
    const [attached, unattached] = connections
    router.register(attached!.actor, attached!.accountId, 'Alice')
    router.register(unattached!.actor, unattached!.accountId, 'Bob')
    attached!.actor.markAttached(1, 'X', attached!.accountId)
    expect(router.loggedInPlayerCount()).toBe(1)
  })

  it('register refuses a second connection for the same account', async () => {
    const { router, connections } = await emptyRouterConnections(2)
    const accountId = crypto.randomUUID()
    expect(router.register(connections[0]!.actor, accountId, 'Alice')).toBe(true)
    expect(router.register(connections[1]!.actor, accountId, 'Alice')).toBe(false)
  })

  it('kickByCharacterName returns false when nobody matches', async () => {
    const { router, connections } = await emptyRouterConnections(1)
    router.register(connections[0]!.actor, connections[0]!.accountId, 'Alice')
    expect(router.kickByCharacterName('Bob')).toBe(false)
  })

  it('kickByCharacterName normalizes case to match the schema collation', async () => {
    const { router, connections } = await emptyRouterConnections(1)
    router.register(connections[0]!.actor, connections[0]!.accountId, 'Saibot')
    expect(router.kickByCharacterName('saibot')).toBe(true)
  })

  it('kickByCharacterName matches NFKC compatibility equivalent names', async () => {
    const { router, connections } = await emptyRouterConnections(1)
    router.register(connections[0]!.actor, connections[0]!.accountId, 'Ｓａｉｂｏｔ')
    expect(router.kickByCharacterName('saibot')).toBe(true)
  })
})
