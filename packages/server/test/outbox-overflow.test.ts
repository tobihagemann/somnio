import { describe, expect, it } from 'vitest'
import { ConnectionOutbox, collectOutbox } from '../src/connection/outbox.ts'

describe('ConnectionOutbox', () => {
  it('sending past the high watermark trips overflow and finishes the stream', async () => {
    const watermark = 4
    const outbox = new ConnectionOutbox(watermark)
    for (let index = 0; index < watermark + 1; index += 1) outbox.send(`frame-${index}`)
    expect(outbox.overflowed).toBe(true)
    const received = await collectOutbox(outbox)
    expect(received.length).toBeLessThanOrEqual(watermark)
  })

  it("recordWrite decrements inflight so steady-state senders don't overflow", () => {
    const outbox = new ConnectionOutbox(2)
    outbox.send('1')
    outbox.send('2')
    expect(outbox.overflowed).toBe(false)
    outbox.recordWrite()
    outbox.send('3')
    expect(outbox.overflowed).toBe(false)
    outbox.send('4')
    expect(outbox.overflowed).toBe(true)
  })

  it('finish closes the outbox idempotently', async () => {
    const outbox = new ConnectionOutbox(1024)
    outbox.send('1')
    outbox.finish()
    outbox.finish()
    expect(await collectOutbox(outbox)).toEqual(['1'])
  })

  it('a send after finish is dropped', async () => {
    const outbox = new ConnectionOutbox(1024)
    outbox.finish()
    outbox.send('late')
    expect(await collectOutbox(outbox)).toEqual([])
  })
})
