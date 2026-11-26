import { t } from '@/i18n';
import { button, element, setHidden } from './dom';

/** How long the cover stands before it says what it waits for and offers to load it again. */
const STALLED_MS = 3000;

/**
 * What hides the world and the HUD while the player's own body is dressed on entering a space, so
 * they never see themselves undressed. What it covers keeps its state but takes no focus, keys, or
 * pointer, and the cover holds the keyboard until it lowers. After a while it says the player's gear
 * is still loading and offers to load it again. Only the gear being drawn lowers it.
 */
export class LoadingCover {
  readonly root: HTMLElement;

  private readonly covered: readonly HTMLElement[];
  private readonly stalled: HTMLElement;
  /** When the cover rose, while it stands. */
  private raisedAtMs: number | undefined;
  /** What had the keyboard as the cover rose, which gets it back as the cover lowers. */
  private returnFocus: HTMLElement | undefined;

  constructor(covered: readonly HTMLElement[], onRetry: () => void) {
    this.covered = covered;
    this.stalled = element('div', {
      className: 'fantasy-panel fantasy-panel--opaque loading-cover__card hidden',
      attributes: { 'aria-live': 'polite' },
      children: [
        element('p', { className: 'service-text', text: t('Your gear is still loading.') }),
        element('div', { className: 'form-actions', children: [button(t('Try Again'), onRetry)] }),
      ],
    });
    this.root = element('div', {
      className: 'blocking-notice loading-cover hidden',
      attributes: { role: 'dialog', 'aria-modal': 'true', 'aria-label': t('Loading the world...'), tabindex: -1 },
      children: [this.stalled],
    });
  }

  get shown(): boolean {
    return this.raisedAtMs !== undefined;
  }

  /**
   * Raises or lowers the cover. Lowering hands the keyboard back to what had it as the cover rose
   * only with `handBack`. That is false while something over the cover, such as the game menu or the
   * turn-sideways card, holds the player.
   */
  render(covering: boolean, nowMs: number, handBack: boolean): void {
    if (covering && !this.shown) this.raise(nowMs);
    else if (!covering && this.shown) this.lower(handBack);
    this.tick(nowMs);
  }

  /** Says the gear is still loading once the cover has stood `STALLED_MS`. */
  tick(nowMs: number): void {
    if (this.raisedAtMs !== undefined && nowMs - this.raisedAtMs >= STALLED_MS && this.stalled.classList.contains('hidden')) setHidden(this.stalled, false);
  }

  private raise(nowMs: number): void {
    const focused = document.activeElement;
    this.returnFocus = focused instanceof HTMLElement && focused !== document.body ? focused : undefined;
    this.raisedAtMs = nowMs;
    setHidden(this.root, false);
    this.root.focus({ preventScroll: true });
    // After the focus has moved, since a field made inert drops it without handing it on.
    for (const node of this.covered) node.inert = true;
  }

  private lower(handBack: boolean): void {
    this.raisedAtMs = undefined;
    for (const node of this.covered) node.inert = false;
    const holding = this.root.contains(document.activeElement);
    setHidden(this.root, true);
    setHidden(this.stalled, true);
    // Unless the keyboard went elsewhere meanwhile.
    if (handBack && holding && this.returnFocus?.isConnected === true) this.returnFocus.focus({ preventScroll: true });
    this.returnFocus = undefined;
  }
}
