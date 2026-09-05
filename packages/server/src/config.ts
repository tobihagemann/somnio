import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Runtime configuration resolved from the environment. `SOMNIO_DEV_DEFAULTS=1` is the explicit
 * opt-in for the development fallbacks (admin token `dev-admin`, the committed sector fixtures,
 * the localhost database); without it a deployment that loses its environment refuses to boot
 * rather than serving `/admin` on a well-known token.
 */
export interface ServerConfiguration {
  httpHost: string
  httpPort: number
  adminToken: string
  sectorsDirectory: string
  checkpointIntervalMs: number
  outboxHighWatermark: number
  /** One-shot operator override: the boot orphan-dialog prune skips its safety guard this boot only. */
  forceDialogPrune: boolean
  devDefaults: boolean
}

export type ServerConfigurationErrorKind = 'invalidPort' | 'missingAdminToken' | 'missingSectorsDirectory'

export class ServerConfigurationError extends Error {
  readonly kind: ServerConfigurationErrorKind

  constructor(kind: ServerConfigurationErrorKind, message: string) {
    super(message)
    this.name = 'ServerConfigurationError'
    this.kind = kind
  }
}

export const DEFAULT_HTTP_HOST = '0.0.0.0'
export const DEFAULT_HTTP_PORT = 17662
export const DEV_ADMIN_TOKEN = 'dev-admin'
/** The committed map fixtures, resolved from this file so the default holds from any working directory. */
export const DEV_SECTORS_DIRECTORY = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../core/fixtures/sectors'
)
export const DEFAULT_CHECKPOINT_INTERVAL_MS = 30_000
export const DEFAULT_OUTBOX_HIGH_WATERMARK = 1024

export function resolveServerConfiguration(env: Record<string, string | undefined>): ServerConfiguration {
  const devDefaults = isTruthy(env['SOMNIO_DEV_DEFAULTS'])
  const rawPort = env['SOMNIO_HTTP_PORT']
  let httpPort = DEFAULT_HTTP_PORT
  if (rawPort !== undefined) {
    const parsed = /^-?\d+$/.test(rawPort) ? Number(rawPort) : Number.NaN
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      throw new ServerConfigurationError(
        'invalidPort',
        `SOMNIO_HTTP_PORT is not a valid TCP port: ${rawPort}`
      )
    }
    httpPort = parsed
  }
  const token = env['SOMNIO_ADMIN_TOKEN']
  let adminToken: string
  if (token !== undefined && token.length > 0) adminToken = token
  else if (devDefaults) adminToken = DEV_ADMIN_TOKEN
  else throw new ServerConfigurationError('missingAdminToken', 'SOMNIO_ADMIN_TOKEN must be set')
  const sectors = env['SOMNIO_SECTORS_DIR']
  let sectorsDirectory: string
  if (sectors !== undefined && sectors.length > 0) sectorsDirectory = resolve(sectors)
  else if (devDefaults) sectorsDirectory = DEV_SECTORS_DIRECTORY
  else throw new ServerConfigurationError('missingSectorsDirectory', 'SOMNIO_SECTORS_DIR must be set')
  return {
    httpHost: env['SOMNIO_HTTP_HOST'] ?? DEFAULT_HTTP_HOST,
    httpPort,
    adminToken,
    sectorsDirectory,
    checkpointIntervalMs: DEFAULT_CHECKPOINT_INTERVAL_MS,
    outboxHighWatermark: DEFAULT_OUTBOX_HIGH_WATERMARK,
    forceDialogPrune: isTruthy(env['SOMNIO_DIALOG_PRUNE_FORCE']),
    devDefaults,
  }
}

/** `"1"` or `"true"` (case-insensitive); absent, empty, or anything else is `false`. */
function isTruthy(raw: string | undefined): boolean {
  if (raw === undefined) return false
  const lowered = raw.toLowerCase()
  return lowered === '1' || lowered === 'true'
}
