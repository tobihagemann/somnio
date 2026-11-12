import type { Rarity } from '@somnio/protocol';
import { t } from '@/i18n';
import { element, setHidden } from './dom';

/** How long the line over the world says a count, and the banner a quest taken on, done, or turned in, in ms, each fading in and out over its time. */
export const QUEST_LINE_MS = 3200;
export const QUEST_BANNER_MS = 4500;

/** A line of a quest held and how far it has come, as the line says it. */
export interface QuestCount {
  text: string;
  count: string;
}

/** A quest taken on, and what it asks for, as the banner says it: a line for each objective line. */
export interface QuestAccepted {
  title: string;
  lines: readonly string[];
}

/** A quest held that is now done, and where to turn it in, as the banner says it. */
export interface QuestDone {
  title: string;
  returnTo: string;
}

/** A quest turned in, and what it paid, as the banner says it: what it granted and paid in one line, and each item it gave by name in its rarity. */
export interface QuestTurnIn {
  title: string;
  paid: string;
  items: readonly { name: string; rarity: Rarity }[];
}

/**
 * What moved in the quests held, said over the world under the target frame: one line as a count
 * moves, and a banner, larger and in gold, as a quest is taken on, done, or turned in. One shows
 * at a time. A newer count replaces the line and starts it over, and a banner cuts it short. A
 * banner arriving while another shows waits its turn, and so does a count, behind every banner
 * waiting, the newest replacing any count that waits. Each is timed on the HUD's clock and ends on
 * its tick.
 */
export class QuestFeedback {
  readonly line: HTMLElement;
  readonly banner: HTMLElement;
  private shown: { place: HTMLElement; endsAtMs: number } | undefined;
  private readonly waitingBanners: HTMLElement[] = [];
  private waitingCount: QuestCount | undefined;

  constructor() {
    this.line = element('div', { className: 'hud-quest-line hidden', attributes: { role: 'status', 'aria-live': 'polite' } });
    this.banner = element('div', { className: 'hud-quest-banner hidden', attributes: { role: 'status', 'aria-live': 'polite' } });
  }

  /** Says a count over the world, at once unless a banner shows. */
  showCount(count: QuestCount, nowMs: number): void {
    if (this.shown?.place === this.banner) this.waitingCount = count;
    else this.sayCount(count, nowMs);
  }

  /** Says a quest taken on over the world, at once unless another banner shows. */
  showAccepted({ title, lines }: QuestAccepted, nowMs: number): void {
    this.showBanner(
      title,
      lines.map((line) => element('p', { className: 'hud-quest-banner__line', text: line })),
      nowMs,
      t('Quest accepted'),
    );
  }

  /** Says a quest done over the world, at once unless another banner shows. */
  showDone({ title, returnTo }: QuestDone, nowMs: number): void {
    this.showBanner(title, [element('p', { className: 'hud-quest-banner__line', text: returnTo })], nowMs);
  }

  /** Says a quest turned in over the world, at once unless another banner shows. */
  showTurnIn({ title, paid, items }: QuestTurnIn, nowMs: number): void {
    this.showBanner(
      title,
      [
        ...(paid === '' ? [] : [element('p', { className: 'hud-quest-banner__line', text: paid })]),
        ...items.map(({ name, rarity }) => element('p', { className: `hud-quest-banner__line hud-quest-banner__item hud-rarity--${rarity}`, text: name })),
      ],
      nowMs,
    );
  }

  /** Ends what has had its time, and says what waits next. */
  tick(nowMs: number): void {
    if (this.shown === undefined || nowMs < this.shown.endsAtMs) return;
    this.end();
    const banner = this.waitingBanners.shift();
    if (banner !== undefined) {
      this.say(this.banner, banner, QUEST_BANNER_MS, nowMs);
      return;
    }
    const count = this.waitingCount;
    this.waitingCount = undefined;
    if (count !== undefined) this.sayCount(count, nowMs);
  }

  /** Takes away what shows and what waits, as the HUD hides. */
  clear(): void {
    this.end();
    this.waitingBanners.length = 0;
    this.waitingCount = undefined;
  }

  private sayCount({ text, count }: QuestCount, nowMs: number): void {
    const said = element('p', {
      className: 'hud-quest-line__said',
      children: [document.createTextNode(`${text} `), element('span', { className: 'hud-quest-line__count', text: count })],
    });
    this.say(this.line, said, QUEST_LINE_MS, nowMs);
  }

  /** A banner, its title in gold over its lines and under a small `kicker` where it has one, said at once unless another banner shows, when it waits its turn. */
  private showBanner(title: string, lines: readonly HTMLElement[], nowMs: number, kicker?: string): void {
    const said = element('div', {
      className: 'hud-quest-banner__said',
      children: [
        ...(kicker === undefined ? [] : [element('p', { className: 'hud-quest-banner__kicker', text: kicker })]),
        element('p', { className: 'overlay-title hud-quest-banner__title', text: title }),
        ...lines,
      ],
    });
    if (this.shown?.place === this.banner) this.waitingBanners.push(said);
    else this.say(this.banner, said, QUEST_BANNER_MS, nowMs);
  }

  /** Shows what is said in its place for its time. Its fade is a CSS animation, which starts only on a new element, so each saying is one. */
  private say(place: HTMLElement, said: HTMLElement, durationMs: number, nowMs: number): void {
    this.end();
    said.style.animationDuration = `${durationMs}ms`;
    place.replaceChildren(said);
    setHidden(place, false);
    this.shown = { place, endsAtMs: nowMs + durationMs };
  }

  private end(): void {
    if (this.shown === undefined) return;
    setHidden(this.shown.place, true);
    this.shown.place.replaceChildren();
    this.shown = undefined;
  }
}
