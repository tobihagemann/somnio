import { chatVerb } from '@/client/chatLine';
import type { ChatLine } from '@/client/chatLine';
import type { CompassPoint } from '@/client/compass';
import { itemLabelKey, roleLabelKey, teaching } from '@somnio/core';
import { lookupIn } from '@somnio/core/catalog';
import type { CatalogLocale, CatalogTables } from '@somnio/core/catalog';

/**
 * Renders a chat line to its localized text. Exhaustive over every `ChatLine`
 * variant, so a new case is a compile error rather than a silently blank row.
 *
 * Takes the tables and locale as parameters instead of reaching for the module-level active locale,
 * which is what lets the catalog test render every line in both languages without mutating global
 * state between assertions.
 */
export function renderChatLine(line: ChatLine, tables: CatalogTables, locale: CatalogLocale): string {
  const lookup = (key: string, ...args: string[]): string => lookupIn(tables, locale, key, args);

  switch (line.kind) {
    case 'spokenByOwn':
    case 'spokenByPeer':
    case 'spokenByNPC':
      return renderSpoken(line, lookup);
    case 'adminBroadcast':
      return lookup('Broadcast message: %@', line.message);
    case 'connectionLost':
      return lookup('The connection was lost.');
    case 'serverUnreachable':
      return lookup('The server is currently not reachable. Try again later.');
    case 'badCredentials':
      return lookup('Bad credentials.');
    case 'alreadyLoggedIn':
      return lookup('Already logged in.');
    case 'throttled':
      return lookup('Too many attempts. Wait a little before trying again.');
    case 'errorCode':
      return lookup('Error %@ occurred.', line.code);
    case 'unknownCommand':
      return lookup('%@ is not a command. Write /w to whisper or /y to yell.', line.command);
    case 'joined':
      return lookup('%@ entered the game.', line.playerName);
    case 'left':
      return lookup('%@ left the game.', line.playerName);
    case 'startupGreeting':
      return lookup('Welcome to Somnio!');
    case 'purseBalance':
      return lookup('You own %@c.', String(line.coins));
    case 'coinsGained':
      return lookup('You receive %@c.', String(line.coins));
    case 'bought':
      return lookup('%1$@ bought for %2$@c.', itemName(line.itemId, lookup), String(line.coins));
    case 'sold':
      return line.emptiedHand
        ? lookup('%1$@ sold for %2$@c. Your hands are empty.', itemName(line.itemId, lookup), String(line.coins))
        : lookup('%1$@ sold for %2$@c.', itemName(line.itemId, lookup), String(line.coins));
    case 'becameRole':
      return lookup('You are now a %@.', lookup(roleLabelKey(line.role)));
    case 'rankGained':
      return lookup('Your %1$@ deepens: rank %2$@.', lookup(teaching(line.teachingId).labelKey), String(line.rank));
    case 'taskDone':
      return lookup('Your task is done. Return to your master.');
    case 'fell':
      return lookup('Your health gives out. You fall.');
    case 'raised':
      return line.healerNames.length === 1
        ? lookup('%@ draws you back into the dream.', line.healerNames[0]!)
        : lookup('%@ draw you back into the dream.', formatNameList(line.healerNames, locale));
    case 'raiseBroken':
      return line.healerNames.length === 1
        ? lookup('%@ loses hold of you.', line.healerNames[0]!)
        : lookup('%@ lose hold of you.', formatNameList(line.healerNames, locale));
    case 'raisedOther':
      return lookup('You draw %@ back into the dream.', line.targetName);
    case 'raiseBrokenOther':
      return lookup('You lose hold of %@.', line.targetName);
    case 'wokeWeakened':
      return lookup('You let go and wake, weakened.');
    case 'credentialSaveFailed':
      return lookup('Your password could not be saved.');
    case 'loggedOutOtherBrowsers':
      if (line.count === 0) return lookup('No other browser remembers your password.');
      return line.count === 1 ? lookup('Logged out one other browser.') : lookup('Logged out %@ other browsers.', String(line.count));
    case 'logOutOtherBrowsersFailed':
      return lookup('Could not log out other browsers. Try again.');
    case 'sessionExpired':
      return lookup('Your session expired. Please log in again.');
    case 'reconnecting':
      return lookup('Reconnecting...');
  }
}

/** Names joined as the language lists them: "Lumi, Bren, and Kai", "Lumi, Bren und Kai". */
export function formatNameList(names: readonly string[], locale: CatalogLocale): string {
  return new Intl.ListFormat(locale, { type: 'conjunction' }).format(names);
}

type Lookup = (key: string, ...args: string[]) => string;
type SpokenLine = Extract<ChatLine, { kind: 'spokenByOwn' | 'spokenByPeer' | 'spokenByNPC' }>;

/** A whisper and a yell keep their verb whatever the punctuation; a line said plainly takes its verb from it. */
function renderSpoken(line: SpokenLine, lookup: Lookup): string {
  const { senderName, message } = line;
  const from = line.direction === undefined ? undefined : compassName(line.direction, lookup);
  switch (line.speech === 'say' ? chatVerb(message) : line.speech) {
    case 'whisper':
      return from === undefined
        ? lookup('%1$@ whispers, "%2$@"', senderName, message)
        : lookup('%1$@ whispers from the %2$@, "%3$@"', senderName, from, message);
    case 'yell':
      return from === undefined ? lookup('%1$@ yells, "%2$@"', senderName, message) : lookup('%1$@ yells from the %2$@, "%3$@"', senderName, from, message);
    case 'question':
      return from === undefined ? lookup('%1$@ asks, "%2$@"', senderName, message) : lookup('%1$@ asks from the %2$@, "%3$@"', senderName, from, message);
    case 'exclamation':
      return from === undefined
        ? lookup('%1$@ exclaims, "%2$@"', senderName, message)
        : lookup('%1$@ exclaims from the %2$@, "%3$@"', senderName, from, message);
    case 'statement':
      return from === undefined ? lookup('%1$@ says, "%2$@"', senderName, message) : lookup('%1$@ says from the %2$@, "%3$@"', senderName, from, message);
  }
}

/**
 * An item's display name in the lookup's locale. An id the item table does not know renders raw, so
 * an operator seeing it in a screenshot can tell which item is missing from the table.
 */
export function itemName(itemId: string, lookup: Lookup): string {
  const key = itemLabelKey(itemId);
  return key === undefined ? itemId : lookup(key);
}

/** One literal lookup per direction, so the catalog test sees each one rendered. */
function compassName(direction: CompassPoint, lookup: Lookup): string {
  switch (direction) {
    case 'north':
      return lookup('north');
    case 'north-east':
      return lookup('north-east');
    case 'east':
      return lookup('east');
    case 'south-east':
      return lookup('south-east');
    case 'south':
      return lookup('south');
    case 'south-west':
      return lookup('south-west');
    case 'west':
      return lookup('west');
    case 'north-west':
      return lookup('north-west');
  }
}
