import { afterEach, describe, expect, it } from 'vitest'
import { encodeAdminRequest } from '@somnio/protocol'
import { processAdminText } from '../src/admin/adminConnection.ts'
import { makeAdminDependencies } from './support/adminDependencies.ts'
import { tempLogging } from './support/tempLogging.ts'

const logging = tempLogging()
afterEach(() => logging.cleanup())

describe('processAdminText', () => {
  it('unrecognized verb yields write unknownCommand and keeps the loop open', async () => {
    const outcome = processAdminText('{"tag":"bogus"}', await makeAdminDependencies({ logging }))
    expect(outcome).toEqual({ kind: 'write', response: { tag: 'unknownCommand' } })
  })

  it('a well-formed players request yields write playerCount', async () => {
    const outcome = processAdminText(
      encodeAdminRequest({ tag: 'players' }),
      await makeAdminDependencies({ logging })
    )
    expect(outcome).toEqual({ kind: 'write', response: { tag: 'playerCount', payload: '0' } })
  })

  it('malformed JSON closes with protocolError', async () => {
    const outcome = processAdminText('{ not json', await makeAdminDependencies({ logging }))
    expect(outcome).toEqual({ kind: 'closeProtocolError', reason: 'frame validation failed' })
  })

  it('a known verb missing its payload closes with protocolError', async () => {
    const outcome = processAdminText('{"tag":"say"}', await makeAdminDependencies({ logging }))
    expect(outcome.kind).toBe('closeProtocolError')
  })

  it('an empty say is ignored without a response', async () => {
    const outcome = processAdminText(
      encodeAdminRequest({ tag: 'say', payload: '' }),
      await makeAdminDependencies({ logging })
    )
    expect(outcome).toEqual({ kind: 'ignore' })
  })
})
