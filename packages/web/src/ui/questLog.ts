import { heldQuest, questComplete } from '@somnio/core';
import type { QuestLog, QuestOrBountyId } from '@somnio/core';
import { t } from '@/i18n';
import { button, element, setHidden } from './dom';
import { questLines, questTitle, returnLine, rewardNote } from './questText';

/**
 * The Quest log window's contents: every quest the player holds with what it asks, how far it has
 * come, and what it pays, where to turn in one that is done, and a way to give each up. Opened
 * from the menu, the sheet, and L, like the other windows.
 */
export class QuestLogList {
  readonly nodes: readonly HTMLElement[];
  private readonly list: HTMLElement;
  private readonly empty: HTMLElement;
  private readonly onAbandon: (questId: QuestOrBountyId) => void;
  /** Names the carrier, by its id, that a done quest is turned in at. */
  private readonly carrierName: (carrierId: string) => string;
  private shown: string | undefined;

  constructor(onAbandon: (questId: QuestOrBountyId) => void, carrierName: (carrierId: string) => string) {
    this.onAbandon = onAbandon;
    this.carrierName = carrierName;
    this.list = element('div', { className: 'hud-list hud-list--quests', attributes: { role: 'list' } });
    this.empty = element('p', { className: 'form-note hud-quests__empty', text: t('You hold no quests. A gold ! marks who offers one.') });
    this.nodes = [this.empty, this.list];
  }

  /** `study` is the teaching the player studies, which a quest's practice goes toward. */
  render(quests: QuestLog, study: string | undefined): void {
    // A button replaced between press and release is never pressed, and the shell renders on every
    // `energy` frame, so the log is rebuilt only when what it says has changed.
    const entries = quests.active.map((held) => ({ held, returnTo: questComplete(held) ? returnLine(held, this.carrierName) : undefined }));
    const shown = JSON.stringify([study, entries]);
    if (shown === this.shown) return;
    this.shown = shown;
    setHidden(this.empty, entries.length > 0);
    this.list.replaceChildren(
      ...entries.map(({ held, returnTo }) => {
        const said = heldQuest(held);
        const title = questTitle(said, held.definition);
        const giveUp = button(t('Give up'), () => this.onAbandon(held.questId), { className: 'fantasy-button fantasy-button--compact' });
        giveUp.setAttribute('aria-label', t('Give up %@', title));
        return element('div', {
          className: 'hud-quest',
          attributes: { role: 'listitem', 'data-quest': held.questId },
          children: [
            element('div', { className: 'hud-quest__head', children: [element('strong', { text: title }), giveUp] }),
            ...questLines(said, held),
            ...rewardNote(said.reward, study),
            ...(returnTo === undefined ? [] : [element('p', { className: 'hud-quest__return', text: returnTo })]),
          ],
        });
      }),
    );
  }
}
