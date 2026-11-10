import { wholeSecondsLeft } from '@/client';
import type { ClientRaise } from '@/client';
import { currentLocale, formatNameList, t } from '@/i18n';
import { button, element, setHidden } from './dom';

/**
 * What a fallen dreamer is shown: what fallen means, the raise under way if there is one, and the
 * way to give up. Giving up takes two steps and names where the dreamer will wake, because it
 * ends the venture and cannot be taken back.
 */

export interface FallenState {
  fallen: boolean;
  /** The raise under way on the fallen dreamer, as `GameplaySession.raiseOf` keeps it. */
  raise: ClientRaise | undefined;
}

export class FallenNotice {
  readonly root: HTMLElement;

  private readonly raise: HTMLElement;
  private readonly giveUp: HTMLButtonElement;
  private readonly confirmation: HTMLElement;
  private shownRaise: ClientRaise | undefined;

  constructor(onWake: () => void) {
    this.raise = element('p', { className: 'service-text hidden' });
    this.giveUp = button(t('Give up'), () => this.confirm(true));
    this.confirmation = element('div', {
      className: 'hidden',
      children: [
        element('p', { className: 'service-text', text: t('You will wake at the inn, weakened.') }),
        element('div', { className: 'form-actions', children: [button(t('Stay'), () => this.confirm(false)), button(t('Wake there'), onWake)] }),
      ],
    });
    this.root = element('section', {
      className: 'fantasy-panel fantasy-panel--opaque fallen-notice hidden',
      attributes: { 'aria-label': t('You have fallen'), 'aria-live': 'polite' },
      children: [
        element('h1', { className: 'overlay-title', text: t('You have fallen') }),
        element('p', { className: 'service-text', text: t('You cannot move, but you can still speak. A Healer can draw you back.') }),
        this.raise,
        this.giveUp,
        this.confirmation,
      ],
    });
  }

  render(state: FallenState, nowMs: number): void {
    // Standing again withdraws a confirmation left open, so the next fall starts from the first step.
    if (!state.fallen) this.confirm(false);
    setHidden(this.root, !state.fallen);
    setHidden(this.raise, state.raise === undefined);
    this.shownRaise = state.raise;
    this.tick(nowMs);
  }

  /** The whole seconds left on the raise shown, which move with time rather than with a frame from the server. */
  tick(nowMs: number): void {
    if (this.shownRaise === undefined) return;
    const text = raiseText(this.shownRaise.healerNames, wholeSecondsLeft(this.shownRaise.endsAtMs, nowMs));
    if (this.raise.textContent !== text) this.raise.textContent = text;
  }

  private confirm(asking: boolean): void {
    setHidden(this.giveUp, asking);
    setHidden(this.confirmation, !asking);
  }
}

function raiseText(healerNames: readonly string[], secondsLeft: number): string {
  return healerNames.length === 1
    ? t('%1$@ is drawing you back: %2$@ s', healerNames[0]!, String(secondsLeft))
    : t('%1$@ are drawing you back: %2$@ s', formatNameList(healerNames, currentLocale()), String(secondsLeft));
}
