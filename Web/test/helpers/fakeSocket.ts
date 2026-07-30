import type { GameplaySocket, GameplaySocketFactory, GameplaySocketHandlers } from '@/transport'

/**
 * Controllable socket for the headless suites. Records every outbound frame **as the string it
 * was actually sent as**, which is what lets a test assert the production chain emits text
 * rather than binary.
 */
export class FakeSocket implements GameplaySocket {
  readonly sent: string[] = []
  readonly closes: { code?: number; reason?: string }[] = []
  /**
   * Sends and closes in one sequence, because `sent` and `closes` are independent arrays and their
   * relative order — which is the invariant the transport's class doc is about — cannot be read off
   * two of them. A test asserting only their lengths passes with the operations swapped.
   */
  readonly log: ('send' | 'close')[] = []
  private readonly handlers: GameplaySocketHandlers

  constructor(handlers: GameplaySocketHandlers) {
    this.handlers = handlers
  }

  send(text: string): void {
    this.sent.push(text)
    this.log.push('send')
  }

  close(code?: number, reason?: string): void {
    this.closes.push({ ...(code === undefined ? {} : { code }), ...(reason === undefined ? {} : { reason }) })
    this.log.push('close')
  }

  open(): void {
    this.handlers.onOpen()
  }

  deliverText(text: string): void {
    this.handlers.onText(text)
  }

  deliverBinary(): void {
    this.handlers.onBinary()
  }

  deliverClose(): void {
    this.handlers.onClose()
  }

  deliverError(error: unknown = new Error('handshake failed')): void {
    this.handlers.onError(error)
  }
}

export function fakeSocketFactory(): {
  factory: GameplaySocketFactory
  latest: () => FakeSocket
  all: FakeSocket[]
} {
  const all: FakeSocket[] = []
  const factory: GameplaySocketFactory = (_url, handlers) => {
    const socket = new FakeSocket(handlers)
    all.push(socket)
    return socket
  }
  return {
    factory,
    latest: () => {
      const socket = all.at(-1)
      if (socket === undefined) throw new Error('no socket was created')
      return socket
    },
    all,
  }
}
