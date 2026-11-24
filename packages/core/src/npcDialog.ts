import { LOCALES, SOMNIO_PROTOCOL_CONSTANTS, utf8ByteLength } from '@somnio/protocol';
import type { Locale, Service } from '@somnio/protocol';
import dialogJSON from '../data/dialog.json' with { type: 'json' };
import { SOMNIO_CONSTANTS } from './constants.ts';
import type { Character } from './domain/character.ts';
import { lookupIn, readCatalog } from './i18n/catalog.ts';
import { masterRole } from './lucidity.ts';
import { mayAccept } from './quests.ts';
import type { QuestId } from './quests.ts';
import { graphemeCount, speechReadSeconds } from './speech.ts';

/** Each line an NPC says, greeting or step, keyed by its English, in every language a reader reads. */
const DIALOG = readCatalog(dialogJSON);

/** Where a line names the player the NPC speaks to. */
const NAME_TOKEN = '$name';

/** Whom a step is for by role: a dreamer with none, one of the master's own, or one who took another. */
export const LISTENER_ROLES = ['none', 'own', 'other'] as const;
export type ListenerRole = (typeof LISTENER_ROLES)[number];

/** The roles a step may be for at an NPC offering `service`: `own` and `other` only at a master. */
export function listenerRolesFor(service: Service | undefined): readonly ListenerRole[] {
  return service !== undefined && masterRole(service) !== undefined ? LISTENER_ROLES : ['none'];
}

/** Where a quest stands for a dreamer: theirs to take, held (ready to turn in included), or turned in. */
export const QUEST_STANDINGS = ['offered', 'held', 'done'] as const;
export type QuestStanding = (typeof QUEST_STANDINGS)[number];

export type DialogCondition = { role: ListenerRole } | { quest: QuestId; state: QuestStanding };

/** A line an NPC says when asked, in English, and whom it is for; a step with no `when` is for everyone. */
export interface DialogStep {
  text: string;
  when?: DialogCondition;
}

/** Whether a step is for the dreamer who asked an NPC offering `service`. */
export function dialogStepFits(when: DialogCondition | undefined, listener: Pick<Character, 'lucidity' | 'quests'>, service: Service | undefined): boolean {
  if (when === undefined) return true;
  const { lucidity, quests } = listener;
  if ('role' in when) {
    if (when.role === 'none') return lucidity.role === undefined;
    const npcRole = service === undefined ? undefined : masterRole(service);
    if (npcRole === undefined || lucidity.role === undefined) return false;
    switch (when.role) {
      case 'own':
        return lucidity.role === npcRole;
      case 'other':
        return lucidity.role !== npcRole;
    }
  }
  switch (when.state) {
    case 'offered':
      return mayAccept(when.quest, quests, lucidity);
    case 'held':
      return quests.active.some((held) => held.questId === when.quest);
    case 'done':
      return quests.done.includes(when.quest);
  }
}

/** What `text`, greeting or step, becomes when spoken to `targetName`. */
export function dialogLine(text: string, targetName: string): string {
  // A replacer function, so a `$&` in the name is inserted as written rather than expanded.
  return text.replaceAll(NAME_TOKEN, () => targetName);
}

/** What `text`, greeting or step, becomes when spoken to `targetName` in `locale`. A line the dialog catalog does not hold is said as written. */
export function localizedDialogLine(text: string, locale: Locale, targetName: string): string {
  return dialogLine(lookupIn(DIALOG, locale, text, []), targetName);
}

/**
 * Whether `text`, greeting or step, fits the say cap whatever name it is said to, since a client
 * refuses a line past the cap. The worst case is each `$name` replaced by a name at the identifier
 * cap, the longest character name the server accepts.
 */
export function dialogLineFits(text: string): boolean {
  const names = text.split(NAME_TOKEN).length - 1;
  const longest = utf8ByteLength(text) + names * (SOMNIO_PROTOCOL_CONSTANTS.maxIdentifierUTF8Bytes - utf8ByteLength(NAME_TOKEN));
  return longest <= SOMNIO_PROTOCOL_CONSTANTS.maxSayUTF8Bytes;
}

/** Whether a line, greeting or step, stays within `npcDialogLineGraphemes`, each `$name` counted as `npcDialogNameGraphemes`. */
export function dialogLineInBudget(text: string): boolean {
  const parts = text.split(NAME_TOKEN);
  const graphemes = parts.reduce((sum, part) => sum + graphemeCount(part), 0) + (parts.length - 1) * SOMNIO_CONSTANTS.npcDialogNameGraphemes;
  return graphemes <= SOMNIO_CONSTANTS.npcDialogLineGraphemes;
}

/** How long an NPC holds its next line after saying `text` to `targetName`: the reading time of its longest translation. */
export function npcReadSeconds(text: string, targetName: string): number {
  return Math.max(...LOCALES.map((locale) => speechReadSeconds(localizedDialogLine(text, locale, targetName))));
}
