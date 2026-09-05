/**
 * Named maps rather than inlined literals: these raw values go out on the wire in the `register`
 * payload as an opaque `Int16`, so a drifted table would keep sending the old numbers with the
 * round-trip and golden-frame suites both green. `enum-raws.test.ts` pins them to literals. The
 * display names resolve through `coreCatalog`, keyed by the English label.
 */
export const CHARACTER_CLASS = {
  fighter: 0,
  lancer: 1,
  warrior: 2,
  thief: 3,
  hunter: 4,
  gangster: 5,
  cleric: 6,
  mage: 7,
} as const
export type CharacterClass = (typeof CHARACTER_CLASS)[keyof typeof CHARACTER_CLASS]

export const GENDER = { male: 0, female: 1 } as const
export type Gender = (typeof GENDER)[keyof typeof GENDER]
