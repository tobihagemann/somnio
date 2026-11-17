import { bountyQuest, quest, questLogFull } from '@somnio/core';
import type { QuestLog } from '@somnio/core';
import { wholeSecondsLeft } from '@/client';
import type { ClientQuestOffer } from '@/client';
import { t } from '@/i18n';
import { button, element, setHidden } from './dom';
import { questLines, questTitle, rewardNote } from './questText';

/**
 * What a player sees when a dreamer near them shares a quest: who shares it, the quest with what it
 * asks and pays and where it is turned in, the seconds left to answer, and the two answers. Taking it is greyed out while the player's own quest log is full. It shows while
 * the offer waits, and goes once it is answered, its seconds run out, or the session lets it go.
 */
export class QuestOfferPrompt {
  readonly root: HTMLElement;

  private readonly title: HTMLElement;
  private readonly body: HTMLElement;
  private readonly secondsLeft: HTMLElement;
  private readonly actions: HTMLElement;
  private readonly logFull: HTMLElement;
  private readonly onAnswer: (offerId: number, take: boolean) => void;
  /** Names the carrier, by its id, that a quest is turned in at. */
  private readonly carrierName: (carrierId: string) => string;
  private take: HTMLButtonElement | undefined;
  private offer: ClientQuestOffer | undefined;
  private shown: string | undefined;

  constructor(onAnswer: (offerId: number, take: boolean) => void, carrierName: (carrierId: string) => string) {
    this.onAnswer = onAnswer;
    this.carrierName = carrierName;
    this.title = element('h1', { className: 'overlay-title' });
    this.body = element('div', { className: 'quest-offer-prompt__body' });
    this.secondsLeft = element('p', { className: 'form-note' });
    this.actions = element('div', { className: 'form-actions' });
    this.logFull = element('p', { className: 'form-error', text: t('Your quest log is full. Give up a quest to take this one.') });
    this.root = element('section', {
      className: 'fantasy-panel fantasy-panel--opaque quest-offer-prompt hidden',
      attributes: { 'aria-live': 'polite' },
      children: [this.title, this.body, this.logFull, this.secondsLeft, this.actions],
    });
  }

  /** `study` is the teaching the player studies, which the quest's practice would go toward. */
  render(offer: ClientQuestOffer | undefined, quests: QuestLog, study: string | undefined, nowMs: number): void {
    this.offer = offer;
    // A button replaced between press and release is never pressed, so the prompt is built anew only
    // when what it says changes, and each button answers the offer it was built for.
    const shown = offer === undefined ? undefined : JSON.stringify([offer.offerId, offer.questId, study]);
    if (shown !== this.shown) {
      this.shown = shown;
      if (offer !== undefined) this.say(offer, study);
    }
    const full = questLogFull(quests);
    if (this.take !== undefined) this.take.disabled = full;
    setHidden(this.logFull, !full);
    this.tick(nowMs);
  }

  /** The whole seconds left to answer, which move with time rather than with a frame from the server, and the prompt gone once they run out. */
  tick(nowMs: number): void {
    const offer = this.offer;
    const open = offer !== undefined && nowMs < offer.endsAtMs;
    setHidden(this.root, !open);
    if (!open) return;
    const text = t('%@ s to answer', String(wholeSecondsLeft(offer.endsAtMs, nowMs)));
    if (this.secondsLeft.textContent !== text) this.secondsLeft.textContent = text;
  }

  private say(offer: ClientQuestOffer, study: string | undefined): void {
    const said = offer.bounty === undefined ? quest(offer.questId) : bountyQuest(offer.bounty);
    const heading = t('%@ shares a quest', offer.fromName);
    this.root.setAttribute('aria-label', heading);
    this.title.textContent = heading;
    const turnIn = offer.bounty === undefined ? t('Turn it in to %@.', this.carrierName(said.turnIn)) : t('Turn it in at the bounty board.');
    this.body.replaceChildren(
      element('p', { className: 'quest-offer-prompt__quest', children: [element('strong', { text: questTitle(said, offer.bounty) })] }),
      ...questLines(said, undefined),
      ...rewardNote(said.reward, study),
      element('p', { className: 'form-note', text: turnIn }),
    );
    this.take = button(t('Take the quest'), () => this.onAnswer(offer.offerId, true));
    this.actions.replaceChildren(
      button(t('Not now'), () => this.onAnswer(offer.offerId, false)),
      this.take,
    );
  }
}
