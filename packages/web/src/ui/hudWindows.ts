import type { InventoryRowMessage } from '@somnio/protocol';
import type { ItemId } from '@somnio/core';
import { itemName, t } from '@/i18n';
import { element, iconButton } from './dom';
import { HUD_ICONS, glyph } from './hudIcons';

/**
 * The windows the HUD's menu opens: Players and the Bag. Each is a titled panel with a ✕, built
 * once and shown or hidden, its rows kept while what they show is unchanged.
 */

export class HUDWindow {
  readonly root: HTMLElement;

  constructor(title: string, onClose: () => void, body: readonly Node[]) {
    this.root = element('section', {
      className: 'fantasy-panel fantasy-panel--opaque hud-window hidden',
      attributes: { 'aria-label': title },
      children: [windowHead(title, onClose), ...body],
    });
  }
}

/** A window's title and the ✕ that closes it. */
export function windowHead(title: string, onClose: () => void): HTMLElement {
  const close = iconButton(t('Close %@', title), glyph(HUD_ICONS.close), onClose, { className: 'hud-window__close' });
  return element('div', { className: 'hud-window__head', children: [element('h2', { className: 'overlay-title', text: title }), close] });
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

/**
 * The trailing cell of an item row: the purse's coin count, else the equip marker. `[L]`/`[R]` are
 * layout markers, not translatable text, and the player never picks a hand, so this only reflects
 * what the server says.
 */
function rowMarker(row: InventoryRowMessage): string {
  if (row.itemId === ('purse' satisfies ItemId)) return String(row.quantity);
  if (row.equippedHand === 'left') return '[L]';
  if (row.equippedHand === 'right') return '[R]';
  return '';
}

/** What the player carries. A double click on a row, or Enter on it, uses the item: equips or puts away a weapon, takes the Moonstone in hand or, with it already in hand, mends its holder, and says the purse's coins in the chat. */
export class BagList {
  readonly nodes: readonly HTMLElement[];
  private readonly list: HTMLElement;
  private readonly footer: HTMLElement;
  private readonly onActivate: (row: InventoryRowMessage) => void;
  private shown: readonly InventoryRowMessage[] | undefined;

  constructor(onActivate: (row: InventoryRowMessage) => void) {
    this.onActivate = onActivate;
    this.list = element('div', { className: 'hud-list hud-list--bag', attributes: { role: 'list' } });
    this.footer = element('div', { className: 'hud-list__footer' });
    this.nodes = [this.list, this.footer];
  }

  render(rows: readonly InventoryRowMessage[]): void {
    // A row replaced between the two clicks of a double click, or while it holds the keyboard
    // focus, is never activated, and the shell renders on every `energy` frame.
    if (rows === this.shown) return;
    this.shown = rows;
    this.list.replaceChildren(
      ...rows.map((row) => {
        const node = element('div', {
          className: 'hud-list__row hud-list__row--activatable',
          attributes: { role: 'listitem', tabindex: 0 },
          children: [
            element('span', { className: 'hud-list__name', text: itemName(row.itemId, t) }),
            element('span', { className: 'hud-list__marker', text: rowMarker(row) }),
          ],
        });
        node.addEventListener('dblclick', () => this.onActivate(row));
        node.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') this.onActivate(row);
        });
        return node;
      }),
    );
    this.footer.textContent = t('Items: %@', String(rows.length));
  }
}
