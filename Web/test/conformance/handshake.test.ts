import { WebSocket } from 'ws'
import type { RawData } from 'ws'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  SOMNIO_PROTOCOL_CONSTANTS,
  decodeSomnioMessage,
  encodeSomnioMessage,
  MAX_WIRE_FRAME_SIZE,
} from '@/protocol'
import type { SomnioMessage } from '@/protocol'
import { GameplayTransport } from '@/transport'
import type { GameplaySocket, GameplaySocketFactory } from '@/transport'

/**
 * Wire conformance against a **live Swift gameplay server**.
 *
 * Honest accounting of what each part buys, because they are not equal:
 *
 * - The close-behaviour cases port `ProtocolHandshakeTests` and re-test the *server*, which the
 *   Swift integration suite already covers. They are a cheap regression net, not a check on the
 *   browser client — every one of them constructs raw frames by hand, so none traverses the real
 *   TypeScript encoder.
 * - The **valid-message** case is the one that covers the production path: it drives the real
 *   `GameplayTransport` and encoder into the real server. Without it, every other check here
 *   passes while the transport ships application messages as binary frames, which the server
 *   closes on.
 *
 * Requires a server at `SOMNIO_CONFORMANCE_URL` (default `ws://127.0.0.1:8080/ws`). CI stands one
 * up with `docker compose -f docker-compose.example.yml up --wait`.
 */

const GATEWAY = process.env.SOMNIO_CONFORMANCE_URL ?? 'ws://127.0.0.1:8080/ws'

/** WebSocket close codes the server uses. 1002 is protocolError, 1009 messageTooLarge. */
const CLOSE = { protocolError: 1002, messageTooLarge: 1009 } as const

/**
 * No close frame was received — the connection dropped instead. Not a code any peer *sends*; `ws`
 * reports it when the socket ends without a close handshake.
 */
const ABNORMAL_CLOSURE = 1006

/** `ws` delivers `Buffer | ArrayBuffer | Buffer[]`, none of which stringify usefully by default. */
function textOf(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  return Buffer.from(data).toString('utf8')
}

interface CloseOutcome {
  code: number
  framesBeforeClose: SomnioMessage[]
}

/** Opens a socket, runs `send`, and resolves with the server-driven close code. */
function closeCodeAfter(send: (socket: WebSocket) => void): Promise<CloseOutcome> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(GATEWAY, { maxPayload: MAX_WIRE_FRAME_SIZE * 4 })
    const framesBeforeClose: SomnioMessage[] = []
    const timer = setTimeout(() => {
      socket.terminate()
      reject(new Error('server did not close the connection within 10s'))
    }, 10_000)

    socket.on('open', () => send(socket))
    socket.on('message', (data, isBinary) => {
      if (isBinary) return
      try {
        framesBeforeClose.push(decodeSomnioMessage(textOf(data)))
      } catch {
        // A frame this client cannot decode is not what these cases assert.
      }
    })
    socket.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, framesBeforeClose })
    })
    socket.on('error', () => {
      // `error` precedes `close` on an abrupt teardown; the close handler resolves.
    })
  })
}

describe('server handshake conformance', () => {
  beforeAll(async () => {
    // Fail loudly rather than letting every case time out one by one.
    await new Promise<void>((resolve, reject) => {
      const probe = new WebSocket(GATEWAY)
      const timer = setTimeout(() => {
        probe.terminate()
        reject(new Error(`no gameplay server reachable at ${GATEWAY}`))
      }, 10_000)
      probe.on('open', () => {
        clearTimeout(timer)
        probe.close()
        resolve()
      })
      probe.on('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
    })
  })

  it('sends Hello with the current protocol version on connect', async () => {
    const outcome = await closeCodeAfter((socket) => {
      // Any protocol error will do to end the connection; Hello arrives first regardless.
      socket.send('{"tag":"notAVerb","payload":{}}')
    })
    const hello = outcome.framesBeforeClose.find((frame) => frame.tag === 'hello')
    expect(hello).toBeDefined()
    expect(hello?.tag === 'hello' && hello.payload.protocolVersion).toBe(
      SOMNIO_PROTOCOL_CONSTANTS.helloVersion
    )
  })

  it.each([
    ['an unrecognized tag', () => '{"tag":"notAVerb","payload":{}}'],
    ['malformed JSON', () => '{ not json'],
    ['a recognized tag with a malformed payload', () => '{"tag":"clientPosition","payload":{}}'],
    ['a zero-byte text frame', () => ''],
  ])('closes with protocolError on %s', async (_label, frame) => {
    const outcome = await closeCodeAfter((socket) => socket.send(frame()))
    expect(outcome.code).toBe(CLOSE.protocolError)
  })

  it('closes with protocolError on a binary frame', async () => {
    const outcome = await closeCodeAfter((socket) => socket.send(Buffer.from([0x00]), { binary: true }))
    expect(outcome.code).toBe(CLOSE.protocolError)
  })

  /**
   * Past `MAX_WIRE_FRAME_SIZE` the WebSocket layer's reassembly guard fires before the decoder runs,
   * so this is `messageTooLarge` rather than `protocolError`. The slack above the encoder's
   * `maxFrameLength` is what keeps a legitimately-sized frame from landing here.
   *
   * An abnormal closure is accepted alongside 1009, because the client is still writing a ~1 MiB
   * payload when the server refuses it: whether the close frame arrives before the reset is transport
   * timing, not server behaviour. Sampled over 12 connections against a live server this came back
   * 10x 1009 and 2x 1006, so asserting 1009 alone is flaky by roughly one run in six.
   *
   * The assertion keeps its discriminating power. Every outcome that would mean a real defect still
   * fails it: a clean 1000 close, a 1002 that would mean the frame reached the decoder, and — the one
   * that matters most — the server *accepting* the frame, which produces no close at all and trips
   * the helper's 10s rejection.
   */
  it('closes without processing a frame past the wire cap', async () => {
    const oversized = 'a'.repeat(MAX_WIRE_FRAME_SIZE + 16)
    const outcome = await closeCodeAfter((socket) => socket.send(oversized))
    expect([CLOSE.messageTooLarge, ABNORMAL_CLOSURE]).toContain(outcome.code)
  })
})

describe('production outbound path', () => {
  /**
   * The case the hand-built frames above cannot reach: a **valid** application message driven
   * through the real transport and encoder into the real server. The server accepts it (rather
   * than closing on a binary frame) and answers the pre-login gate with a protocol-error close
   * only because the message is out of order — which is itself proof the frame parsed.
   */
  it('sends a valid message through the real transport as a text frame', async () => {
    const sent: { text: string; wasString: boolean }[] = []
    const factory: GameplaySocketFactory = (url, handlers) => {
      const socket = new WebSocket(url, { maxPayload: MAX_WIRE_FRAME_SIZE * 4 })
      socket.on('open', () => handlers.onOpen())
      socket.on('message', (data, isBinary) => {
        if (isBinary) handlers.onBinary()
        else handlers.onText(textOf(data))
      })
      socket.on('close', () => handlers.onClose())
      socket.on('error', (error) => handlers.onError(error))
      const adapter: GameplaySocket = {
        send: (text) => {
          // Records the *actual* argument type, which is what proves the transport did not hand
          // the socket an ArrayBuffer.
          sent.push({ text, wasString: typeof text === 'string' })
          socket.send(text)
        },
        close: (code, reason) => socket.close(code, reason),
      }
      return adapter
    }

    const transport = new GameplayTransport(factory)
    const inbound: SomnioMessage[] = []
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 8000)
      transport.connect(GATEWAY, (event) => {
        if (event.kind === 'message') {
          inbound.push(event.message)
          if (event.message.tag === 'hello') {
            transport.send({ tag: 'clientSay', payload: { entityIndex: 0, text: 'conformance' } })
          }
        }
        if (event.kind === 'peerEOF' || event.kind === 'connectFailed') {
          clearTimeout(timer)
          resolve()
        }
      })
    })

    expect(inbound.some((frame) => frame.tag === 'hello')).toBe(true)
    const say = sent.find((frame) => frame.text.includes('clientSay'))
    expect(say).toBeDefined()
    expect(say?.wasString).toBe(true)
    // The frame the server received is exactly what the production encoder produced.
    expect(say?.text).toBe(
      encodeSomnioMessage({ tag: 'clientSay', payload: { entityIndex: 0, text: 'conformance' } })
    )
  })
})
