/**
 * Mirrors of `Sources/SomnioCore/Models/CharacterClass.swift` and `Gender.swift`.
 *
 * Named maps rather than literals inlined at the one call site, following `TEMPO`,
 * `WIRE_ENTITY_TYPE`, and `PORTAL_DIRECTIONS`: these raw values go out on the wire in the `register`
 * payload as an opaque `Int16`, so nothing downstream can notice a disagreement. Reorder the Swift
 * enum and an inlined table keeps sending the old numbers — every browser registration then creates
 * the wrong class, with the round-trip and golden-frame suites both green. Named here, the tables
 * are pinnable against the Swift source the way the other mirrored enums are.
 *
 * Display names live in the UI layer, not here: the labels are catalog keys, and `core/` renders
 * nothing.
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
