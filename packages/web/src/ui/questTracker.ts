import { heldQuest, objectiveLines, questComplete } from '@somnio/core';
import type { ActiveQuest, QuestLog, QuestOrBountyId } from '@somnio/core';
import { t } from '@/i18n';
import { element, setHidden } from './dom';
import { HUD_ICONS, glyph } from './hudIcons';
import { objectiveCount, questTitle, returnLine } from './questText';

/** Where the viewer's choice to hide the tracker's list is kept. */
const HIDDEN_KEY = 'somnio.questTracker.hidden';

/** A quest held as the tracker says it: its title, then how far each of its lines has come, or once it is done where to turn it in alone. */
export interface TrackedQuest {
  questId: QuestOrBountyId;
  title: string;
  lines: { text: string; count: string; met: boolean }[];
  returnTo: string | undefined;
}

/**
 * The quests held, always in view beside the world: each title, how far each of its lines has
 * come, and for one done where to turn it in, the quest that last moved first and the rest in the
 * log's order. Its heading hides and shows the list, a choice kept per browser. A finger's folds
 * the list to its first quest, with a press that unfolds the rest. It keeps its elements while what
 * it says is unchanged.
 */
export class QuestTracker {
  readonly root: HTMLElement;
  private readonly head: HTMLButtonElement;
  private readonly heldCount: HTMLElement;
  private readonly list: HTMLElement;
  private readonly fold: HTMLButtonElement;
  private readonly coarse: boolean;
  /** Names the carrier, by its id, that a done quest is turned in at. */
  private readonly carrierName: (carrierId: string) => string;
  private listHidden = readHidden();
  private unfolded = false;
  /** The quest that last moved, which the tracker lists first while it is held. */
  private lastMoved: QuestOrBountyId | undefined;
  /** The quest that moved since the last render, whose title flashes as the list is rebuilt for it. */
  private flashing: QuestOrBountyId | undefined;
  private shown: string | undefined;
  private tracked: readonly TrackedQuest[] = [];

  constructor(coarse: boolean, carrierName: (carrierId: string) => string) {
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
    this.fold = element('button', { className: 'hud-tracker__fold', attributes: { type: 'button' } });
    this.fold.addEventListener('click', () => {
      this.unfolded = !this.unfolded;
      this.showState();
    });
    this.root = element('section', {
      className: 'fantasy-panel hud-tracker hidden',
      attributes: { 'aria-label': t('Quests') },
      children: [this.head, this.list, ...(coarse ? [this.fold] : [])],
    });
    this.showState();
  }

  /** What the tracker says, in its order, as last rendered. */
  get quests(): readonly TrackedQuest[] {
    return this.tracked;
  }

  /** Whether the player holds no quest, so the tracker does not show at all. */
  get empty(): boolean {
    return this.tracked.length === 0;
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
    this.lastMoved = questId;
    this.flashing = questId;
  }

  render(quests: QuestLog): void {
    const first = quests.active.find((held) => held.questId === this.lastMoved);
    const ordered = first === undefined ? quests.active : [first, ...quests.active.filter((held) => held !== first)];
    const tracked = ordered.map((held) => trackedQuest(held, this.carrierName));
    const flashing = this.flashing;
    this.flashing = undefined;
    // A heading or a fold replaced between press and release is never pressed, and the shell
    // renders on every `energy` frame, so the list is rebuilt only when what it says has changed.
    const shown = JSON.stringify(tracked);
    if (shown === this.shown) return;
    this.shown = shown;
    this.tracked = tracked;
    this.list.replaceChildren(
      ...tracked.map(({ questId, title, lines, returnTo }) =>
        element('div', {
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
          ],
        }),
      ),
    );
    this.showState();
  }

  /** Shows the list or the heading alone, and a finger's list folded or not, on the elements it has. */
  private showState(): void {
    const held = this.tracked.length;
    this.root.classList.toggle('hud-tracker--collapsed', this.listHidden);
    this.head.setAttribute('aria-expanded', String(!this.listHidden));
    this.head.setAttribute('aria-label', this.listHidden ? t('Show quests (%@)', String(held)) : t('Hide quests'));
    this.heldCount.textContent = this.listHidden ? `· ${held}` : '';
    setHidden(this.list, this.listHidden);
    [...this.list.children].forEach((quest, index) => setHidden(quest as HTMLElement, this.folded && index > 0));
    setHidden(this.fold, this.listHidden || held < 2);
    this.fold.textContent = this.unfolded ? t('Tap to fold') : t('+%@ more', String(held - 1));
  }
}

/** A quest held as the tracker says it: a done one by where to turn it in alone. */
function trackedQuest(held: ActiveQuest, carrierName: (carrierId: string) => string): TrackedQuest {
  const said = heldQuest(held);
  const title = questTitle(said, held.definition);
  if (questComplete(held)) return { questId: held.questId, title, lines: [], returnTo: returnLine(held, carrierName) };
  const lines = objectiveLines(said, held.progress).map((line) => ({ ...objectiveCount(line), met: line.done >= line.goal }));
  return { questId: held.questId, title, lines, returnTo: undefined };
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
