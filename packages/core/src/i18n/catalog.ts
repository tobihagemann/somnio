/**
 * Bilingual string catalogs. Each package ships its own `{key: {en, de}}` JSON and merges what it
 * renders through `mergeCatalogs`; catalog keys are the English source strings, which is why an
 * unresolved lookup can safely fall back to the key — the fallback reads as English rather than
 * as a raw identifier.
 */

export type CatalogLocale = 'en' | 'de';
export const CATALOG_LOCALES: readonly CatalogLocale[] = ['en', 'de'];

/** One locale's `key -> value` table. */
export type LocaleTable = Record<string, string>;

export type CatalogTables = Record<CatalogLocale, LocaleTable>;

/** The committed catalog shape: one `{en, de}` pair per English key. */
export type CatalogJSON = Record<string, { en: string; de: string }>;

export function readCatalog(json: CatalogJSON): CatalogTables {
  const tables: CatalogTables = { en: {}, de: {} };
  for (const [key, entry] of Object.entries(json)) {
    tables.en[key] = entry.en;
    tables.de[key] = entry.de;
  }
  return tables;
}

/**
 * Merges catalogs left to right, later winning, and reports every key that appeared more than once.
 *
 * The precedence is explicit rather than incidental: the catalogs are authored independently and
 * nothing stops two of them from defining the same English key with different German. `collisions`
 * exists so a test can pin that set instead of leaving the winner to whichever import happens to
 * come last.
 */
export function mergeCatalogs(catalogs: readonly CatalogTables[]): {
  tables: CatalogTables;
  collisions: string[];
} {
  const tables: CatalogTables = { en: {}, de: {} };
  const seen = new Set<string>();
  const collisions = new Set<string>();
  for (const catalog of catalogs) {
    for (const key of Object.keys(catalog.en)) {
      if (seen.has(key)) collisions.add(key);
      seen.add(key);
    }
    for (const locale of CATALOG_LOCALES) {
      Object.assign(tables[locale], catalog[locale]);
    }
  }
  return { tables, collisions: [...collisions].sort() };
}

/**
 * Applies the catalog's `%@`-style format placeholders. Positional `%1$@` wins where present; bare `%@`
 * consumes arguments in order. `%%` is a literal percent.
 *
 * Substitution is deliberately single-pass over the template: replacing arguments one at a time
 * would let an argument that itself contains `%@` be re-scanned as a placeholder, which is a
 * formatting-string injection when the argument is a player-supplied name.
 */
export function formatTemplate(template: string, args: readonly string[]): string {
  let nextIndex = 0;
  return template.replace(/%%|%(\d+)\$@|%@/g, (match, position?: string) => {
    if (match === '%%') return '%';
    if (position !== undefined) return args[Number(position) - 1] ?? match;
    const argument = args[nextIndex];
    nextIndex += 1;
    return argument ?? match;
  });
}

/**
 * The one lookup-and-substitute implementation.
 *
 * Lives here, beside `formatTemplate` and the catalog types, so both `t`/`translate` and
 * `renderChatLine` share it without `chatLineText` having to import from the barrel that re-exports
 * it. The fallback chain is a single rule, so a change (a new locale, a different miss
 * behaviour) cannot land in one caller and not another.
 */
export function lookupIn(tables: CatalogTables, locale: CatalogLocale, key: string, args: readonly string[]): string {
  const template = tables[locale][key] ?? tables.en[key] ?? key;
  return args.length === 0 ? template : formatTemplate(template, [...args]);
}

/** One catalog rule violation, as `catalogViolations` reports it. */
export interface CatalogViolation {
  key: string;
  rule: 'missingLocale' | 'emptyValue' | 'placeholderMismatch' | 'unicodeEllipsis';
  detail: string;
}

/**
 * Placeholders in a template, sorted so ordering differences between locales are not a mismatch.
 * Bare `%@` and positional `%1$@` stay distinct.
 */
function placeholders(template: string): string[] {
  return [...template.matchAll(/%(\d+)\$@|%@/g)].map((match) => (match[1] === undefined ? '@' : `${match[1]}$@`)).sort();
}

/**
 * The four rules every rendered key must satisfy: an `en` and a `de` value, both non-empty,
 * placeholder parity between the two, and ASCII `...` rather than U+2026 in either. `expectedKeys`
 * is the allowlist of keys the consumer renders; a key absent from it ships unguarded, which is
 * why each consumer also scans its sources for rendered keys.
 */
export function catalogViolations(tables: CatalogTables, expectedKeys: readonly string[]): CatalogViolation[] {
  const violations: CatalogViolation[] = [];
  for (const key of expectedKeys) {
    for (const locale of CATALOG_LOCALES) {
      const value = tables[locale][key];
      if (value === undefined) {
        violations.push({ key, rule: 'missingLocale', detail: `no ${locale} value` });
      } else if (value.length === 0) {
        violations.push({ key, rule: 'emptyValue', detail: `empty ${locale} value` });
      } else if (value.includes('\u2026')) {
        violations.push({ key, rule: 'unicodeEllipsis', detail: `${locale} value uses U+2026` });
      }
    }
    const english = tables.en[key];
    const german = tables.de[key];
    if (english !== undefined && german !== undefined) {
      const englishPlaceholders = placeholders(english);
      const germanPlaceholders = placeholders(german);
      if (englishPlaceholders.join(',') !== germanPlaceholders.join(',')) {
        violations.push({
          key,
          rule: 'placeholderMismatch',
          detail: `en has [${englishPlaceholders.join(', ')}], de has [${germanPlaceholders.join(', ')}]`,
        });
      }
    }
  }
  return violations;
}
