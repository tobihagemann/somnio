import { describe, expect, it } from 'vitest'
import {
  SKELETON_ALGORITHM_VERSION,
  UNICODE_DATA_VERSION,
  confusableSkeleton,
  validateForRegistration,
} from '../src/namePolicy/namePolicy.ts'
import { UNICODE_DATA_VERSION_OF_TABLES } from '../src/namePolicy/tables.ts'

/**
 * The confusable / script-mixing defense. The golden vectors are the tripwire for any NFKC/NFD/
 * casing drift in the engine's ICU, which would otherwise silently desync the two uniqueness
 * layers (`name_normalized` in Postgres vs the computed `name_skeleton`).
 */

function scalars(value: string): number[] {
  return [...value].map((character) => character.codePointAt(0)!)
}

describe('confusable skeleton', () => {
  it('folds confusable lookalikes onto one skeleton', () => {
    // Cyrillic А (U+0410) vs Latin A; Greek Ο (U+039F) vs Latin O.
    expect(confusableSkeleton('АDMIN')).toBe(confusableSkeleton('ADMIN'))
    expect(confusableSkeleton('Ο')).toBe(confusableSkeleton('O'))
  })

  it('expands a multi-scalar confusable target', () => {
    // U+0310 COMBINING CANDRABINDU maps to the two-scalar prototype U+0306 U+0307. A scalar-only
    // lookup would drop the second scalar and miss the collision.
    expect(scalars(confusableSkeleton('̐'))).toEqual([0x0306, 0x0307])
  })

  it.each([
    // "m" folds to the "rn" prototype, so ADMIN -> a d r n i n; the Cyrillic spelling folds to
    // the same skeleton, which is the whole point.
    ['ADMIN', [0x61, 0x64, 0x72, 0x6e, 0x69, 0x6e]],
    ['АDMIN', [0x61, 0x64, 0x72, 0x6e, 0x69, 0x6e]],
    // ø folds to o + COMBINING LONG SOLIDUS OVERLAY (U+0338).
    ['Bjørn', [0x62, 0x6a, 0x6f, 0x0338, 0x72, 0x6e]],
    // fullwidth ABC -> NFKC-folded "abc"
    ['ＡＢＣ', [0x61, 0x62, 0x63]],
  ])('matches the committed golden vector for %j', (input, expected) => {
    expect(scalars(confusableSkeleton(input))).toEqual(expected)
  })

  it('gives NFC and NFD spellings the same skeleton', () => {
    // Precomposed "é" (U+00E9) vs decomposed "e" + combining acute (U+0301).
    expect(confusableSkeleton('Café')).toBe(confusableSkeleton('Café'))
  })
})

describe('registration validation', () => {
  it.each(['Bjørn', 'ADMIN', 'Mary Jane', 'Иван', 'Ярослав'])('accepts the single-script name %j', (name) => {
    expect(validateForRegistration(name)).toBeUndefined()
  })

  it('rejects mixed Latin and Cyrillic', () => {
    expect(validateForRegistration('Иван-Ivan')).toBe('mixedScript')
  })

  it.each([
    ['Latin plus Arabic', 'Omar-عمر'],
    ['Latin plus Devanagari', 'Ravi-रवि'],
    ['Latin plus Han', 'Ken-健'],
    ['a Japanese writing system', '健さん'],
  ])('accepts %s', (_label, name) => {
    expect(validateForRegistration(name)).toBeUndefined()
  })

  it.each([
    ['a control character', 'ab\u0007c'],
    ['an apostrophe', "O'Brien"],
    ['an emoji', 'ab\u{1F600}'],
  ])('rejects %s', (_label, name) => {
    expect(validateForRegistration(name)).toBe('disallowedCharacter')
  })

  it('rejects a restricted letter despite it being a letter', () => {
    // U+10330 GOTHIC LETTER AHSA is an L* letter but Gothic is an excluded historic script, so it
    // is Identifier_Status=Restricted. Proves the status gate is in force, not a bare L* allowlist.
    expect(validateForRegistration('\u{10330}')).toBe('disallowedCharacter')
  })

  it.each([' admin', 'admin ', 'admin-', '_admin', 'admin_'])('rejects the edge separator in %j', (name) => {
    // A leading or trailing separator survives the skeleton, so "admin " would dedup separately from "admin".
    expect(validateForRegistration(name)).toBe('disallowedCharacter')
  })

  it.each(['', '   ', '---', '_-_', '́'])('rejects %j for having no visible base character', (name) => {
    expect(validateForRegistration(name)).toBe('emptyAfterNormalization')
  })
})

describe('version pins', () => {
  it('agrees with the generated data', () => {
    expect(UNICODE_DATA_VERSION).toBe(UNICODE_DATA_VERSION_OF_TABLES)
    expect(UNICODE_DATA_VERSION).toBe('15.1.0')
    expect(SKELETON_ALGORITHM_VERSION).toBe(1)
  })
})
