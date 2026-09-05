import type { SomnioMessage } from '@somnio/protocol'
import type { Logger } from '../logging.ts'
import { encodeOrWarn } from './encodeFrame.ts'

/**
 * Enqueue-only mailbox the per-sector actor pushes broadcasts into. `send` never blocks; once the
 * in-flight count exceeds the high watermark the outbox marks itself overflowed and finishes, so
 * the writer drains what is queued and closes the socket with `outbox overflow` rather than
 * back-pressuring the sector's broadcast loop on one slow client.
 */
export class ConnectionOutbox {
  private readonly highWatermark: number
  private readonly queue: string[] = []
  private inflight = 0
  private finished = false
  private overflowedFlag = false
  private wake: (() => void) | undefined

  constructor(highWatermark: number) {
    this.highWatermark = highWatermark
  }

  send(frame: string): void {
    if (this.finished || this.overflowedFlag) return
    this.inflight += 1
    if (this.inflight > this.highWatermark) {
      this.overflowedFlag = true
      this.finished = true
      this.notify()
      return
    }
    this.queue.push(frame)
    this.notify()
  }

  sendEncoded(message: SomnioMessage, logger: Logger): void {
    const frame = encodeOrWarn(message, logger)
    if (frame !== undefined) this.send(frame)
  }

  /** Called by the writer after each frame lands, so `inflight` tracks the queue depth. */
  recordWrite(): void {
    this.inflight = Math.max(0, this.inflight - 1)
  }

  finish(): void {
    this.finished = true
    this.notify()
  }

  get overflowed(): boolean {
    return this.overflowedFlag
  }

  /** Yields queued frames until the outbox is finished and drained. */
  async *[Symbol.asyncIterator](): AsyncGenerator<string> {
    while (true) {
      const next = this.queue.shift()
      if (next !== undefined) {
        yield next
        continue
      }
      if (this.finished) return
      await new Promise<void>((resolve) => {
        this.wake = resolve
      })
    }
  }

  private notify(): void {
    const wake = this.wake
    this.wake = undefined
    wake?.()
  }
}

/** Drains a finished outbox to completion; a live outbox never returns. */
export async function collectOutbox(outbox: ConnectionOutbox): Promise<string[]> {
  const frames: string[] = []
  for await (const frame of outbox) frames.push(frame)
  return frames
}
