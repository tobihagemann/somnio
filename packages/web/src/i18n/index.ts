import { BASE_ITEMS, MONSTER_KINDS, PEOPLES, TEACHINGS, TRIALS, peopleLabelKey, roleLabelKey } from '@somnio/core';
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
 * item's name in the Character window, every people's name on the character card, every role's and
 * teaching's name in the HUD and a master's panel, every nightmare's name on its plaque, and every
 * place a trial sends a dreamer to.
 */
export const CORE_LABEL_KEYS: readonly string[] = [
  // Each role's Spirit deepening is its own teaching under one label.
  ...new Set([
    ...Object.values(BASE_ITEMS).map((item) => item.labelKey),
    ...PEOPLES.map(peopleLabelKey),
    ...ROLES.map(roleLabelKey),
    ...Object.values(TEACHINGS).map((taught) => taught.labelKey),
    ...Object.values(MONSTER_KINDS).map((kind) => kind.name),
    ...Object.values(TRIALS).flatMap((trial) => (trial.kind === 'reach' ? [trial.labelKey] : [])),
  ]),
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
  'Logged out %@ other browsers.',
  'Logged out one other browser.',
  'No other browser remembers your password.',
  'Could not log out other browsers. Try again.',
  'Your session expired. Please log in again.',
  'Reconnecting...',
  'You receive %@c.',
  '%1$@ bought for %2$@c.',
  '%1$@ sold for %2$@c.',
  '%@ dropped.',
  '%@ picked up.',
  'You are now a %@.',
  'Your %1$@ deepens: rank %2$@.',
  'You found a hidden place, %1$@ of %2$@.',
  'Your task is done. Return to your master.',
  'Your health gives out. You fall.',
  '%@ draws you back into the dream.',
  '%@ draw you back into the dream.',
  '%@ loses hold of you.',
  '%@ lose hold of you.',
  'You draw %@ back into the dream.',
  'You lose hold of %@.',
  'You let go and wake, weakened.',
  'This door opens only at night.',

  // The HUD: the frames, the belt, the clock, the chat, and the menu's windows
  'Health',
  'Balance',
  'Spirit',
  'Winded',
  'winded',
  'Chat',
  'Talk here. /w to whisper, /y to yell',
  'Menu',
  'Players',
  'Character',
  'Bag',
  'Settings',
  'Close %@',
  'Players: %@',
  'Items',
  'Stats',
  'Gear',
  'Your dreamer, wearing what is equipped. Drag to turn.',
  'Equip',
  'Unequip',
  'Drop',
  'Right-click or double-click to equip.',
  'Right-click or double-click to unequip.',
  '%@ only',
  'Fits only the %@ slot.',
  'Stays with you',
  'Bag full',
  'This stays with you.',
  'Pools',
  'Offence',
  'Defence',
  'Recovery',
  'Mending',
  'Warding',
  'Damage a swing',
  'Time between swings',
  'Balance a swing',
  'Your swings land',
  'Guard',
  '%@ strikes land',
  '%1$@ − %2$@ Guard',
  '...with no Balance left',
  'Health a second',
  'Balance a second',
  'Spirit a second',
  'Health a mend',
  'Ward strength',
  '+%@ ranks',
  '+%@ gear',
  'Bare hands',
  '%@ s',
  '%@%%',
  '%1$@: %2$@',
  'Plain',
  'Magic',
  'Rare',
  'Main hand',
  'Off hand',
  'Head',
  'Chest',
  'Hands',
  'Legs',
  'Feet',
  'Neck',
  'Ring',
  'Ring 1',
  'Ring 2',
  '+%@ Health',
  '+%@ Balance',
  '+%@ Spirit',
  '+%@ damage',
  '+%@ Guard',
  '+%@%% swing speed',
  '+%@%% Balance recovery',
  '+%@%% Spirit recovery',
  '+%@ health a mend',
  '+%@%% ward strength',
  'In the off hand, it lets a Healer mend and use their abilities.',
  'In the off hand, it lets a Mystic use their abilities.',
  'Run',
  'Shift',
  'held off',
  'Attack',
  'Mend',
  'Raise',
  'Empty slot',
  'An ability you learn takes this slot.',
  'cooling down',
  '%@s',
  '%@ Spirit',
  '%@ Balance',
  'Instant',
  '%@ s channel',
  '%@ s cooldown',
  'The nightmare you target, up to %@ m away',
  'The dreamer you target, up to %@ m away, or yourself',
  'Yourself',
  'Nightmares in reach, in front of you',
  'Nightmares up to %@ m around you',
  'You and dreamers up to %@ m around you',
  'Not while fallen',
  'Not while channelling',
  'Needs a weapon or an empty main hand',
  'Needs the Moonstone in your off hand',
  'Needs a wand in your off hand',
  'Not enough Spirit',
  'Not enough Balance',
  'Target a nightmare in range',
  'Your target has fallen or is out of range',
  'Ready in %@ s',
  'Effects',
  'Braced',
  'Challenged',
  'Renewing',
  'Calmed',
  'Warded',
  'Weakened',
  'Bound',
  'Veiled',
  'Takes half the harm and cannot run.',
  'Goes after the dreamer who challenged it.',
  'Mends a little every second.',
  "Stirs the nightmares' anger half as much.",
  'A shield takes the harm of the next blows.',
  'Strikes softer.',
  'Cannot move from where it stands.',
  'Nightmares leave this dreamer alone.',
  '%1$@, %2$@ s left',
  'Channelling %@',
  'Being drawn back',
  'Being drawn back by %@',
  'Target yourself',
  'No role yet',
  'Studying %1$@ · %2$@%%',
  'Studying nothing',
  'Task: %@',
  'hale',
  'grazed',
  'wounded',
  'hurt',
  'failing',
  'fallen',
  'Autumn Wood',
  'Arena',
  'Fighter Hall',
  'Healer Hall',
  'Inn',
  'Library',
  'Mystic Tower',
  'Shop',
  'Edaria Square',
  'North Meadow',
  'South Meadow',
  'West Meadow',
  '%1$@ of %2$@',
  'miss',
  'Target',
  'Target, %@',
  'Target, %@, facing locked',
  'Clear target',

  // Masters and the fallen notice
  'Master of the Fighters',
  'Master of the Healers',
  'Master of the Mystics',
  'You are a %1$@. %2$@ has nothing to teach you.',
  "You hold another master's trial. One trial at a time.",
  'Give up that trial',
  '%1$@ takes on those who pass a trial. Passing it commits you to nothing: you choose afterwards whether to become a %2$@.',
  'Ask for the trial',
  'Your trial',
  'Give up the trial',
  'Become a %@?',
  'You passed the trial. Accepting makes you a %@ for good. It cannot be undone, and the other masters will not teach you afterwards.',
  'Your bag is full. Make room in it before you accept.',
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
  'Find %@ hidden places and come back.',
  'Talk to %@ to hear where they lie.',
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
  'Strike every nightmare in front of you at once. Each rank hits harder.',
  'Turn every nightmare near you on yourself.',
  'Take half the harm for a few seconds, but you cannot run. Each rank holds it longer.',
  'Leap to the nightmare you target. Each rank readies it sooner.',
  'Shout to give balance back to every dreamer who hears you. Each rank gives back more.',
  'Holding the Moonstone, target a dreamer or yourself and turn on Mend. Your spirit mends them while they stay near.',
  'Each rank mends more with every touch.',
  'Holding the Moonstone, turn on Mend at a fallen dreamer and stay beside them to raise them.',
  'Each rank raises your spirit by %@.',
  'Stand still and pour a deep mend into the dreamer you target, or into yourself. Moving breaks it off. Each rank mends more, and sooner.',
  'Mend the dreamer you target, or yourself, a little every second for a while. Each rank mends more.',
  'Mend every dreamer near you at once, yourself included. Each rank mends more.',
  "Turn the nightmares' anger from you: they forget half of it, and your mending stirs them less for a while.",
  'Shield the dreamer you target, or yourself. The shield takes the harm of the next blows until it breaks. Each rank holds more.',
  'The nightmare you target strikes softer for a while. Each rank makes it last longer.',
  'Hold the nightmare you target where it stands for a few seconds. It still strikes whoever is in its reach. Each rank holds it longer.',
  'Send a bolt of dream at the nightmare you target, even from afar. Each rank hits harder.',
  'Hide yourself and every dreamer near you from the nightmares for a few seconds. They forget you were there.',
  'Always see which way each fallen dreamer lies, however far off.',
  'Fallen dreamers',
  '%1$@ lies fallen to the %2$@',
  'You have fallen',
  'You cannot move, but you can still speak. A Healer can draw you back.',
  '%1$@ is drawing you back: %2$@ s',
  '%1$@ are drawing you back: %2$@ s',
  'Give up',
  'You will wake at the inn, weakened.',
  'Wake there',
  'Stay',

  // Shop
  'Shopkeeper',
  'Your purse',
  '%@c',
  '%@ sells plain gear and buys what you find. Rarer finds fetch more.',
  'For sale',
  'Sell',
  '%1$@ damage, %2$@ balance a swing',
  'Buy for %@c',
  'Buy %1$@ for %2$@c',
  'Sell for %@c',
  'Sell %1$@ for %2$@c',
  'You need %@c more.',
  'Your bag is full.',
  'Your bag holds nothing %@ buys.',

  // Login and registration
  'Somnio',
  'Email',
  'Password',
  'Remember password',
  "If you don't have an account, click here!",
  'Log In',
  'Sign Up',
  'Email:',
  'Password:',
  'Repeat password:',
  'Cancel',
  'Enter a valid email address.',
  'Another account already uses that email.',
  'Registration failed.',

  // The character card
  'Your Dreamers',
  'Play',
  'Delete',
  'No dreamers yet. Create one to enter the world.',
  'Delete a dreamer to make room for a new one.',
  'New Dreamer',
  'Log Out',
  'Name:',
  'People:',
  'Create',
  'That name uses characters Somnio does not allow.',
  'Another dreamer already has that name.',
  'Could not create the dreamer. Try again.',
  'Could not enter the world. Try again.',
  'Could not delete the dreamer. Try again.',
  'Delete Dreamer',
  '%@ will be gone for good, with every rank and everything they carry.',

  // Game menu, about, and the version gate
  'Resume',
  'Options',
  'About Somnio',
  'Leave Game',
  'Log Out Other Browsers',
  'Every other browser that remembers your password will have to log in again.',
  'Log Them Out',
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
  'Ghost model by Quaternius.',

  // Browser-only surfaces
  'This browser cannot render 3D graphics.',
  'Somnio needs WebGL. Try a current version of Safari, Chrome, or Firefox.',
  'Turn your phone sideways.',
  'Somnio is played in landscape. Tap the ground to walk, and tap a nightmare to target it.',
  'Loading the world...',
  'Fullscreen',

  // The splash reel's dreamers
  'Anyone up for the North Wood?',
  'Watch out, nightmares about!',
  'Meet me at the inn.',
];
