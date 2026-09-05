import { describe, expect, it } from 'vitest'
import { ConnectionActor } from '../src/connection/connectionActor.ts'
import { makeStubConnectionDependencies } from './support/stubDependencies.ts'

describe('ConnectionActor state primitives', () => {
  it('setAttached replaces entityIndex and sectorName while preserving accountId', async () => {
    const connection = new ConnectionActor(await makeStubConnectionDependencies())
    const accountId = crypto.randomUUID()
    connection.markAttached(1, 'EdariaBibliothek', accountId)
    connection.setAttached(7, 'EdariaArena')
    expect(connection.state).toEqual({
      kind: 'attached',
      entityIndex: 7,
      sectorName: 'EdariaArena',
      accountId,
    })
  })

  it('setAttached is a no-op while the connection is awaitingLogin', async () => {
    const connection = new ConnectionActor(await makeStubConnectionDependencies())
    connection.setAttached(99, 'Phantom')
    expect(connection.state).toEqual({ kind: 'awaitingLogin' })
  })

  it('disconnectForAdminKick is a no-op when there is no active read loop', async () => {
    const connection = new ConnectionActor(await makeStubConnectionDependencies())
    connection.disconnectForAdminKick()
    expect(connection.state).toEqual({ kind: 'awaitingLogin' })
  })
})
