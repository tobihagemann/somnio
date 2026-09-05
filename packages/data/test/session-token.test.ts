import { describe, expect, it } from 'vitest'
import { SESSION_POLICY, makeSessionToken, sessionTokenDigest } from '../src/auth/sessionToken.ts'

describe('session tokens', () => {
  it('are URL-safe base64 without padding', () => {
    expect(makeSessionToken()).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('carry 256 bits of entropy', () => {
    // 256 bits encode to 43 base64 characters once padding is stripped.
    expect(makeSessionToken()).toHaveLength(43)
  })

  it('do not repeat', () => {
    expect(new Set(Array.from({ length: 256 }, makeSessionToken)).size).toBe(256)
  })

  it('digest to something other than the token', () => {
    const token = makeSessionToken()
    const digest = sessionTokenDigest(token)
    expect(digest).not.toBe(token)
    expect(digest).not.toContain(token)
  })

  it('digest as a stable hex SHA-256', () => {
    // Pinned against the published SHA-256 of the empty string, so a swapped hash function or a
    // changed encoding fails loudly rather than silently invalidating every stored row.
    expect(sessionTokenDigest('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(sessionTokenDigest('abc')).toHaveLength(64)
  })

  it('digest deterministically and unsalted', () => {
    // Unsalted on purpose: redemption looks the row up *by* digest, and a salted hash is not
    // searchable — it would force a scan-and-verify over every row.
    expect(sessionTokenDigest('a-fixed-token')).toBe(sessionTokenDigest('a-fixed-token'))
    expect(sessionTokenDigest('other')).not.toBe(sessionTokenDigest('a-fixed-token'))
  })

  it('default to a 30-day lifetime and ten per account', () => {
    expect(SESSION_POLICY.defaultLifetimeSeconds).toBe(30 * 24 * 60 * 60)
    expect(SESSION_POLICY.maxPerAccount).toBe(10)
  })
})
