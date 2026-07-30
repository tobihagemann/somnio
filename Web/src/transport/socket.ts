/**
 * Minimal socket seam over the browser `WebSocket`.
 *
 * Two reasons this indirection exists rather than calling `WebSocket` directly. First, the
 * conformance suite has to drive the *production* encoder-to-socket chain and assert it emits
 * a **text** frame — a transport that quietly sent `ArrayBuffer` would pass every other check
 * while the Swift server closed on it. Second, the deterministic client tests need to feed
 * frames inbound without standing up a server.
 */
export interface GameplaySocket {
  send(text: string): void
  close(code?: number, reason?: string): void
}

export interface GameplaySocketHandlers {
  onOpen: () => void
  /** Text payloads only. A binary payload arrives through `onBinary`, never here. */
  onText: (text: string) => void
  onBinary: () => void
  onClose: () => void
  onError: (error: unknown) => void
}

export type GameplaySocketFactory = (url: string, handlers: GameplaySocketHandlers) => GameplaySocket

/**
 * Close codes the transport uses.
 *
 * The browser `WebSocket.close()` only accepts 1000 or the private 3000-4999 range — passing
 * 1002 (`protocolError`), which the Swift transport uses, throws `InvalidAccessError`. So the
 * protocol-error close is mapped into the private range instead. The code is informational
 * either way: the server's read loop treats any close as a close, and the frame that caused it
 * has already been rejected locally.
 */
export const CLOSE_CODE = {
  normal: 1000,
  /** Stands in for the Swift transport's `.protocolError`, which browsers forbid. */
  protocolError: 4002,
} as const

/** Production factory. Binary frames are surfaced, not decoded — the protocol is text-only. */
export const browserSocketFactory: GameplaySocketFactory = (url, handlers) => {
  const socket = new WebSocket(url)
  socket.binaryType = 'arraybuffer'
  socket.onopen = () => handlers.onOpen()
  socket.onmessage = (event: MessageEvent) => {
    if (typeof event.data === 'string') {
      handlers.onText(event.data)
      return
    }
    handlers.onBinary()
  }
  socket.onclose = () => handlers.onClose()
  socket.onerror = (event) => handlers.onError(event)
  return {
    send: (text) => socket.send(text),
    close: (code, reason) => socket.close(code, reason),
  }
}
