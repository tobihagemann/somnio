import { describe, expect, it } from 'vitest'
import { UnrecognizedTagError, WireDecodingError, decodeSomnioMessage } from '@somnio/protocol'

/** The decoder failures the connection actor's terminal-close path catches. */
describe('frame validation', () => {
  it('malformed JSON text surfaces a decoding error', () => {
    expect(() => decodeSomnioMessage('{ not json ')).toThrow(WireDecodingError)
  })

  it('unknown string tag surfaces unrecognizedTag with the offending tag', () => {
    expect(() => decodeSomnioMessage('{"tag":"notAVerb","payload":{}}')).toThrow(UnrecognizedTagError)
    try {
      decodeSomnioMessage('{"tag":"notAVerb","payload":{}}')
    } catch (error) {
      expect((error as UnrecognizedTagError).tag).toBe('notAVerb')
    }
  })

  it('valid JSON missing the payload surfaces a decoding error', () => {
    expect(() => decodeSomnioMessage('{"tag":"login"}')).toThrow(WireDecodingError)
  })
})
