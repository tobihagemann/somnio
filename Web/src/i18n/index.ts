import coreCatalog from '@catalog/core'
import uiCatalog from '@catalog/ui'
import appCatalog from '@catalog/app'
import { browserCatalog } from './browserCatalog'
import { lookupIn, mergeCatalogs, readXcstrings } from './xcstrings'
import type { CatalogLocale, CatalogTables } from './xcstrings'

export * from './xcstrings'
export { browserCatalog } from './browserCatalog'
export * from './chatLineText'

/**
 * The browser client's localization surface. It reads the **shipped Swift catalogs directly** (via
 * the build aliases) rather than carrying copies, so a German string fixed for the native client is
 * fixed here in the same commit. The fourth source is the browser-owned catalog for strings no
 * Swift target ever needed.
 *
 * Merge order is Core, UI, App, browser — narrowest to widest — and the collision set is exported
 * so a test can pin it rather than letting the last import silently win.
 */
const merged = mergeCatalogs([
  readXcstrings(coreCatalog),
  readXcstrings(uiCatalog),
  readXcstrings(appCatalog),
  browserCatalog,
])

export const catalogTables: CatalogTables = merged.tables
export const catalogCollisions: readonly string[] = merged.collisions

/**
 * Resolves the display locale from the browser's ordered preference list.
 *
 * The **first** supported tag wins, which is why this cannot just scan for any German tag: the list
 * is ordered by preference, so `['en-GB', 'de']` is a reader who prefers English and happens to also
 * know German. Anything not German-tagged falls back to English, matching the two locales the app
 * bundles advertise.
 */
export function resolveLocale(languageTags: readonly string[] = navigator.languages ?? []): CatalogLocale {
  for (const tag of languageTags) {
    // The primary subtag compared whole, not as a prefix: `startsWith('de')` also matches every
    // other language whose code begins with those letters — IANA registers `den` as Slavey — and
    // would hand that reader German. Splitting on `-` still accepts `de-AT` and `en-GB`.
    const primary = tag.toLowerCase().split('-')[0]
    if (primary === 'de') return 'de'
    if (primary === 'en') return 'en'
  }
  return 'en'
}

let activeLocale: CatalogLocale = 'en'

export function setLocale(locale: CatalogLocale): void {
  activeLocale = locale
}

export function currentLocale(): CatalogLocale {
  return activeLocale
}

/**
 * Looks up `key` in the active locale and substitutes any arguments.
 *
 * An unresolved key returns the key itself. That is safe precisely because catalog keys *are* the
 * English source strings, so a missing German entry degrades to readable English rather than to a
 * developer identifier leaking into the UI.
 */
export function t(key: string, ...args: string[]): string {
  return lookupIn(catalogTables, activeLocale, key, args)
}

/** Same lookup against an explicit locale, for tests and for side-by-side rendering. */
export function translate(locale: CatalogLocale, key: string, ...args: string[]): string {
  return lookupIn(catalogTables, locale, key, args)
}

/**
 * Every catalog key the browser UI renders.
 *
 * This is the port of the Swift targets' `expectedKeys` allowlist discipline, and the catalog test
 * checks en/de presence, placeholder parity, and the no-Unicode-ellipsis rule against it. The
 * discipline is strengthened in one place: the test also scans every `.ts` file under `src` for
 * `t(...)` literals and fails on any that is missing from this list, so a newly rendered string
 * cannot ship unguarded merely because the author forgot to extend the allowlist.
 */
export const RENDERED_KEYS: readonly string[] = [
  // Chat scrollback
  '%1$@ asks, "%2$@"',
  '%1$@ exclaims, "%2$@"',
  '%1$@ says, "%2$@"',
  'Broadcast message: %@',
  'The connection was lost.',
  'The server is currently not reachable. Try again later.',
  'Bad credentials.',
  'Already logged in.',
  'Error %@ occurred.',
  '%@ entered the game.',
  '%@ left the game.',
  'Welcome to Somnio!',
  'You own %@c.',
  'Your password could not be saved.',
  'Your session expired. Please log in again.',
  'Reconnecting...',

  // HUD, floating panels, and inventory rows
  'Purse',
  'Cudgel',
  'HP',
  'Balance',
  'Mana',
  'Chat',
  'Players',
  'Items',
  'Players: %@',
  'Items: %@',

  // Login and registration
  'Somnio',
  'Nickname',
  'Password',
  'Remember password',
  "If you don't have an account, click here!",
  'Log In',
  'Sign Up',
  'Nickname:',
  'Password:',
  'Password (*):',
  '*: repeat',
  'Email:',
  'Character:',
  'Gender:',
  'Cancel',
  'That name uses characters Somnio does not allow.',
  'Nickname already exists.',
  'Registration failed.',

  // Character classes and genders offered by the registration form
  'Cleric',
  'Fighter',
  'Gangster',
  'Hunter',
  'Lancer',
  'Mage',
  'Thief',
  'Warrior',
  'Male',
  'Female',

  // Game menu, about, and the version gate
  'Resume',
  'Options',
  'About Somnio',
  'Leave Game',
  'Close',
  'Update required',
  'A newer version is available. Please update your client to keep playing.',
  'The server is being updated. Please try again in a few moments.',
  'Try Again',
  'OK',
  'Version: %@',
  'Copyright',
  'Thanks paragraph',
  'UI borders by Kenney.',
  '3D characters and props by KayKit.',
  'Floor textures by ambientCG.',
  'Ghost model by Quaternius.',

  // Browser-only surfaces
  'This browser cannot render 3D graphics.',
  'Somnio needs WebGL. Try a current version of Safari, Chrome, or Firefox on a desktop computer.',
  'Somnio needs a desktop computer.',
  'The game is played with a keyboard and a mouse. Come back from a laptop or desktop.',
  'Loading the world...',
  'Fullscreen',
]
