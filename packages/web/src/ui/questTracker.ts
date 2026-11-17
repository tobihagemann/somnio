import { heldQuest, objectiveLines, questComplete } from '@somnio/core';
import type { ActiveQuest, QuestLog, QuestOrBountyId } from '@somnio/core';
import { t } from '@/i18n';
import { element, setHidden } from './dom';
import { HUD_ICONS, glyph } from './hudIcons';
import { countdown, objectiveCount, questLogCount, questTitle, returnLine, runsOutAt, tickCountdowns } from './questText';
import type { Countdown } from './questText';

/** Where the viewer's choice to hide the tracker's list is kept. */
const HIDDEN_KEY = 'somnio.questTracker.hidden';

/** How many quests the tracker lists, those that moved most recently first; the Quest log holds the rest. */
export const TRACKER_SHOWN = 3;

/**
 * A quest held as the tracker says it: its title, then how far each of its lines has come, or once
 * it is done where to turn it in alone, and for a bounty when the board turns, in epoch milliseconds.
 */
export interface TrackedQuest {
  questId: QuestOrBountyId;
  title: string;
  lines: { text: string; count: string; met: boolean }[];
  returnTo: string | undefined;
  turnsAtMs: number | undefined;
}

/**
 * The quests held, always in view beside the world: at most three, those that moved most recently
 * first, the latest leading, then the rest in the log's order, each with its title, how far each of its lines has come, for one done where to turn it in,
 * and for a bounty how long it has left, then "+N more", which opens the Quest log. Its heading
 * counts the quests held against the log's room, and hides and shows the list, a choice kept per
 * browser. A finger's folds the list to its first quest, with a press that unfolds the rest. It keeps
 * its elements while what it says is unchanged.
 */
export class QuestTracker {
  readonly root: HTMLElement;
  private readonly head: HTMLButtonElement;
  private readonly heldCount: HTMLElement;
  private readonly list: HTMLElement;
  private readonly more: HTMLButtonElement;
  private readonly fold: HTMLButtonElement;
  private readonly coarse: boolean;
  /** Names the carrier, by its id, that a done quest is turned in at. */
  private readonly carrierName: (carrierId: string) => string;
  private listHidden = readHidden();
  private unfolded = false;
  /** The quests that moved, the latest first, which the tracker lists first while they are held. */
  private recent: QuestOrBountyId[] = [];
  /** The quest that moved since the last render, whose title flashes as the list is rebuilt for it. */
  private flashing: QuestOrBountyId | undefined;
  private shown: string | undefined;
  private tracked: readonly TrackedQuest[] = [];
  private held = 0;
  private countdowns: Countdown[] = [];

  /** `onOpenLog` opens the Quest log, from "+N more". */
  constructor(coarse: boolean, carrierName: (carrierId: string) => string, onOpenLog: () => void) {
    this.coarse = coarse;
    this.carrierName = carrierName;
    this.heldCount = element('span', { className: 'hud-tracker__held' });
    this.head = element('button', {
      className: 'hud-tracker__head',
      attributes: { type: 'button' },
      children: [
        glyph(HUD_ICONS.quests),
        element('span', { text: t('Quests') }),
        this.heldCount,
        element('span', { className: 'hud-tracker__chevron', attributes: { 'aria-hidden': 'true' } }),
      ],
    });
    this.head.addEventListener('click', () => {
      this.listHidden = !this.listHidden;
      writeHidden(this.listHidden);
      this.showState();
    });
    this.list = element('div', { className: 'hud-tracker__list', attributes: { role: 'list' } });
    this.more = element('button', { className: 'hud-tracker__more', attributes: { type: 'button' } });
    this.more.addEventListener('click', onOpenLog);
    this.fold = element('button', { className: 'hud-tracker__fold', attributes: { type: 'button' } });
    this.fold.addEventListener('click', () => {
      this.unfolded = !this.unfolded;
      this.showState();
    });
    this.root = element('section', {
      className: 'fantasy-panel hud-tracker hidden',
      attributes: { 'aria-label': t('Quests') },
      children: [this.head, this.list, this.more, ...(coarse ? [this.fold] : [])],
    });
    this.showState();
  }

  /** What the tracker lists, in its order, as last rendered. */
  get quests(): readonly TrackedQuest[] {
    return this.tracked;
  }

  /** Whether the player holds no quest, so the tracker does not show at all. */
  get empty(): boolean {
    return this.held === 0;
  }

  /** Whether the list shows under the heading, rather than the heading alone. */
  get listShown(): boolean {
    return !this.listHidden;
  }

  /** Whether a finger's list shows its first quest alone. */
  get folded(): boolean {
    return this.coarse && !this.unfolded;
  }

  /** The quest moved, so it is listed first and its title flashes. */
  moved(questId: QuestOrBountyId): void {
    this.recent = [questId, ...this.recent.filter((recent) => recent !== questId)];
    this.flashing = questId;
  }

  /** `wallMs` is the time now in epoch milliseconds, which a bounty's time left is counted from. */
  render(quests: QuestLog, wallMs: number): void {
    this.recent = this.recent.filter((questId) => quests.active.some((held) => held.questId === questId));
    const moved = this.recent.map((questId) => quests.active.find((held) => held.questId === questId)!);
    const ordered = [...moved, ...quests.active.filter((held) => !moved.includes(held))];
    const tracked = ordered.slice(0, TRACKER_SHOWN).map((held) => trackedQuest(held, this.carrierName));
    const flashing = this.flashing;
    this.flashing = undefined;
    // A heading or a fold replaced between press and release is never pressed, and the shell
    // renders on every `energy` frame, so the list is rebuilt only when what it says has changed.
    const shown = JSON.stringify([tracked, ordered.length]);
    if (shown === this.shown) return;
    this.shown = shown;
    this.tracked = tracked;
    this.held = ordered.length;
    this.countdowns = [];
    this.list.replaceChildren(
      ...tracked.map(({ questId, title, lines, returnTo, turnsAtMs }) => {
        const runsOut = turnsAtMs === undefined ? undefined : countdown('hud-tracker__expires', turnsAtMs, (left) => t('Runs out in %@', left));
        if (runsOut !== undefined) this.countdowns.push(runsOut);
        return element('div', {
          className: `hud-tracker__quest${returnTo === undefined ? '' : ' hud-tracker__quest--done'}${questId === flashing ? ' hud-tracker__quest--moved' : ''}`,
          attributes: { role: 'listitem', 'data-quest': questId },
          children: [
            element('p', { className: 'hud-tracker__title', text: title }),
            ...lines.map(({ text, count, met }) =>
              element('p', {
                className: `hud-tracker__line${met ? ' hud-tracker__line--met' : ''}`,
                children: [document.createTextNode(`${text} `), element('span', { className: 'hud-tracker__count', text: count })],
              }),
            ),
            ...(returnTo === undefined ? [] : [element('p', { className: 'hud-tracker__return', text: returnTo })]),
            ...(runsOut === undefined ? [] : [runsOut.node]),
          ],
        });
      }),
    );
    this.tick(wallMs);
    this.showState();
  }

  /** How long each bounty listed has left, which moves with time rather than with a frame from the server. */
  tick(wallMs: number): void {
    tickCountdowns(this.countdowns, wallMs);
  }

  /** Shows the list or the heading alone, and a finger's list folded or not, on the elements it has. */
  private showState(): void {
    const listed = this.tracked.length;
    this.root.classList.toggle('hud-tracker--collapsed', this.listHidden);
    this.head.setAttribute('aria-expanded', String(!this.listHidden));
    this.head.setAttribute('aria-label', this.listHidden ? t('Show quests (%@)', String(this.held)) : t('Hide quests'));
    this.heldCount.textContent = questLogCount(this.held);
    setHidden(this.list, this.listHidden);
    [...this.list.children].forEach((quest, index) => setHidden(quest as HTMLElement, this.folded && index > 0));
    // A finger's fold unfolds the quests listed; past those, the Quest log holds the rest.
    setHidden(this.more, this.listHidden || this.folded || this.held <= listed);
    this.more.textContent = t('+%@ more', String(this.held - listed));
    setHidden(this.fold, this.listHidden || listed < 2);
    this.fold.textContent = this.unfolded ? t('Tap to fold') : t('+%@ more', String(listed - 1));
  }
}

/** A quest held as the tracker says it: a done one by where to turn it in alone. */
function trackedQuest(held: ActiveQuest, carrierName: (carrierId: string) => string): TrackedQuest {
  const said = heldQuest(held);
  const title = questTitle(said, held.definition);
  const turnsAtMs = runsOutAt(held);
  if (questComplete(held)) return { questId: held.questId, title, lines: [], returnTo: returnLine(held, carrierName), turnsAtMs };
  const lines = objectiveLines(said, held.progress).map((line) => ({ ...objectiveCount(line), met: line.done >= line.goal }));
  return { questId: held.questId, title, lines, returnTo: undefined, turnsAtMs };
}

/** The viewer's choice to hide the list, kept in `localStorage`, which throws in a sandboxed frame and when site data is blocked: then the list shows. */
function readHidden(): boolean {
  try {
    return globalThis.localStorage.getItem(HIDDEN_KEY) === '1';
  } catch {
    return false;
  }
}

/** A choice that cannot be kept holds for this page alone. */
function writeHidden(hidden: boolean): void {
  try {
    if (hidden) globalThis.localStorage.setItem(HIDDEN_KEY, '1');
    else globalThis.localStorage.removeItem(HIDDEN_KEY);
  } catch {
    // Kept in memory only.
  }
}
