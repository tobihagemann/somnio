import { WebSocket } from 'ws'
import type { ClientOptions, RawData } from 'ws'
import { MAX_WIRE_FRAME_SIZE, decodeAdminResponse, encodeAdminRequest } from '@somnio/protocol'
import type { AdminRequest, AdminResponse } from '@somnio/protocol'
import { resolveTrustRoots } from './trustRoots.ts'
import type { TrustRootsResolution } from './trustRoots.ts'
import { SecureTransportValidationError, validate } from './urlValidation.ts'

export type AdminTransportErrorKind =
  | 'noResponse'
  | 'unexpectedBinaryFrame'
  | 'decodeFailed'
  | 'connectFailed'
  | 'invalidTransportURL'
  | 'pinningRefused'

export class AdminTransportError extends Error {
  readonly kind: AdminTransportErrorKind
  override readonly cause: unknown

  constructor(kind: AdminTransportErrorKind, cause?: unknown) {
    super(
      cause === undefined
        ? kind
        : `${kind}: ${cause instanceof Error ? cause.message : JSON.stringify(cause)}`
    )
    this.name = 'AdminTransportError'
    this.kind = kind
    this.cause = cause
  }
}

/** The CLI validates the same string upstream; this gate is for every other caller. */
export function dialableURL(url: string): string {
  try {
    validate(url)
  } catch (error) {
    if (error instanceof SecureTransportValidationError)
      throw new AdminTransportError('invalidTransportURL', error)
    throw error
  }
  return url
}

/** The `ca` for a `wss://` dial from a resolution; a refusal fails closed rather than falling back to system trust. */
export function dialOptions(url: string, token: string, trust: TrustRootsResolution): ClientOptions {
  const options: ClientOptions = {
    headers: { authorization: `Bearer ${token}` },
    maxPayload: MAX_WIRE_FRAME_SIZE,
  }
  if (!url.startsWith('wss://')) return options
  if (trust.kind === 'refused') throw new AdminTransportError('pinningRefused', trust.reason)
  return { ...options, ca: trust.ca }
}

function textOf(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  return Buffer.from(data).toString('utf8')
}

/**
 * Single-shot request/response over the `/admin` WebSocket: an authenticated connection, the
 * encoded request as one text frame, the first inbound text frame decoded as the response,
 * then a normal close.
 */
export function send(
  request: AdminRequest,
  url: string,
  token: string,
  trust: TrustRootsResolution = resolveTrustRoots()
): Promise<AdminResponse> {
  const dialURL = dialableURL(url)
  const options = dialOptions(dialURL, token, trust)
  const frame = encodeAdminRequest(request)
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(dialURL, options)
    let settled = false
    const settle = (outcome: { response: AdminResponse } | { error: AdminTransportError }) => {
      if (settled) return
      settled = true
      if ('response' in outcome) resolve(outcome.response)
      else reject(outcome.error)
    }
    socket.on('open', () => socket.send(frame))
    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        settle({ error: new AdminTransportError('unexpectedBinaryFrame') })
        socket.close(1002, 'unexpected binary frame')
        return
      }
      let response: AdminResponse
      try {
        response = decodeAdminResponse(textOf(data))
      } catch (error) {
        settle({ error: new AdminTransportError('decodeFailed', error) })
        socket.close(1002, 'decode failed')
        return
      }
      settle({ response })
      socket.close(1000)
    })
    socket.on('unexpected-response', (_request, incoming) => {
      settle({
        error: new AdminTransportError(
          'connectFailed',
          new Error(`upgrade rejected with ${incoming.statusCode}`)
        ),
      })
      socket.terminate()
    })
    socket.on('error', (error) => {
      settle({ error: new AdminTransportError('connectFailed', error) })
    })
    socket.on('close', () => settle({ error: new AdminTransportError('noResponse') }))
  })
}
