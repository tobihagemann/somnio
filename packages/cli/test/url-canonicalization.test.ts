import { describe, expect, it } from 'vitest'
import { AdminTransportError, dialableURL } from '../src/transport.ts'
import { SecureTransportValidationError, validate, validateHostAgreement } from '../src/urlValidation.ts'

describe('dialableURL', () => {
  it.each([
    'ws://localhost:8080/admin',
    'wss://example.com:8443/admin',
    'wss://example.com:443/admin',
    'ws://127.0.0.1:17662/admin',
    'wss://example.com/admin?x=1',
  ])('returns the agreeing URL %s unchanged', (url) => {
    expect(dialableURL(url)).toBe(url)
  })

  it.each([
    'wss://☃.example/admin',
    'wss://ex%41mple.com/admin',
    'ws://[::1]:8080/admin',
    'ws://localhost#evil.com/admin',
  ])('rejects the host-disagreeing URL %s', (url) => {
    let caught: unknown
    try {
      dialableURL(url)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(AdminTransportError)
    expect((caught as AdminTransportError).kind).toBe('invalidTransportURL')
    expect(((caught as AdminTransportError).cause as SecureTransportValidationError).kind).toBe('invalidURL')
  })
})

describe('validate', () => {
  it.each([
    ['ws://attacker@localhost:8080/admin', 'userinfoNotAllowed'],
    ['WSS://localhost/admin', 'unsupportedScheme'],
    ['ws://example.com/admin', 'insecureRemoteURL'],
    ['', 'invalidURL'],
    ['ws://[::1]/admin', 'invalidURL'],
  ])('%s fails with %s', (url, kind) => {
    let caught: unknown
    try {
      validate(url)
    } catch (error) {
      caught = error
    }
    expect((caught as SecureTransportValidationError).kind).toBe(kind)
  })

  it('accepts every loopback spelling over ws and any host over wss', () => {
    for (const url of [
      'ws://localhost/admin',
      'ws://127.0.0.1/admin',
      'ws://LOCALHOST:1/admin',
      'wss://any.example/admin',
      'wss://Admin.Example.com/admin',
    ]) {
      expect(() => validate(url)).not.toThrow()
    }
  })

  it('is the whole gate: a host-disagreeing URL fails validate itself', () => {
    expect(() => validate('wss://ex%41mple.com/admin')).toThrow(SecureTransportValidationError)
    expect(() => validate('wss://example.com/admin#x')).toThrow(SecureTransportValidationError)
  })
})

describe('validateHostAgreement', () => {
  it('compares hostnames without ports', () => {
    expect(() => validateHostAgreement('wss://example.com:443/admin')).not.toThrow()
    expect(() => validateHostAgreement('ws://127.0.0.1:17662/admin')).not.toThrow()
  })

  it('compares hostnames case-insensitively, as the URL parser lowercases a domain', () => {
    expect(() => validateHostAgreement('wss://Admin.Example.com/admin')).not.toThrow()
    expect(() => validateHostAgreement('ws://LOCALHOST:17662/admin')).not.toThrow()
  })

  it('rejects a fragment outright', () => {
    expect(() => validateHostAgreement('wss://example.com/admin#x')).toThrow(SecureTransportValidationError)
  })
})
