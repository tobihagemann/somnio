import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Runtime configuration resolved from the environment. `SOMNIO_DEV_DEFAULTS=1` is the explicit
 * opt-in for the development fallbacks (admin token `dev-admin`, the committed sector fixtures,
 * the localhost database); without it a deployment that loses its environment refuses to boot
 * rather than serving `/admin` on a well-known token.
 */
export interface ServerConfiguration {
  httpHost: string;
  httpPort: number;
  adminToken: string;
  sectorsDirectory: string;
  checkpointIntervalMs: number;
  outboxHighWatermark: number;
  devDefaults: boolean;
  /**
   * Where the pre-login limit reads a client's address: `proxy` the last `X-Forwarded-For` entry,
   * `direct` the socket. `off` limits nothing. An unstated `SOMNIO_TRUST_PROXY` resolves to `off`
   * rather than `direct`, because behind a proxy every client would share the proxy's address.
   */
  preloginLimit: 'proxy' | 'direct' | 'off';
}

export type ServerConfigurationErrorKind = 'invalidPort' | 'missingAdminToken' | 'missingSectorsDirectory' | 'invalidTrustProxy';

export class ServerConfigurationError extends Error {
  readonly kind: ServerConfigurationErrorKind;

  constructor(kind: ServerConfigurationErrorKind, message: string) {
    super(message);
    this.name = 'ServerConfigurationError';
    this.kind = kind;
  }
}

export const DEFAULT_HTTP_HOST = '0.0.0.0';
export const DEFAULT_HTTP_PORT = 17662;
export const DEV_ADMIN_TOKEN = 'dev-admin';
/** The committed map fixtures, resolved from this file so the default holds from any working directory. */
export const DEV_SECTORS_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), '../../core/fixtures/sectors');
export const DEFAULT_CHECKPOINT_INTERVAL_MS = 30_000;
export const DEFAULT_OUTBOX_HIGH_WATERMARK = 1024;

export function resolveServerConfiguration(env: Record<string, string | undefined>): ServerConfiguration {
  const devDefaults = isTruthy(env['SOMNIO_DEV_DEFAULTS']);
  const rawPort = env['SOMNIO_HTTP_PORT'];
  let httpPort = DEFAULT_HTTP_PORT;
  if (rawPort !== undefined) {
    const parsed = /^-?\d+$/.test(rawPort) ? Number(rawPort) : Number.NaN;
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      throw new ServerConfigurationError('invalidPort', `SOMNIO_HTTP_PORT is not a valid TCP port: ${rawPort}`);
    }
    httpPort = parsed;
  }
  const token = env['SOMNIO_ADMIN_TOKEN'];
  let adminToken: string;
  if (token !== undefined && token.length > 0) adminToken = token;
  else if (devDefaults) adminToken = DEV_ADMIN_TOKEN;
  else throw new ServerConfigurationError('missingAdminToken', 'SOMNIO_ADMIN_TOKEN must be set');
  const sectors = env['SOMNIO_SECTORS_DIR'];
  let sectorsDirectory: string;
  if (sectors !== undefined && sectors.length > 0) sectorsDirectory = resolve(sectors);
  else if (devDefaults) sectorsDirectory = DEV_SECTORS_DIRECTORY;
  else throw new ServerConfigurationError('missingSectorsDirectory', 'SOMNIO_SECTORS_DIR must be set');
  const rawTrustProxy = env['SOMNIO_TRUST_PROXY'];
  let preloginLimit: ServerConfiguration['preloginLimit'];
  if (rawTrustProxy === undefined || rawTrustProxy.length === 0) preloginLimit = 'off';
  else if (rawTrustProxy === '1') preloginLimit = 'proxy';
  else if (rawTrustProxy === '0') preloginLimit = 'direct';
  else throw new ServerConfigurationError('invalidTrustProxy', `SOMNIO_TRUST_PROXY must be 1 or 0: ${rawTrustProxy}`);
  return {
    httpHost: env['SOMNIO_HTTP_HOST'] ?? DEFAULT_HTTP_HOST,
    httpPort,
    adminToken,
    sectorsDirectory,
    checkpointIntervalMs: DEFAULT_CHECKPOINT_INTERVAL_MS,
    outboxHighWatermark: DEFAULT_OUTBOX_HIGH_WATERMARK,
    devDefaults,
    preloginLimit,
  };
}

/** `"1"` or `"true"` (case-insensitive); absent, empty, or anything else is `false`. */
function isTruthy(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const lowered = raw.toLowerCase();
  return lowered === '1' || lowered === 'true';
}
