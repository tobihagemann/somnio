import { createHash, randomBytes } from 'node:crypto'

/**
 * Session policy that belongs to the feature rather than to any one storage backend, so a second
 * repository implementation cannot silently inherit Postgres' numbers.
 */
export const SESSION_POLICY = {
  /** 30 days: long enough not to re-prompt a casual player, short enough that an abandoned token ages out. */
  defaultLifetimeSeconds: 30 * 24 * 60 * 60,
  /** Live sessions retained per account before the oldest is evicted. */
  maxPerAccount: 10,
} as const

/** 256 bits of CSPRNG output as URL-safe base64 without padding: 43 characters. */
export function makeSessionToken(): string {
  return randomBytes(32).toString('base64url')
}

/**
 * Hex-encoded SHA-256 of the raw token, unsalted so the column is directly searchable — safe here
 * because the token has no low-entropy structure to grind against.
 */
export function sessionTokenDigest(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}
