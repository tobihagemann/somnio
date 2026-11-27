import { chatVerb } from '@/client/chatLine';
import type { ChatLine } from '@/client/chatLine';
import type { CompassPoint } from '@/client/compass';
import { abilityTeaching, isQuestId, itemLabelKey, quest, roleLabelKey, teaching, trophyLabelKey } from '@somnio/core';
import type { AbilityId, QuestOrBountyId } from '@somnio/core';
import { bountyIdParts } from '@somnio/protocol';
import type { LootContentsMessage, Role } from '@somnio/protocol';
import { lookupIn } from '@somnio/core/catalog';
import type { CatalogLocale, CatalogTables } from '@somnio/core/catalog';
import { bountyTitleIn } from './placeNames';
import type { Lookup } from './placeNames';

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
    case 'speakingTooFast':
      return lookup("You're speaking too fast.");
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
      return lookup('%1$@ bought for %2$@c.', itemName(line.baseId, line.tier, line.line, lookup), String(line.coins));
    case 'sold':
      return lookup('%1$@ sold for %2$@c.', itemName(line.baseId, line.tier, line.line, lookup), String(line.coins));
    case 'boughtBack':
      return lookup('%1$@ bought back for %2$@c.', itemName(line.baseId, line.tier, line.line, lookup), String(line.coins));
    case 'dropped':
      return lookup('%@ dropped.', lootName(line.contents, lookup));
    case 'pickedUp':
      return lookup('%@ picked up.', lootName(line.contents, lookup));
    case 'rewarded':
      return lookup('%@ received.', lootName(line.contents, lookup));
    case 'bagFull':
      return lookup('Your bag is full.');
    case 'becameRole':
      return lookup('You are now a %@.', lookup(roleLabelKey(line.role)));
    case 'rankGained':
      return lookup('Your %1$@ deepens: rank %2$@.', lookup(teaching(line.teachingId).labelKey), String(line.rank));
    case 'placeFound':
      return lookup('You found a hidden place, %1$@ of %2$@.', String(line.found), String(line.total));
    case 'questDone': {
      const { labelKey, giver, turnIn } = quest(line.questId);
      return turnIn === giver
        ? lookup('Quest done: %1$@. Return to %2$@.', lookup(labelKey), line.turnIn)
        : lookup('Quest done: %1$@. Turn it in to %2$@.', lookup(labelKey), line.turnIn);
    }
    case 'bountyDone':
      return lookup('Bounty done. Return to the bounty board.');
    case 'questShared':
      if (line.reached === 0) return lookup('No dreamer is near enough to share with.');
      return line.reached === 1
        ? lookup('You shared a quest with one dreamer near you.')
        : lookup('You shared a quest with %@ dreamers near you.', String(line.reached));
    case 'questShareAnswer':
      return renderShareAnswer(line, lookup);
    case 'questTakenFrom':
      return lookup('You took on %1$@ from %2$@.', questName(line.questId, lookup), line.fromName);
    case 'bountiesRanOut':
      return line.count === 1
        ? lookup('Your bounty ran out as the board turned.')
        : lookup('Your %@ bounties ran out as the board turned.', String(line.count));
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
    case 'doorOpensAtNight':
      return lookup('This door opens only at night.');
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

type SpokenLine = Extract<ChatLine, { kind: 'spokenByOwn' | 'spokenByPeer' | 'spokenByNPC' }>;
type ShareAnswerLine = Extract<ChatLine, { kind: 'questShareAnswer' }>;

/** How a dreamer a quest was shared with came out of it, the quest by its title. */
function renderShareAnswer({ name, questId, outcome }: ShareAnswerLine, lookup: Lookup): string {
  const title = questName(questId, lookup);
  switch (outcome) {
    case 'took':
      return lookup('%1$@ took on %2$@.', name, title);
    case 'didNotTake':
      return lookup("%1$@ didn't take %2$@.", name, title);
    case 'logFull':
      return lookup("%@'s quest log is full.", name);
    case 'holds':
      return lookup('%1$@ already holds %2$@.', name, title);
    case 'done':
      return lookup('%1$@ turned in %2$@ before.', name, title);
    case 'cannotYet':
      return lookup("%1$@ can't take %2$@ yet.", name, title);
  }
}

/** A quest's title in the lookup's locale: a bounty's names the land it is set in. */
function questName(questId: QuestOrBountyId, lookup: Lookup): string {
  return isQuestId(questId) ? lookup(quest(questId).labelKey) : bountyTitleIn(bountyIdParts(questId)!.land, lookup);
}

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
export function itemName(baseId: string, tier: number, line: Role | undefined, lookup: Lookup): string {
  const key = itemLabelKey(baseId, tier, line);
  return key === undefined ? baseId : lookup(key);
}

/** What a drop is called in the lookup's locale: an item's name, or a trophy's. A kind this build does not know renders raw, as an item does. */
function lootName(contents: LootContentsMessage, lookup: Lookup): string {
  switch (contents.kind) {
    case 'item':
      return itemName(contents.baseId, contents.tier, contents.line, lookup);
    case 'trophy': {
      const key = trophyLabelKey(contents.monsterKind);
      return key === undefined ? contents.monsterKind : lookup(key);
    }
  }
}

/** An ability's display name in the lookup's locale: the name of the teaching that teaches it. */
export function abilityName(abilityId: AbilityId, lookup: Lookup): string {
  return lookup(teaching(abilityTeaching(abilityId)).labelKey);
}

/** One literal lookup per direction, so the catalog test sees each one rendered. */
export function compassName(direction: CompassPoint, lookup: Lookup): string {
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
