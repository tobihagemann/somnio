/**
 * Reader for Xcode string catalogs, so the browser client renders the *same* German the native
 * client ships rather than a second translation that drifts from it.
 *
 * Catalog keys are the English source strings, which is why an unresolved lookup can safely fall
 * back to the key: the fallback reads as English rather than as a raw identifier.
 */

export type CatalogLocale = 'en' | 'de'
export const CATALOG_LOCALES: readonly CatalogLocale[] = ['en', 'de']

interface StringUnit {
  state?: string
  value?: string
}

interface Localization {
  stringUnit?: StringUnit
}

interface CatalogEntry {
  localizations?: Record<string, Localization | undefined>
}

export interface Xcstrings {
  sourceLanguage?: string
  strings: Record<string, CatalogEntry | undefined>
  version?: string
}

/** One locale's `key -> value` table. */
export type LocaleTable = Record<string, string>

export type CatalogTables = Record<CatalogLocale, LocaleTable>

/**
 * Flattens one catalog into per-locale tables. A key with no `stringUnit` for a locale is left out
 * rather than mapped to the empty string, so the lookup falls back to the English key instead of
 * rendering blank — a blank label is much harder to notice than an untranslated one.
 */
export function readXcstrings(catalog: Xcstrings): CatalogTables {
  const tables: CatalogTables = { en: {}, de: {} }
  for (const [key, entry] of Object.entries(catalog.strings)) {
    for (const locale of CATALOG_LOCALES) {
      const value = entry?.localizations?.[locale]?.stringUnit?.value
      if (value !== undefined) tables[locale][key] = value
    }
    // An entry with no `en` localization is a source-language key Xcode has not expanded; the key
    // itself is the English text, so record it to keep `en` complete.
    tables.en[key] ??= key
  }
  return tables
}

/**
 * Merges catalogs left to right, later winning, and reports every key that appeared more than once.
 *
 * The precedence is explicit rather than incidental: the Core, UI, and App catalogs are authored
 * independently and nothing stops two of them from defining the same English key with different
 * German. `collisions` exists so a test can pin that set instead of leaving the winner to
 * whichever import happens to come last.
 */
export function mergeCatalogs(catalogs: readonly CatalogTables[]): {
  tables: CatalogTables
  collisions: string[]
} {
  const tables: CatalogTables = { en: {}, de: {} }
  const seen = new Set<string>()
  const collisions = new Set<string>()
  for (const catalog of catalogs) {
    for (const key of Object.keys(catalog.en)) {
      if (seen.has(key)) collisions.add(key)
      seen.add(key)
    }
    for (const locale of CATALOG_LOCALES) {
      Object.assign(tables[locale], catalog[locale])
    }
  }
  return { tables, collisions: [...collisions].sort() }
}

/**
 * Applies Swift's `String(format:)` placeholders. Positional `%1$@` wins where present; bare `%@`
 * consumes arguments in order. `%%` is a literal percent.
 *
 * Substitution is deliberately single-pass over the template: replacing arguments one at a time
 * would let an argument that itself contains `%@` be re-scanned as a placeholder, which is a
 * formatting-string injection when the argument is a player-supplied name.
 */
export function formatTemplate(template: string, args: readonly string[]): string {
  let nextIndex = 0
  return template.replace(/%%|%(\d+)\$@|%@/g, (match, position?: string) => {
    if (match === '%%') return '%'
    if (position !== undefined) return args[Number(position) - 1] ?? match
    const argument = args[nextIndex]
    nextIndex += 1
    return argument ?? match
  })
}

/**
 * The one lookup-and-substitute implementation.
 *
 * Lives here, beside `formatTemplate` and the catalog types, so both `t`/`translate` and
 * `renderChatLine` share it without `chatLineText` having to import from the barrel that re-exports
 * it. The fallback chain is a single rule; three copies of it meant a change (a new locale, a
 * different miss behaviour) could land in two and produce different strings for the same key.
 */
export function lookupIn(
  tables: CatalogTables,
  locale: CatalogLocale,
  key: string,
  args: readonly string[]
): string {
  const template = tables[locale][key] ?? tables.en[key] ?? key
  return args.length === 0 ? template : formatTemplate(template, [...args])
}
