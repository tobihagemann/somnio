import { describe, expect, it } from 'vitest'
import {
  CLOSE_GOING_AWAY,
  CLOSE_POLICY_VIOLATION,
  CLOSE_PROTOCOL_ERROR,
  ConnectionActor,
} from '../src/connection/connectionActor.ts'
import type { ConnectionSocket } from '../src/connection/connectionActor.ts'
import { makeStubConnectionDependencies } from './support/stubDependencies.ts'

/** Recording, blocking sink: one selected send parks until the test releases it. */
class BlockingSocket implements ConnectionSocket {
  readonly events: string[] = []
  closeInfo: { code: number; reason: string } | undefined
  private writeCount = 0
  private readonly gateOnWrite: number
  private release: (() => void) | undefined
  private parkedResolve: (() => void) | undefined
  private messageListener: ((data: string | Uint8Array, isBinary: boolean) => void) | undefined
  private closeListener: (() => void) | undefined

  constructor(gateOnWrite: number) {
    this.gateOnWrite = gateOnWrite
  }

  async send(): Promise<void> {
    this.writeCount += 1
    if (this.writeCount === this.gateOnWrite) {
      await new Promise<void>((resolve) => {
        this.release = resolve
        this.parkedResolve?.()
      })
    }
    this.events.push('write')
  }

  close(code: number, reason: string): void {
    this.closeInfo = { code, reason }
    this.events.push('close')
  }

  pause(): void {}
  resume(): void {}

  onMessage(listener: (data: string | Uint8Array, isBinary: boolean) => void): void {
    this.messageListener = listener
  }

  onClose(listener: () => void): void {
    this.closeListener = listener
  }

  waitUntilParked(): Promise<void> {
    if (this.release !== undefined) return Promise.resolve()
    return new Promise((resolve) => {
      this.parkedResolve = resolve
    })
  }

  releaseGate(): void {
    this.release?.()
  }

  deliver(text: string): void {
    this.messageListener?.(text, false)
  }

  peerClose(): void {
    this.closeListener?.()
  }
}

describe('drain before close', () => {
  it.each([1, 3])(
    'every queued frame lands before the close frame (gate on write %i)',
    async (gateOnWrite) => {
      const socket = new BlockingSocket(gateOnWrite)
      const connection = new ConnectionActor(await makeStubConnectionDependencies())
      const run = connection.runConnection(socket)
      // The hello is frame 1; three more make four.
      for (let index = 0; index < 3; index += 1) connection.outbox.send(`frame-${index}`)
      await socket.waitUntilParked()
      // A malformed inbound frame drives the protocol-error exit while the writer is parked.
      socket.deliver('not json')
      socket.releaseGate()
      await run
      expect(socket.events).toEqual(['write', 'write', 'write', 'write', 'close'])
      expect(socket.closeInfo).toEqual({ code: CLOSE_PROTOCOL_ERROR, reason: 'frame validation failed' })
    }
  )

  it('the writer closes with policyViolation after draining when the outbox overflows', async () => {
    const watermark = 4
    const socket = new BlockingSocket(1)
    const connection = new ConnectionActor(
      await makeStubConnectionDependencies({ outboxHighWatermark: watermark })
    )
    const run = connection.runConnection(socket)
    await socket.waitUntilParked()
    // The hello holds one inflight slot; `watermark` more sends push past the watermark.
    for (let index = 0; index < watermark; index += 1) connection.outbox.send(`frame-${index}`)
    expect(connection.outbox.overflowed).toBe(true)
    socket.releaseGate()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(socket.closeInfo).toEqual({ code: CLOSE_POLICY_VIOLATION, reason: 'outbox overflow' })
    expect(socket.events).toEqual([...Array<string>(watermark).fill('write'), 'close'])
    socket.peerClose()
    await run
  })

  it('an admin kick maps keepOpen to a goingAway close after the hello drains', async () => {
    const socket = new BlockingSocket(0)
    const connection = new ConnectionActor(await makeStubConnectionDependencies())
    const run = connection.runConnection(socket)
    await new Promise((resolve) => setImmediate(resolve))
    connection.disconnectForAdminKick()
    await run
    expect(socket.closeInfo).toEqual({ code: CLOSE_GOING_AWAY, reason: 'connection closed' })
    expect(socket.events).toEqual(['write', 'close'])
  })
})
