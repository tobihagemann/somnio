import type { ItemInstance } from '@somnio/core';
import { itemName, t } from '@/i18n';
import { button, element, iconButton, setHidden } from './dom';
import { HUD_ICONS, glyph } from './hudIcons';
import { placeBeside, setTip, tipNodes } from './hudTooltip';
import { itemTip } from './itemText';

/**
 * The windows the HUD's menu opens: Players, Character, and the Quest log. Each is a titled panel
 * with a ✕, built once and shown or hidden, its contents kept while what they show is unchanged.
 */

export class HUDWindow {
  readonly root: HTMLElement;

  constructor(title: string, onClose: () => void, body: readonly Node[]) {
    this.root = element('section', {
      className: 'fantasy-panel fantasy-panel--opaque hud-window hidden',
      attributes: { 'aria-label': title },
      children: [...windowHead(title, onClose), ...body],
    });
  }
}

/**
 * A window's title, centred over its whole width, and the ✕ that closes it, a small chrome button
 * on the panel's top-right corner. The ✕ is returned beside the head, not in it, so the panel positions it.
 */
export function windowHead(title: string, onClose: () => void): HTMLElement[] {
  const close = setTip(iconButton(t('Close %@', title), glyph(HUD_ICONS.close), onClose, { className: 'fantasy-button hud-window__close' }));
  return [element('div', { className: 'hud-window__head', children: [element('h2', { className: 'overlay-title', text: title })] }), close];
}

/** What the Players list marks: the player's own name, and the target's. */
export interface PlayersSelection {
  own: string;
  target: string | undefined;
}

/** Every dreamer in the game by name. A press on a name makes that dreamer the target, the player's own making them their own. */
export class PlayersList {
  readonly nodes: readonly HTMLElement[];
  private readonly list: HTMLElement;
  private readonly footer: HTMLElement;
  private readonly onPressPlayer: (name: string) => void;
  private readonly onPressOwn: () => void;
  private shown: string | undefined;

  constructor(onPressPlayer: (name: string) => void, onPressOwn: () => void) {
    this.onPressPlayer = onPressPlayer;
    this.onPressOwn = onPressOwn;
    this.list = element('div', { className: 'hud-list hud-list--players', attributes: { role: 'list' } });
    this.footer = element('div', { className: 'hud-list__footer' });
    this.nodes = [this.list, this.footer];
  }

  render(players: readonly string[], selection: PlayersSelection): void {
    // A name replaced between press and release is never pressed, and the shell renders on every
    // `energy` frame. The roster is sorted in place as names join, so its content is compared.
    const shown = JSON.stringify([players, selection]);
    if (shown === this.shown) return;
    this.shown = shown;
    this.list.replaceChildren(
      ...players.map((name) => {
        const own = name === selection.own;
        const press = element('button', {
          className: 'hud-list__select',
          text: name,
          attributes: { type: 'button', 'aria-pressed': String(name === selection.target) },
        });
        press.addEventListener('click', () => (own ? this.onPressOwn() : this.onPressPlayer(name)));
        return element('div', { className: 'hud-list__row', attributes: { role: 'listitem' }, children: [press] });
      }),
    );
    this.footer.textContent = t('Players: %@', String(players.length));
  }
}

/** An item card's main action and, while it cannot run, why not. A droppable item in the bag also gets a drop. */
export interface ItemAction {
  label: string;
  run: (() => void) | undefined;
  warning?: string;
  drop?: () => void;
}

/**
 * An item's card, opened by a tap on the item or Enter on it: what its tip says, a button for the
 * one thing a press can do with it, and Drop beside it for a carried item. Unlike the HUD's tip it
 * takes the pointer, so it is a dialog that holds a button rather than a tooltip. It closes on a
 * press anywhere else, on Escape, and once its button is pressed.
 */
export class ItemCard {
  readonly root: HTMLElement;
  private readonly onClose: () => void;
  private shown: { itemId: string; anchor: HTMLElement } | undefined;

  /** `onClose` hears of every close, since a part hidden under the pointer reports no leave. */
  constructor(onClose: () => void) {
    this.onClose = onClose;
    this.root = element('section', {
      className: 'fantasy-panel fantasy-panel--opaque hud-tip hud-item-card hidden',
      attributes: { role: 'dialog', tabindex: -1 },
    });
    // Ahead of whatever the press lands on. A press on the item itself closes the card through its click.
    document.addEventListener(
      'pointerdown',
      (event) => {
        if (this.shown === undefined || !(event.target instanceof Node)) return;
        if (!this.root.contains(event.target) && !this.shown.anchor.contains(event.target)) this.close();
      },
      true,
    );
    // Placed beside its item, it would be left behind by a scroll that moves the item, or a resize.
    window.addEventListener(
      'scroll',
      (event) => {
        if (this.shown !== undefined && event.target instanceof Node && event.target.contains(this.shown.anchor)) this.close();
      },
      true,
    );
    window.addEventListener('resize', () => this.close());
  }

  /** The item whose card is open. */
  get itemId(): string | undefined {
    return this.shown?.itemId;
  }

  /** Opens the item's card beside `anchor`, the part it was pressed on, and gives its button the keyboard when `focus` says so. */
  open(anchor: HTMLElement, item: ItemInstance, action: ItemAction, focus: boolean): void {
    this.close();
    const { run, drop } = action;
    const press = button(action.label, () => {
      this.close();
      run?.();
    });
    press.disabled = run === undefined;
    const buttons = [press];
    if (drop !== undefined) {
      buttons.unshift(
        button(t('Drop'), () => {
          this.close();
          drop();
        }),
      );
    }
    this.root.setAttribute('aria-label', itemName(item.baseId, t));
    this.root.replaceChildren(
      ...tipNodes(itemTip(item, action.warning === undefined ? {} : { warning: action.warning })),
      element('div', { className: 'hud-item-card__action', children: buttons }),
    );
    setHidden(this.root, false);
    placeBeside(this.root, anchor, this.root.parentElement ?? this.root);
    anchor.setAttribute('aria-expanded', 'true');
    this.shown = { itemId: item.id, anchor };
    if (focus) (press.disabled ? this.root : press).focus();
  }

  /** Closes the card, handing the keyboard back to its item if the card held it. */
  close(): void {
    if (this.shown === undefined) return;
    const { anchor } = this.shown;
    this.shown = undefined;
    anchor.setAttribute('aria-expanded', 'false');
    const focused = this.root.contains(document.activeElement);
    setHidden(this.root, true);
    if (focused) anchor.focus();
    this.onClose();
  }
}
