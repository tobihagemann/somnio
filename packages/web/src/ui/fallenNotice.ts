import { t } from '@/i18n';
import { button, element, setHidden } from './dom';

/**
 * What a fallen dreamer is shown: what fallen means, the raise under way if there is one, and the
 * way to give up. Giving up takes two steps and names where the dreamer will wake, because it
 * ends the venture and cannot be taken back.
 */

export interface FallenState {
  fallen: boolean;
  /** The raise being given to the player, with the whole seconds it still takes. */
  raise: { healerName: string; secondsLeft: number } | undefined;
}

export class FallenNotice {
  readonly root: HTMLElement;

  private readonly raise: HTMLElement;
  private readonly giveUp: HTMLButtonElement;
  private readonly confirmation: HTMLElement;

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
        element('p', { className: 'service-text', text: t('You cannot move, but you can still speak. A Heiler can draw you back.') }),
        this.raise,
        this.giveUp,
        this.confirmation,
      ],
    });
  }

  render(state: FallenState): void {
    // Standing again withdraws a confirmation left open, so the next fall starts from the first step.
    if (!state.fallen) this.confirm(false);
    setHidden(this.root, !state.fallen);
    setHidden(this.raise, state.raise === undefined);
    if (state.raise !== undefined) this.raise.textContent = t('%1$@ is drawing you back: %2$@ s', state.raise.healerName, String(state.raise.secondsLeft));
  }

  private confirm(asking: boolean): void {
    setHidden(this.giveUp, asking);
    setHidden(this.confirmation, !asking);
  }
}
