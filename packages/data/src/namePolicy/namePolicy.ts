import { CONFUSABLES, isAllowed, nameShapeCategory, scriptID, scriptSet } from './tables.ts';

/**
 * Confusable / script-mixing defense for account and character names. Two layers, applied to the
 * same value both name surfaces hold:
 *
 * 1. `validateForRegistration` — a TR39-derived profile: an Identifier_Status=Allowed gate
 *    narrowed to a name shape, plus a Moderately-Restrictive-style script-mixing rejection.
 * 2. `confusableSkeleton` — a TR39 skeleton stored in `name_skeleton` and deduplicated by a UNIQUE
 *    constraint, so an all-Cyrillic "АDMIN" cannot coexist with an all-Latin "ADMIN".
 *
 * Table lookups (script, Allowed status, general category, confusables) come from the committed
 * Unicode 15.1.0 data; NFKC/NFD normalization and lowercasing come from the engine's ICU, and the
 * committed skeleton vectors in the test suite are the guard on that half.
 *
 * Residual risks: skeletons are approximate and font-dependent, so a genuinely multilingual name
 * can produce a false positive; and no skeleton catches similar-but-distinct spellings.
 */

/** The pinned Unicode version the committed tables were generated from. */
export const UNICODE_DATA_VERSION = '15.1.0';

/**
 * Hand-maintained: nothing persists or compares it. Bump it with any Unicode-table or
 * `confusableSkeleton` change, and ship a migration that recomputes every stored `name_skeleton`.
 */
export const SKELETON_ALGORITHM_VERSION = 1;

export type NamePolicyRejection = 'disallowedCharacter' | 'mixedScript' | 'emptyAfterNormalization';

/**
 * The TR39 skeleton of `name`, base-normalized to match `name_normalized` so the two uniqueness
 * layers agree: NFKC + lowercase, then NFD, then a single confusable-prototype replacement pass (a
 * source scalar may map to a multi-scalar prototype), then NFD again.
 */
export function confusableSkeleton(name: string): string {
  const base = name.normalize('NFKC').toLowerCase();
  const mapped: number[] = [];
  for (const character of base.normalize('NFD')) {
    const scalar = character.codePointAt(0)!;
    const prototype = CONFUSABLES.get(scalar);
    if (prototype === undefined) mapped.push(scalar);
    else mapped.push(...prototype);
  }
  return String.fromCodePoint(...mapped).normalize('NFD');
}

/**
 * Returns the reason a name is refused for registration, or `undefined` when it is accepted.
 * Validates the NFKC + lowercased form (the same base the skeleton uses) so width/case variants
 * resolve first.
 */
export function validateForRegistration(name: string): NamePolicyRejection | undefined {
  const scalars = [...name.normalize('NFKC').toLowerCase()].map((character) => character.codePointAt(0)!);
  // Require a visible base character (letter or digit), not merely a non-empty string: a name of
  // only spaces, hyphens, underscores, or combining marks would otherwise pass and yield a blank
  // or parasitic display name usable for impersonation.
  if (!scalars.some(isBaseCharacter)) return 'emptyAfterNormalization';
  // Reject a leading or trailing separator: " admin" / "admin " / "admin-" would otherwise get a
  // distinct skeleton from "admin" (the separator survives the skeleton), so two near-invisible
  // edge-whitespace variants could coexist.
  const first = scalars[0]!;
  const last = scalars[scalars.length - 1]!;
  if (PUNCTUATION_ALLOWLIST.has(first) || PUNCTUATION_ALLOWLIST.has(last)) return 'disallowedCharacter';
  if (!scalars.every(isNameShapeAllowed)) return 'disallowedCharacter';
  if (!scriptsAreCompatible(scalars)) return 'mixedScript';
  return undefined;
}

/**
 * Space, hyphen-minus, low line: the only non-letter/digit characters a name may contain. Kept
 * explicit rather than admitting every Identifier_Status=Allowed punctuation (which would let in
 * apostrophe and full stop).
 */
const PUNCTUATION_ALLOWLIST: ReadonlySet<number> = new Set([0x20, 0x2d, 0x5f]);

const LETTER_OR_DIGIT: ReadonlySet<string> = new Set(['Lu', 'Ll', 'Lt', 'Lm', 'Lo', 'Nd']);
const LETTER_MARK_OR_DIGIT: ReadonlySet<string> = new Set(['Lu', 'Ll', 'Lt', 'Lm', 'Lo', 'Mn', 'Mc', 'Me', 'Nd']);

function isNameShapeAllowed(scalar: number): boolean {
  if (PUNCTUATION_ALLOWLIST.has(scalar)) return true;
  if (!isAllowed(scalar)) return false;
  const category = nameShapeCategory(scalar);
  return category !== undefined && LETTER_MARK_OR_DIGIT.has(category);
}

/** A visible base character: a letter or decimal digit. Marks and the allowed punctuation do not count. */
function isBaseCharacter(scalar: number): boolean {
  const category = nameShapeCategory(scalar);
  return category !== undefined && LETTER_OR_DIGIT.has(category);
}

/**
 * The UAX #31 modern scripts recommended for use in identifiers. Pinned explicitly so the allowed
 * breadth is auditable; `Latin` is intentionally absent (it is the always-permitted base of
 * `scriptsAreCompatible`'s Latin-plus-one rule).
 */
const RECOMMENDED_SCRIPT_NAMES = [
  'Arabic',
  'Armenian',
  'Bengali',
  'Bopomofo',
  'Cyrillic',
  'Devanagari',
  'Ethiopic',
  'Georgian',
  'Greek',
  'Gujarati',
  'Gurmukhi',
  'Han',
  'Hangul',
  'Hebrew',
  'Hiragana',
  'Kannada',
  'Katakana',
  'Khmer',
  'Lao',
  'Malayalam',
  'Myanmar',
  'Oriya',
  'Sinhala',
  'Tamil',
  'Telugu',
  'Thaana',
  'Thai',
  'Tibetan',
];

function ids(names: readonly string[]): Set<number> {
  return new Set(names.map(scriptID).filter((id): id is number => id !== undefined));
}

const SCRIPT_POLICY = {
  neutral: ids(['Common', 'Inherited']),
  latin: scriptID('Latin'),
  cyrillic: scriptID('Cyrillic'),
  greek: scriptID('Greek'),
  recommended: ids(RECOMMENDED_SCRIPT_NAMES),
  cjkSystems: [ids(['Latin', 'Han', 'Hiragana', 'Katakana']), ids(['Latin', 'Han', 'Bopomofo']), ids(['Latin', 'Han', 'Hangul'])],
};

/**
 * A Moderately-Restrictive-style check: a name passes if it is single-script, a standard CJK system
 * (optionally with Latin), or Latin plus exactly one other recommended script that is neither
 * Cyrillic nor Greek (the highest-risk confusable pair). Common/Inherited scalars (digits, the
 * allowed punctuation, combining marks) are script-neutral and never constrain.
 */
function scriptsAreCompatible(scalars: readonly number[]): boolean {
  const perScalar: Set<number>[] = [];
  for (const scalar of scalars) {
    const scripts = scriptSet(scalar);
    for (const neutral of SCRIPT_POLICY.neutral) scripts.delete(neutral);
    if (scripts.size > 0) perScalar.push(scripts);
  }
  const first = perScalar[0];
  if (first === undefined) return true;

  let intersection = new Set(first);
  const union = new Set(first);
  for (const scripts of perScalar.slice(1)) {
    intersection = new Set([...intersection].filter((id) => scripts.has(id)));
    for (const id of scripts) union.add(id);
  }
  if (intersection.size > 0) return true;

  if (SCRIPT_POLICY.cjkSystems.some((system) => [...union].every((id) => system.has(id)))) return true;

  const latin = SCRIPT_POLICY.latin;
  if (latin !== undefined && union.has(latin)) {
    const others = [...union].filter((id) => id !== latin);
    const other = others[0];
    if (
      others.length === 1 &&
      other !== undefined &&
      SCRIPT_POLICY.recommended.has(other) &&
      other !== SCRIPT_POLICY.cyrillic &&
      other !== SCRIPT_POLICY.greek
    ) {
      return true;
    }
  }
  return false;
}
