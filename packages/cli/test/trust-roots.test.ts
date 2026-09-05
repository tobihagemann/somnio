import { X509Certificate } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AdminTransportError } from '../src/transport.ts'
import { dialOptions } from '../src/transport.ts'
import { TRUST_ROOTS_PATH, resolveTrustRoots } from '../src/trustRoots.ts'

describe('trust roots', () => {
  it('the committed PEM parses to exactly the two ISRG roots', () => {
    const resolution = resolveTrustRoots(TRUST_ROOTS_PATH)
    expect(resolution.kind).toBe('pinned')
    if (resolution.kind !== 'pinned') return
    const subjects = resolution.ca.map((pem) => new X509Certificate(pem).subject)
    expect(subjects.map((subject) => subject.split('\n').at(-1))).toEqual([
      'CN=ISRG Root X1',
      'CN=ISRG Root X2',
    ])
    for (const pem of resolution.ca) expect(new X509Certificate(pem).ca).toBe(true)
  })

  it('an unreadable PEM is refused', () => {
    expect(resolveTrustRoots('/nonexistent/trust-roots.pem').kind).toBe('refused')
  })

  it('a malformed PEM is refused', () => {
    const directory = mkdtempSync(join(tmpdir(), 'somnio-pem-'))
    try {
      const path = join(directory, 'bad.pem')
      writeFileSync(path, 'not a certificate')
      expect(resolveTrustRoots(path).kind).toBe('refused')
      writeFileSync(path, '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n')
      expect(resolveTrustRoots(path).kind).toBe('refused')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('a wss dial pins the roots and a refused resolution fails closed', () => {
    const pinned = resolveTrustRoots(TRUST_ROOTS_PATH)
    const options = dialOptions('wss://example.com/admin', 'tok', pinned)
    expect(pinned.kind).toBe('pinned')
    expect(options.ca).toEqual(pinned.kind === 'pinned' ? pinned.ca : undefined)
    expect(options.headers).toEqual({ authorization: 'Bearer tok' })
    let caught: unknown
    try {
      dialOptions('wss://example.com/admin', 'tok', { kind: 'refused', reason: 'bad pem' })
    } catch (error) {
      caught = error
    }
    expect((caught as AdminTransportError).kind).toBe('pinningRefused')
  })

  it('a loopback ws dial never consults the trust roots', () => {
    const options = dialOptions('ws://127.0.0.1:17662/admin', 'tok', { kind: 'refused', reason: 'bad pem' })
    expect(options.ca).toBeUndefined()
  })
})
