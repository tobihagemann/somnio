import { boardTurnsAt, bountiesClosed, heldQuest, isTeachingId, objectiveLines, questLogFull, roleLabelKey, teaching, turnInGrant } from '@somnio/core';
import type { ActiveQuest, BountiesClosed, Bounty, ObjectiveLine, Quest, QuestLog, QuestReward } from '@somnio/core';
import { SOMNIO_PROTOCOL_CONSTANTS } from '@somnio/protocol';
import type { Role } from '@somnio/protocol';
import type { QuestTurnedIn } from '@/client';
import { bountyTitleIn, itemName, t } from '@/i18n';
import { element } from './dom';
import type { QuestAccepted, QuestTurnIn } from './questFeedback';

/** A quest's title: a bounty's names the land it is set in. */
export function questTitle(said: Quest, bounty?: Bounty): string {
  return bounty === undefined ? t(said.labelKey) : bountyTitleIn(bounty.land, t);
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

/** Where a done quest is turned in: its carrier, back where it was given or on to another, or for a bounty any bounty board. */
export function returnLine(held: ActiveQuest, carrierName: (carrierId: string) => string): string {
  if (held.definition !== undefined) return t('Return to the bounty board.');
  const { giver, turnIn } = heldQuest(held);
  return turnIn === giver ? t('Return to %@.', carrierName(turnIn)) : t('Turn it in to %@.', carrierName(turnIn));
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

/**
 * What a quest pays, as a carrier's panel and the Quest log say it under what it asks: "Reward: 60c,
 * 30 practice toward Toughening, a piece of gear", a bounty's "an uncommon item", or to a reader
 * with a role, a set piece's "a piece of your role's set".
 */
export function rewardNote(reward: QuestReward | undefined, study: string | undefined, role: Role | undefined): HTMLElement[] {
  const item = rewardItem(reward, role);
  const parts = [...paidParts(reward?.coins, reward?.practice, study), ...(item === undefined ? [] : [item])];
  return parts.length === 0 ? [] : [note(t('Reward: %@', parts.join(', ')))];
}

/** How a quest's reward says the item it pays, by the reader's role; `undefined` for a reward of no item. */
function rewardItem(reward: QuestReward | undefined, role: Role | undefined): string | undefined {
  if (reward?.gear === undefined) return undefined;
  if (reward.setPiece === true && role !== undefined) return t("a piece of your role's set");
  if (reward.gearRarity === 'uncommon') return t('an uncommon item');
  return t('a piece of gear');
}

/**
 * Why the dreamer cannot take on a quest offered them, said beside a greyed-out Take, or `undefined`
 * when neither of these holds it back. For a bounty (`bounty`) that is the day's three taken
 * (`bountiesClosed`), else a full log. When both hold, only the cap's line is said, since making
 * room in the log would not lift it.
 */
export function takeRefusal(bounty: Bounty | undefined, quests: QuestLog): string | undefined {
  const closed = bounty === undefined ? undefined : bountiesClosed(bounty.day, quests);
  if (closed !== undefined) return bountyClosedText(closed);
  return questLogFull(quests) ? t('Your quest log is full. Give up a quest to take this one.') : undefined;
}

function bountyClosedText(closed: BountiesClosed): string {
  switch (closed) {
    case 'giveUpOne':
      return t('You have taken three bounties today. Give up one you hold to take this one.');
    case 'nextDay':
      return t('You have taken three bounties today. New ones go up at 00:00 UTC.');
  }
}

/** How full the quest log is, the quests held against its room, as the tracker and the Quest log say it: "4/10". */
export function questLogCount(held: number): string {
  return `${held}/${SOMNIO_PROTOCOL_CONSTANTS.maxActiveQuests}`;
}

/** When the board turns on a bounty held, in epoch milliseconds; `undefined` for any other quest. */
export function runsOutAt(held: ActiveQuest): number | undefined {
  return held.definition === undefined ? undefined : boardTurnsAt(held.definition.day);
}

/** How long until `untilMs`, both in epoch milliseconds, as the board's turn is counted down: whole hours, and under an hour whole minutes, both rounded down. */
export function timeLeft(untilMs: number, nowMs: number): string {
  const minutes = Math.floor(Math.max(0, untilMs - nowMs) / 60_000);
  return minutes < 60 ? t('%@ min', String(minutes)) : t('%@ h', String(Math.floor(minutes / 60)));
}

/** A line saying how long a bounty held has left before the board turns, whose text `tickCountdowns` moves with time. */
export interface Countdown {
  node: HTMLElement;
  turnsAtMs: number;
  say: (left: string) => string;
}

export function countdown(className: string, turnsAtMs: number, say: (left: string) => string): Countdown {
  return { node: element('p', { className }), turnsAtMs, say };
}

/** Says each countdown's time left at `wallMs`, epoch milliseconds, touching a line only when its text changes. */
export function tickCountdowns(countdowns: readonly Countdown[], wallMs: number): void {
  for (const { node, turnsAtMs, say } of countdowns) {
    const text = say(timeLeft(turnsAtMs, wallMs));
    if (node.textContent !== text) node.textContent = text;
  }
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
    items: items.map(({ baseId, tier, rarity, line }) => ({ name: itemName(baseId, tier, line, t), rarity })),
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
