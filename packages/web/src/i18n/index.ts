import { ITEMS, PEOPLES, TEACHINGS, peopleLabelKey, roleLabelKey } from '@somnio/core';
import { ROLES } from '@somnio/protocol';
import { coreCatalog, lookupIn, mergeCatalogs, readCatalog } from '@somnio/core/catalog';
import type { CatalogLocale, CatalogTables } from '@somnio/core/catalog';
import webCatalogJSON from './catalog.json' with { type: 'json' };

export * from '@somnio/core/catalog';
export * from './chatLineText';

/**
 * The browser client's localization surface: the core catalog (people names, item labels) merged
 * with the browser's own catalog. The collision set is exported so a test can pin
 * it rather than letting the last import silently win.
 */
export const webCatalog: CatalogTables = readCatalog(webCatalogJSON);

const merged = mergeCatalogs([coreCatalog, webCatalog]);

export const catalogTables: CatalogTables = merged.tables;
export const catalogCollisions: readonly string[] = merged.collisions;

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
    const primary = tag.toLowerCase().split('-')[0];
    if (primary === 'de') return 'de';
    if (primary === 'en') return 'en';
  }
  return 'en';
}

let activeLocale: CatalogLocale = 'en';

export function setLocale(locale: CatalogLocale): void {
  activeLocale = locale;
}

export function currentLocale(): CatalogLocale {
  return activeLocale;
}

/**
 * Looks up `key` in the active locale and substitutes any arguments.
 *
 * An unresolved key returns the key itself. That is safe precisely because catalog keys *are* the
 * English source strings, so a missing German entry degrades to readable English rather than to a
 * developer identifier leaking into the UI.
 */
export function t(key: string, ...args: string[]): string {
  return lookupIn(catalogTables, activeLocale, key, args);
}

/** Same lookup against an explicit locale, for tests and for side-by-side rendering. */
export function translate(locale: CatalogLocale, key: string, ...args: string[]): string {
  return lookupIn(catalogTables, locale, key, args);
}

/**
 * The keys rendered through a label-key lookup in `@somnio/core` rather than a literal: every
 * item's name in the items panel, every people's name in the registration form, and every role's
 * and teaching's name in the HUD and a master's panel.
 */
export const CORE_LABEL_KEYS: readonly string[] = [
  ...Object.values(ITEMS).map((item) => item.labelKey),
  ...PEOPLES.map(peopleLabelKey),
  ...ROLES.map(roleLabelKey),
  ...Object.values(TEACHINGS).map((taught) => taught.labelKey),
];

/**
 * Every catalog key the browser UI renders.
 *
 * The catalog test checks en/de presence, placeholder parity, and the no-Unicode-ellipsis rule
 * against it, and also scans every `.ts` file under `src` for `t(...)` literals and fails on any
 * that is missing from this list, so a newly rendered string cannot ship unguarded merely because
 * the author forgot to extend the allowlist.
 */
export const RENDERED_KEYS: readonly string[] = [
  ...CORE_LABEL_KEYS,

  // Chat scrollback
  '%1$@ asks, "%2$@"',
  '%1$@ exclaims, "%2$@"',
  '%1$@ says, "%2$@"',
  '%1$@ whispers, "%2$@"',
  '%1$@ yells, "%2$@"',
  '%1$@ asks from the %2$@, "%3$@"',
  '%1$@ exclaims from the %2$@, "%3$@"',
  '%1$@ says from the %2$@, "%3$@"',
  '%1$@ whispers from the %2$@, "%3$@"',
  '%1$@ yells from the %2$@, "%3$@"',
  'north',
  'north-east',
  'east',
  'south-east',
  'south',
  'south-west',
  'west',
  'north-west',
  '%@ is not a command. Write /w to whisper or /y to yell.',
  'Broadcast message: %@',
  'The connection was lost.',
  'The server is currently not reachable. Try again later.',
  'Bad credentials.',
  'Already logged in.',
  'Too many attempts. Wait a little before trying again.',
  'Error %@ occurred.',
  '%@ entered the game.',
  '%@ left the game.',
  'Welcome to Somnio!',
  'You own %@c.',
  'Your password could not be saved.',
  'Your session expired. Please log in again.',
  'Reconnecting...',
  'You receive %@c.',
  'You are now a %@.',
  'Your %1$@ deepens: rank %2$@.',
  'Your task is done. Return to your master.',
  'Your health gives out. You fall.',
  '%@ draws you back into the dream.',
  'You let go and wake, weakened.',

  // HUD and floating panels
  'Health',
  'Balance',
  'Spirit',
  'Chat',
  'Talk here. /w to whisper, /y to yell',
  'Players',
  'Items',
  'Players: %@',
  'Items: %@',
  'winded',
  'No role yet',
  'Studying %1$@: %2$@ of %3$@',
  'Studying nothing',
  'Task: %@',
  '%1$@ of %2$@',
  'miss',

  // Masters and the fallen notice
  'Master of the Kämpfer',
  'Master of the Heiler',
  'You are a %1$@. %2$@ has nothing to teach you.',
  "You hold another master's trial. One trial at a time.",
  'Give up that trial',
  '%1$@ takes on those who pass a trial. Passing it commits you to nothing: you choose afterwards whether to become a %2$@.',
  'Ask for the trial',
  'Your trial',
  'Give up the trial',
  'Become a %@?',
  'You passed the trial. Accepting makes you a %@ for good. It cannot be undone, and the other master will not teach you afterwards.',
  'Become a %@',
  'Not yet',
  'Rank %1$@ of %2$@',
  'Mastered',
  '%1$@ of %2$@ practice toward rank %3$@',
  'Study this',
  'Needs %1$@ at rank %2$@',
  'Finish your current task first.',
  'Give up the task',
  'Drive off a nightmare.',
  'Drive off %@ nightmares.',
  'Falling starts the count over.',
  'Walk to the %@ and come back.',
  'You cannot strike while you hold this trial.',
  'Mend %@ health on other dreamers.',
  'Each rank adds to every hit you land.',
  'You study one teaching at a time. What you do out there fills its practice, and full practice is its next rank.',
  'You study nothing. Choose a teaching below.',
  'You are studying',
  'You can study',
  'Earned by a task',
  '%@ teaches its first rank for a task.',
  'Take the task',
  'You did what %@ asked.',
  'Learn %@',
  'Each rank makes nightmares miss you more often.',
  'Each rank shortens the pause between your swings.',
  'Each rank brings your balance back faster.',
  'Each rank raises your health by %@.',
  'Holding the Mondstein, click a dreamer to tend them. Your spirit mends them while you stay close.',
  'Each rank mends more with every touch.',
  'Holding the Mondstein, stay close to a fallen dreamer you tend to raise them.',
  'Each rank raises your spirit by %@.',
  'You have fallen',
  'You cannot move, but you can still speak. A Heiler can draw you back.',
  '%1$@ is drawing you back: %2$@ s',
  'Give up',
  'You will wake at the inn, weakened.',
  'Wake there',
  'Stay',

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
  'People:',
  'Cancel',
  'That name uses characters Somnio does not allow.',
  'Nickname already exists.',
  'Registration failed.',

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
];
