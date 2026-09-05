import argon2 from 'argon2'

/**
 * Argon2id at the OWASP middle tier (m=19456 KiB, t=2, p=1), producing a self-describing PHC
 * string (`$argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>`) so verification needs no parameters
 * threaded alongside.
 */
const ARGON2_PARAMETERS = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
  hashLength: 32,
} as const

export function hashPassword(rawPassword: string): Promise<string> {
  return argon2.hash(rawPassword, ARGON2_PARAMETERS)
}

/** Throws on a malformed PHC string; resolves `false` on a mismatch. */
export function verifyPassword(rawPassword: string, encodedHash: string): Promise<boolean> {
  return argon2.verify(encodedHash, rawPassword)
}

/**
 * Accepts `undefined` for the stored hash and pays an equivalent Argon2id cost, so a caller
 * cannot distinguish "unknown account" from "wrong password" by response timing. Resolves `false`
 * whenever there is no hash.
 */
export async function verifyAccountPassword(
  rawPassword: string,
  encodedHash: string | undefined
): Promise<boolean> {
  if (encodedHash !== undefined) return verifyPassword(rawPassword, encodedHash)
  await hashPassword(rawPassword)
  return false
}
