import { readCatalog } from '@somnio/core/catalog'
import type { CatalogLocale, CatalogTables } from '@somnio/core/catalog'
import { lookupIn } from '@somnio/core/catalog'
import cliCatalogJSON from './catalog.json' with { type: 'json' }

/** The admin CLI's bilingual catalog: every key is its own English text, so a miss reads as English. */
export const cliCatalog: CatalogTables = readCatalog(cliCatalogJSON)

/** Every key in the CLI catalog, all of which `render` uses. */
export const RENDERED_KEYS: readonly string[] = Object.keys(cliCatalogJSON)

/**
 * The display locale from the environment's language variables, `en` unless the first one
 * names German. A CLI has no `navigator.languages`; `LC_ALL`, `LC_MESSAGES`, `LANG` are the
 * POSIX equivalents in precedence order.
 */
export function resolveLocale(env: Record<string, string | undefined> = process.env): CatalogLocale {
  for (const name of ['LC_ALL', 'LC_MESSAGES', 'LANG']) {
    const value = env[name]
    if (value === undefined || value.length === 0) continue
    return value.toLowerCase().split(/[_.-]/)[0] === 'de' ? 'de' : 'en'
  }
  return 'en'
}

export function localize(key: string, locale: CatalogLocale, ...args: string[]): string {
  return lookupIn(cliCatalog, locale, key, args)
}
