import { heldQuest, mayShare, questComplete } from '@somnio/core';
import type { QuestLog, QuestOrBountyId } from '@somnio/core';
import type { Role } from '@somnio/protocol';
import { t } from '@/i18n';
import { button, element, setHidden } from './dom';
import { countdown, questLines, questLogCount, questTitle, returnLine, rewardNote, runsOutAt, tickCountdowns } from './questText';
import type { Countdown } from './questText';

/**
 * The Quest log window's contents: every quest the player holds with what it asks, how far it has
 * come, and what it pays, how long a bounty has left, where to turn in one that is done, and a way
 * to share each but a trial and to give each up. Opened from the menu, the sheet, the tracker's
 * "+N more", and L, like the other windows. Its title counts the quests held against the log's room.
 */
export class QuestLogList {
  readonly nodes: readonly HTMLElement[];
  /** How full the log is, "4/10", which the window's title carries. */
  readonly count: HTMLElement;
  private readonly list: HTMLElement;
  private readonly empty: HTMLElement;
  private readonly onShare: (questId: QuestOrBountyId) => void;
  private readonly onAbandon: (questId: QuestOrBountyId) => void;
  /** Names the carrier, by its id, that a done quest is turned in at. */
  private readonly carrierName: (carrierId: string) => string;
  private countdowns: Countdown[] = [];
  private shown: string | undefined;

  constructor(onShare: (questId: QuestOrBountyId) => void, onAbandon: (questId: QuestOrBountyId) => void, carrierName: (carrierId: string) => string) {
    this.onShare = onShare;
    this.onAbandon = onAbandon;
    this.carrierName = carrierName;
    this.count = element('span', { className: 'hud-window__count' });
    this.list = element('div', { className: 'hud-list hud-list--quests', attributes: { role: 'list' } });
    this.empty = element('p', { className: 'form-note hud-quests__empty', text: t('You hold no quests. A gold ! marks who offers one.') });
    this.nodes = [this.empty, this.list];
  }

  /**
   * `study` is the teaching the player studies, which a quest's practice goes toward, `role` the
   * player's, which a set piece it pays is of, and `wallMs` the time now in epoch milliseconds.
   */
  render(quests: QuestLog, study: string | undefined, role: Role | undefined, wallMs: number): void {
    // A button replaced between press and release is never pressed, and the shell renders on every
    // `energy` frame, so the log is rebuilt only when what it says has changed.
    const entries = quests.active.map((held) => ({ held, returnTo: questComplete(held) ? returnLine(held, this.carrierName) : undefined }));
    const shown = JSON.stringify([study, role, entries]);
    if (shown === this.shown) return;
    this.shown = shown;
    this.count.textContent = questLogCount(entries.length);
    setHidden(this.empty, entries.length > 0);
    this.countdowns = [];
    this.list.replaceChildren(
      ...entries.map(({ held, returnTo }) => {
        const said = heldQuest(held);
        const title = questTitle(said, held.definition);
        const actions: HTMLElement[] = [];
        if (mayShare(held.questId)) {
          const share = button(t('Share quest'), () => this.onShare(held.questId), { className: 'fantasy-button fantasy-button--compact' });
          share.setAttribute('aria-label', t('Share %@ with dreamers near you', title));
          actions.push(share);
        }
        const giveUp = button(t('Give up'), () => this.onAbandon(held.questId), { className: 'fantasy-button fantasy-button--compact' });
        giveUp.setAttribute('aria-label', t('Give up %@', title));
        actions.push(giveUp);
        const turnsAtMs = runsOutAt(held);
        const runsOut =
          turnsAtMs === undefined ? undefined : countdown('hud-quest__expires', turnsAtMs, (left) => t('Runs out in %@, when the board turns.', left));
        if (runsOut !== undefined) this.countdowns.push(runsOut);
        return element('div', {
          className: 'hud-quest',
          attributes: { role: 'listitem', 'data-quest': held.questId },
          children: [
            element('div', { className: 'hud-quest__head', children: [element('strong', { text: title })] }),
            ...questLines(said, held),
            ...(runsOut === undefined ? [] : [runsOut.node]),
            ...rewardNote(said.reward, study, role),
            ...(returnTo === undefined ? [] : [element('p', { className: 'hud-quest__return', text: returnTo })]),
            element('div', { className: 'hud-quest__actions', children: actions }),
          ],
        });
      }),
    );
    this.tick(wallMs);
  }

  /** How long each bounty held has left, which moves with time rather than with a frame from the server. */
  tick(wallMs: number): void {
    tickCountdowns(this.countdowns, wallMs);
  }
}
