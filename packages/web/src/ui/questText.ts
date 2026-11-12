import { heldQuest, isTeachingId, objectiveLines, roleLabelKey, teaching, turnInGrant } from '@somnio/core';
import type { ActiveQuest, Bounty, ObjectiveLine, Quest, QuestReward } from '@somnio/core';
import type { QuestTurnedIn } from '@/client';
import { itemName, t } from '@/i18n';
import { element } from './dom';
import { placeName } from './placeNames';
import type { QuestAccepted, QuestTurnIn } from './questFeedback';

/** A quest's title: a bounty's names the land it is set in. */
export function questTitle(said: Quest, bounty?: Bounty): string {
  return bounty === undefined ? t(said.labelKey) : t(said.labelKey, placeName(bounty.land));
}

/**
 * What a quest asks for, a line for each objective or run of objectives said by one line, then the
 * conditions it is held under. A line's key may take its goal, as a bounty's takes its count. A
 * held quest's lines say how far it has come: a count toward the goal, or for a run, how many of it
 * are met, never which.
 */
export function questLines(said: Quest, held: ActiveQuest | undefined): HTMLElement[] {
  const { withoutFalling, withoutStriking } = said;
  return [
    ...objectiveLines(said, held?.progress ?? []).map(({ labelKey, done, goal }) =>
      held === undefined
        ? note(t(labelKey, String(goal)))
        : element('p', { className: 'service-text', text: `${t(labelKey, String(goal))} ${t('%1$@ of %2$@', String(done), String(goal))}` }),
    ),
    ...(withoutFalling === true ? [note(t('Falling starts the count over.'))] : []),
    ...(withoutStriking === true ? [note(t('You cannot strike while you hold this quest.'))] : []),
  ];
}

/** A line of a quest held and how far it has come, as the tracker and the line over the world say it: "Visit Mercus in his shop: 0/1". */
export function objectiveCount({ labelKey, done, goal }: ObjectiveLine): { text: string; count: string } {
  // The line's own sentence, its stop giving way to the count.
  return { text: `${t(labelKey, String(goal)).replace(/\.$/, '')}:`, count: `${done}/${goal}` };
}

/** Where a done quest is turned in: its carrier, or for a bounty any bounty board. */
export function returnLine(held: ActiveQuest, carrierName: (carrierId: string) => string): string {
  return held.definition === undefined ? t('Return to %@.', carrierName(heldQuest(held).turnIn)) : t('Return to the bounty board.');
}

/** What a quest asks for, its lines run together, without how far it has come. */
export function questAsks(said: Quest): string {
  return askedLines(said).join(' ');
}

/** A quest taken on, as the banner over the world says it: its title, and what it asks for a line each. */
export function acceptedSaid(held: ActiveQuest): QuestAccepted {
  const said = heldQuest(held);
  return { title: questTitle(said, held.definition), lines: askedLines(said) };
}

/** What a quest pays, as a carrier's panel and the Quest log say it under what it asks: "Reward: 60c, 30 practice toward Toughening, a piece of gear". */
export function rewardNote(reward: QuestReward | undefined, study: string | undefined): HTMLElement[] {
  const parts = [...paidParts(reward?.coins, reward?.practice, study), ...(reward?.gear === undefined ? [] : [t('a piece of gear')])];
  return parts.length === 0 ? [] : [note(t('Reward: %@', parts.join(', ')))];
}

/**
 * What a quest turned in gave, as the banner over the world says it: the role a trial makes the
 * dreamer's, the first rank it or a gate teaches, the coins, and the practice in one line, and each
 * item it gave by name in its rarity.
 */
export function turnInSaid({ held, study, coins, items }: QuestTurnedIn): QuestTurnIn {
  const said = heldQuest(held);
  const { role, teaches } = turnInGrant(held);
  const paid = [
    ...(role === undefined ? [] : [t('You are a %@', t(roleLabelKey(role)))]),
    ...(teaches === undefined ? [] : [t('%@, rank 1', t(teaching(teaches).labelKey))]),
    ...paidParts(coins, said.reward?.practice, study),
  ];
  return {
    title: questTitle(said, held.definition),
    paid: paid.join(' · '),
    items: items.map(({ baseId, rarity }) => ({ name: itemName(baseId, t), rarity })),
  };
}

/** Coins and practice paid, a part each. Practice goes toward the teaching `study` names, and toward none while the dreamer studies nothing. */
function paidParts(coins: number | undefined, practice: number | undefined, study: string | undefined): string[] {
  const toward = study !== undefined && isTeachingId(study) ? teaching(study) : undefined;
  return [
    ...(coins === undefined ? [] : [t('%@c', String(coins))]),
    ...(practice === undefined
      ? []
      : [toward === undefined ? t('%@ practice', String(practice)) : t('%1$@ practice toward %2$@', String(practice), t(toward.labelKey))]),
  ];
}

/** What a quest asks for, a sentence for each objective line, without how far it has come. */
function askedLines(said: Quest): string[] {
  return objectiveLines(said, []).map(({ labelKey, goal }) => t(labelKey, String(goal)));
}

function note(text: string): HTMLElement {
  return element('p', { className: 'form-note', text });
}
