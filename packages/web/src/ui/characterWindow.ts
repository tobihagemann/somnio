import { EQUIP_SLOTS, SOMNIO_PROTOCOL_CONSTANTS } from '@somnio/protocol';
import type { EquipSlot, LucidityMessage } from '@somnio/protocol';
import { NO_INVENTORY, bagHasRoom, baseItem, droppableItem, itemAtPlace, slotsFor, unequipItem } from '@somnio/core';
import type { Inventory, ItemInstance } from '@somnio/core';
import { NO_LUCIDITY_MESSAGE, TAP_SLOP_PX } from '@/client';
import { itemName, t } from '@/i18n';
import { element, prefersReducedMotion, setHidden } from './dom';
import { HUDWindow, ItemCard } from './hudWindows';
import type { ItemAction } from './hudWindows';
import { placeBeside, setTip } from './hudTooltip';
import { itemIcon } from './itemIcons';
import { itemTip, slotName } from './itemText';
import { statGroups } from './characterStats';

/** What a press in the Character window does. */
export interface CharacterCallbacks {
  onTellPurse: () => void;
  onEquip: (itemId: string, slot?: EquipSlot) => void;
  onUnequip: (slot: EquipSlot) => void;
  onMoveItem: (itemId: string, place: number) => void;
  /** `at` is where on the page a drag let the item go over the world, which it is thrown toward. */
  onDropItem: (itemId: string, at?: { clientX: number; clientY: number }) => void;
}

/** The window's tabs: a mouse's two, and a finger's three, the doll on a tab of its own. */
const CHARACTER_TABS = ['gear', 'items', 'stats'] as const;
type CharacterTab = (typeof CHARACTER_TABS)[number];

/** Where an item lies: at a place in the bag, or worn in a slot. */
type ItemSource = { place: number } | { slot: EquipSlot };

/** The bag's columns, which the doll's places line up with: its outer places in the first and the last. `hud.css` sizes the window by the same count. */
const COLUMNS = { fine: 8, coarse: 6 } as const;

/** How far a press moves before it lifts its item, in CSS pixels: a mouse's at once, a finger's past a tap. */
const LIFT_SLOP_PX = { mouse: 4, other: TAP_SLOP_PX } as const;

/** How long an item carried over a tab waits there before the tab opens, so a finger can carry an item from Items to Gear. */
export const TAB_SPRING_MS = 450;

/** How long a refusal's line and its shake show. */
const REFUSAL_MS = 1800;

/** The body's turn by a drag: radians per CSS pixel across. */
const TURN_PER_PX = 0.012;

/** The body sways this far either side of its view, over this many seconds, and holds still this long after a drag turned it. */
const SWAY = { radians: (40 * Math.PI) / 180, periodMs: 14_000, pauseMs: 3500 } as const;

/**
 * Where each slot stands on the doll's grid, column and row from 1, in a window of `columns`:
 * armour down the first column, the neck and rings down the last, the hands under the body.
 */
function dollPlace(slot: EquipSlot, columns: number): [column: number, row: number] {
  switch (slot) {
    case 'head':
      return [1, 1];
    case 'chest':
      return [1, 2];
    case 'hands':
      return [1, 3];
    case 'legs':
      return [1, 4];
    case 'feet':
      return [1, 5];
    case 'neck':
      return [columns, 1];
    case 'ring1':
      return [columns, 2];
    case 'ring2':
      return [columns, 3];
    case 'mainHand':
      return [columns / 2, 5];
    case 'offHand':
      return [columns / 2 + 1, 5];
  }
}

/** A slot's name on its empty place, where either ring slot is a Ring. */
function placeName(slot: EquipSlot): string {
  return slotName(slot === 'ring1' || slot === 'ring2' ? 'ring' : slot);
}

function sourceKey(source: ItemSource): string {
  return 'place' in source ? `place:${source.place}` : `slot:${source.slot}`;
}

/** An item pressed, from pointerdown until it is let go. It is carried (`lifted`) once the press moves past `LIFT_SLOP_PX`. */
interface Carry {
  pointerId: number;
  pointerType: string;
  item: ItemInstance;
  source: ItemSource;
  startX: number;
  startY: number;
  /** Where on the item it was taken, so the ghost keeps that offset from the pointer. */
  grabX: number;
  grabY: number;
  lifted: boolean;
  over: Element | undefined;
  tab: { id: CharacterTab; timer: ReturnType<typeof setTimeout> } | undefined;
}

/** What lies under the pointer for a carried item. */
type DropTarget =
  | { kind: 'slot'; node: HTMLElement; slot: EquipSlot }
  | { kind: 'place'; node: HTMLElement; place: number }
  | { kind: 'tab'; id: CharacterTab }
  | { kind: 'world'; clientX: number; clientY: number }
  | { kind: 'none' };

/** Why a carried item cannot go where it is held: the ghost's short caption over it, and the line beside the place on letting go. */
interface Refusal {
  caption: string;
  notice: string;
}

/**
 * The Character window, Diablo's: the dreamer's live body with the ten slots round it, the purse and
 * the bag's places, and a tab of the whole totals the rules read. A mouse's tabs are Items and Stats;
 * a finger's are Gear, Items, and Stats.
 *
 * A mouse resting on an item shows its tip, and a double click or a right click wears or puts it
 * away; a single click does nothing. A finger's tap opens the item's card. Either drags an item
 * between places and slots, or out onto the world to drop it, and an item carried over a tab opens
 * it. Dragging the body turns it, in this view alone.
 */
export class CharacterWindow {
  readonly window: HUDWindow;
  /** Where the scene draws the dreamer's body, on the canvas under the window. */
  readonly body: HTMLElement;
  readonly card: ItemCard;
  /** A refusal's line, beside the part refused. */
  readonly notice: HTMLElement;
  /** What follows the pointer while an item is carried. */
  readonly ghost: HTMLElement;
  /** The ghost's caption saying where the carried item cannot go. */
  private readonly ghostRefusal: HTMLElement;

  private readonly callbacks: CharacterCallbacks;
  private readonly coarse: boolean;
  private readonly columns: number;
  private readonly onLift: () => void;
  private readonly tabs = new Map<CharacterTab, HTMLButtonElement>();
  private readonly pages = new Map<CharacterTab, HTMLElement>();
  private readonly purseAmount: HTMLElement;
  private readonly places: Record<EquipSlot, HTMLElement>;
  private readonly cells: HTMLElement[];
  private readonly stats: HTMLElement;
  private readonly reducedMotion: boolean;
  private tab: CharacterTab;
  private inventory: Inventory = NO_INVENTORY;
  private lucidity: LucidityMessage = NO_LUCIDITY_MESSAGE;
  private shown: { inventory: Inventory; lucidity: LucidityMessage } | undefined;
  /** The totals the Stats tab last showed, by line, so one that changed since is marked. */
  private shownStats: Map<string, string> | undefined;
  private statsStale = true;
  private carry: Carry | undefined;
  /** A press that lifted its item is no click on it. */
  private swallowClick = false;
  private lastPointerType = '';
  private refusal: { anchor: HTMLElement; timer: ReturnType<typeof setTimeout> } | undefined;
  private turn = { radians: 0, swayFromMs: 0, pausedUntilMs: 0 };
  private turning: { pointerId: number; x: number; radians: number } | undefined;
  private hole: string | undefined;
  private readonly now: () => number;

  /** `onLift` hears when an item is lifted, so the HUD's tip gives way to it. */
  constructor(callbacks: CharacterCallbacks, coarse: boolean, onClose: () => void, onCardClose: () => void, onLift: () => void, now: () => number) {
    this.callbacks = callbacks;
    this.coarse = coarse;
    this.columns = coarse ? COLUMNS.coarse : COLUMNS.fine;
    this.onLift = onLift;
    this.now = now;
    this.reducedMotion = prefersReducedMotion();
    this.turn.swayFromMs = now();
    this.card = new ItemCard(onCardClose);
    this.notice = element('div', { className: 'fantasy-panel fantasy-panel--opaque hud-tip hud-notice hidden', attributes: { role: 'status' } });
    this.ghost = element('div', { className: 'hud-ghost hidden', attributes: { 'aria-hidden': 'true' } });
    this.ghostRefusal = element('span', { className: 'hud-ghost__caption hud-ghost__caption--refuse' });

    this.body = element('div', {
      className: 'hud-body',
      attributes: { role: 'img', 'aria-label': t('Your dreamer, wearing what is equipped. Drag to turn.') },
    });
    this.body.style.gridColumn = `2 / ${this.columns}`;
    this.body.style.gridRow = '1 / 5';
    this.body.addEventListener('pointerdown', (event) => this.startTurn(event));
    const places: Partial<Record<EquipSlot, HTMLElement>> = {};
    for (const slot of EQUIP_SLOTS) {
      const place = element('div', { className: 'hud-place hud-place--slot', attributes: { 'data-slot': slot } });
      const [column, row] = dollPlace(slot, this.columns);
      place.style.gridColumn = String(column);
      place.style.gridRow = String(row);
      places[slot] = place;
    }
    this.places = places as Record<EquipSlot, HTMLElement>;
    const doll = element('div', { className: 'hud-doll', children: [this.body, ...EQUIP_SLOTS.map((slot) => this.places[slot])] });

    this.purseAmount = element('strong');
    const purse = element('div', {
      className: 'hud-purse',
      attributes: { tabindex: 0 },
      children: [element('span', { text: t('Your purse') }), this.purseAmount],
    });
    purse.addEventListener('dblclick', () => callbacks.onTellPurse());
    purse.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') callbacks.onTellPurse();
    });
    this.cells = Array.from({ length: SOMNIO_PROTOCOL_CONSTANTS.maxBagItems }, (_, place) =>
      element('div', { className: 'hud-place', attributes: { 'data-place': place } }),
    );
    const grid = element('div', { className: 'hud-bag', attributes: { role: 'group', 'aria-label': t('Bag') }, children: this.cells });
    this.stats = element('div', { className: 'hud-stats' });

    const pages: [CharacterTab, string, Node[]][] = coarse
      ? [
          ['gear', t('Gear'), [doll]],
          ['items', t('Items'), [purse, grid]],
          ['stats', t('Stats'), [this.stats]],
        ]
      : [
          ['items', t('Items'), [doll, purse, grid]],
          ['stats', t('Stats'), [this.stats]],
        ];
    this.tab = pages[0]![0];
    for (const [id, label, children] of pages) {
      const page = element('div', { className: `hud-page hud-page--${id}`, attributes: { role: 'tabpanel', 'aria-label': label }, children });
      const tab = element('button', { className: 'hud-tab', text: label, attributes: { type: 'button', role: 'tab', 'data-tab': id } });
      tab.addEventListener('click', () => this.selectTab(id));
      this.tabs.set(id, tab);
      this.pages.set(id, page);
    }
    const tablist = element('div', { className: 'hud-tabs', attributes: { role: 'tablist' }, children: [...this.tabs.values()] });
    this.window = new HUDWindow(t('Character'), onClose, [tablist, ...this.pages.values()]);
    this.window.root.classList.add('hud-window--character');
    this.selectTab(this.tab);

    const root = this.window.root;
    root.addEventListener('pointerdown', (event) => this.press(event));
    root.addEventListener('click', (event) => this.click(event));
    root.addEventListener('dblclick', (event) => this.act(event));
    root.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      if (this.lastPointerType === 'mouse') this.act(event);
    });
    window.addEventListener('pointermove', (event) => this.move(event));
    window.addEventListener('pointerup', (event) => this.release(event, false));
    window.addEventListener('pointercancel', (event) => this.release(event, true));
  }

  get root(): HTMLElement {
    return this.window.root;
  }

  render(inventory: Inventory, lucidity: LucidityMessage): void {
    // The shell renders on every `energy` frame. An item rebuilt between the two clicks of a double
    // click, or while it holds the keyboard focus, would lose the press.
    if (this.shown?.inventory === inventory && this.shown.lucidity === lucidity) return;
    this.inventory = inventory;
    this.lucidity = lucidity;
    this.shown = { inventory, lucidity };
    const opened = this.card.itemId;
    const refocus = this.card.root.contains(document.activeElement);
    const items = new Map<string, HTMLButtonElement>();

    this.purseAmount.textContent = t('%@c', String(inventory.coins));
    for (const slot of EQUIP_SLOTS) {
      const item = inventory.equipped[slot];
      const place = this.places[slot];
      if (item === undefined) place.replaceChildren(element('span', { className: 'hud-place__name', text: placeName(slot) }));
      else place.replaceChildren(this.itemButton(item, { slot }, items));
      place.classList.toggle('hud-place--empty', item === undefined);
    }
    this.cells.forEach((cell, place) => {
      const item = itemAtPlace(inventory, place);
      cell.replaceChildren(...(item === undefined ? [] : [this.itemButton(item, { place }, items)]));
    });
    this.statsStale = true;
    if (this.tab === 'stats') this.showStats();
    if (this.carry?.lifted === true) this.markCarry(this.carry);

    // An item whose card was open keeps it open where it now stands, and one that has gone takes it with it.
    if (opened === undefined) return;
    const reopen = items.get(opened);
    if (reopen === undefined) this.card.close();
    else this.openCard(reopen, refocus);
  }

  /** How far the body is turned from its usual view, in radians: by a drag, and by a slow sway while no drag has turned it for a while. */
  bodyTurn(nowMs: number): number {
    if (this.reducedMotion || this.turning !== undefined || nowMs < this.turn.pausedUntilMs) return this.turn.radians;
    return this.turn.radians + SWAY.radians * Math.sin(((nowMs - this.turn.swayFromMs) / SWAY.periodMs) * 2 * Math.PI);
  }

  /**
   * Leaves the window's plate open over the body's rect, so the body the scene draws on the canvas
   * under it shows. `body` is the body's rect on the page, empty while it is not shown.
   */
  openBodyHole(body: DOMRect): void {
    const frame = this.root.getBoundingClientRect();
    const hole = body.width > 0 && body.height > 0 ? [body.left - frame.left, body.top - frame.top, body.width, body.height].map(Math.round) : undefined;
    const shown = JSON.stringify(hole ?? null);
    if (shown === this.hole) return;
    this.hole = shown;
    const names = ['--hud-hole-left', '--hud-hole-top', '--hud-hole-width', '--hud-hole-height'];
    names.forEach((name, index) => {
      if (hole === undefined) this.root.style.removeProperty(name);
      else this.root.style.setProperty(name, `${hole[index]}px`);
    });
  }

  /** Lets go of an item carried, back where it lay. Reports whether one was. */
  cancelCarry(): boolean {
    const carry = this.carry;
    if (carry === undefined) return false;
    this.endCarry(carry);
    return carry.lifted;
  }

  /** As the window closes: its card, a carried item, and a refusal's line go with it. */
  closed(): void {
    this.card.close();
    this.cancelCarry();
    this.clearRefusal();
  }

  private selectTab(id: CharacterTab): void {
    this.tab = id;
    for (const [tabId, tab] of this.tabs) {
      tab.setAttribute('aria-selected', String(tabId === id));
      setHidden(this.pages.get(tabId)!, tabId !== id);
    }
    if (id === 'stats') this.showStats();
  }

  /** Shows the totals, marking each that changed since they were last shown. */
  private showStats(): void {
    if (!this.statsStale) return;
    this.statsStale = false;
    const before = this.shownStats;
    const now = new Map<string, string>();
    this.stats.replaceChildren(
      ...statGroups(this.inventory, this.lucidity).map((group) =>
        element('section', {
          className: 'hud-stats__group',
          children: [
            element('h3', { className: 'hud-stats__title', text: group.title }),
            ...group.rows.map(({ key, label, value, note }) => {
              now.set(key, value);
              const changed = before !== undefined && before.has(key) && before.get(key) !== value;
              return element('div', {
                className: changed ? 'hud-stat hud-stat--changed' : 'hud-stat',
                attributes: { 'data-stat': key },
                children: [
                  element('span', { className: 'hud-stat__label', text: label }),
                  element('strong', { className: 'hud-stat__value', text: value }),
                  ...(note === undefined ? [] : [element('span', { className: 'hud-stat__note', text: note })]),
                ],
              });
            }),
          ],
        }),
      ),
    );
    this.shownStats = now;
  }

  /** An item's part of the window: its icon, edged in its rarity's colour, its tip, and its name for assistive tech. */
  private itemButton(item: ItemInstance, source: ItemSource, items: Map<string, HTMLButtonElement>): HTMLButtonElement {
    const name = itemName(item.baseId, t);
    const node = element('button', {
      className: `hud-item hud-rarity--${item.rarity}`,
      attributes: {
        type: 'button',
        'data-item': item.id,
        'data-source': sourceKey(source),
        'aria-label': 'slot' in source ? t('%1$@: %2$@', slotName(source.slot), name) : name,
        'aria-haspopup': 'dialog',
        'aria-expanded': 'false',
      },
      children: [itemIcon(item.baseId)],
    });
    const worn = 'slot' in source;
    const warning = worn && !bagHasRoom(this.inventory) ? { warning: t('Your bag is full.') } : {};
    const hint = this.coarse ? [] : [worn ? t('Right-click or double-click to unequip.') : t('Right-click or double-click to equip.')];
    setTip(node, () => itemTip(item, { lines: hint, ...warning }));
    items.set(item.id, node);
    return node;
  }

  private itemAt(source: ItemSource): ItemInstance | undefined {
    return 'slot' in source ? this.inventory.equipped[source.slot] : itemAtPlace(this.inventory, source.place);
  }

  private sourceOf(node: Element): ItemSource | undefined {
    const [kind, value] = node.getAttribute('data-source')?.split(':') ?? [];
    if (kind === 'place') return { place: Number(value) };
    const slot = EQUIP_SLOTS.find((known) => known === value);
    return kind === 'slot' && slot !== undefined ? { slot } : undefined;
  }

  private itemNodeOf(target: EventTarget | null): { node: HTMLButtonElement; source: ItemSource; item: ItemInstance } | undefined {
    const node = target instanceof Element ? target.closest<HTMLButtonElement>('button[data-item]') : null;
    const source = node === null ? undefined : this.sourceOf(node);
    const item = source === undefined ? undefined : this.itemAt(source);
    return node === null || source === undefined || item === undefined ? undefined : { node, source, item };
  }

  /** What the item's card offers: Equip, plus Drop for a droppable item, on an item in the bag, or Unequip on a worn one, which a full bag refuses. */
  private actionFor(item: ItemInstance, source: ItemSource): ItemAction {
    if ('slot' in source) {
      return bagHasRoom(this.inventory)
        ? { label: t('Unequip'), run: () => this.callbacks.onUnequip(source.slot) }
        : { label: t('Unequip'), run: undefined, warning: t('Your bag is full.') };
    }
    const drop = droppableItem(this.inventory, item.id) === undefined ? {} : { drop: () => this.callbacks.onDropItem(item.id) };
    return { label: t('Equip'), run: () => this.callbacks.onEquip(item.id), ...drop };
  }

  private openCard(node: HTMLButtonElement, focus: boolean): void {
    const source = this.sourceOf(node);
    const item = source === undefined ? undefined : this.itemAt(source);
    if (source === undefined || item === undefined) return;
    this.card.open(node, item, this.actionFor(item, source), focus);
  }

  /** A finger's tap, or Enter, opens an item's card, and a second closes it. A mouse's single click does nothing. */
  private click(event: MouseEvent): void {
    const pressed = this.itemNodeOf(event.target);
    if (pressed === undefined) return;
    if (this.swallowClick) {
      this.swallowClick = false;
      return;
    }
    const keyboard = event.detail === 0;
    if (!keyboard && this.lastPointerType === 'mouse') return;
    if (this.card.itemId === pressed.item.id) this.card.close();
    else this.openCard(pressed.node, keyboard);
  }

  /** A mouse's double click or right click wears an item from the bag, a ring in a free ring slot, else the first, or puts a worn one away. */
  private act(event: MouseEvent): void {
    if (this.lastPointerType !== 'mouse') return;
    const pressed = this.itemNodeOf(event.target);
    if (pressed === undefined) return;
    this.card.close();
    const { item, source, node } = pressed;
    if (!('slot' in source)) this.callbacks.onEquip(item.id);
    else if (bagHasRoom(this.inventory)) this.callbacks.onUnequip(source.slot);
    else this.refuse(node.parentElement ?? node, t('Your bag is full.'));
  }

  private press(event: PointerEvent): void {
    this.lastPointerType = event.pointerType;
    this.swallowClick = false;
    const pressed = event.button === 0 && this.carry === undefined ? this.itemNodeOf(event.target) : undefined;
    if (pressed === undefined) return;
    const rect = pressed.node.getBoundingClientRect();
    this.carry = {
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      item: pressed.item,
      source: pressed.source,
      startX: event.clientX,
      startY: event.clientY,
      grabX: event.clientX - rect.left,
      grabY: event.clientY - rect.top,
      lifted: false,
      over: undefined,
      tab: undefined,
    };
  }

  private move(event: PointerEvent): void {
    if (this.turning?.pointerId === event.pointerId) {
      this.turn.radians = this.turning.radians + (event.clientX - this.turning.x) * TURN_PER_PX;
      return;
    }
    const carry = this.carry;
    if (carry?.pointerId !== event.pointerId) return;
    if (!carry.lifted) {
      const slop = carry.pointerType === 'mouse' ? LIFT_SLOP_PX.mouse : LIFT_SLOP_PX.other;
      if (Math.hypot(event.clientX - carry.startX, event.clientY - carry.startY) <= slop) return;
      this.lift(carry);
    }
    this.ghost.style.transform = `translate3d(${event.clientX - carry.grabX}px, ${event.clientY - carry.grabY}px, 0)`;
    this.hover(carry, this.targetAt(event.clientX, event.clientY));
  }

  private release(event: PointerEvent, cancelled: boolean): void {
    if (this.turning?.pointerId === event.pointerId) {
      this.turning = undefined;
      this.turn.pausedUntilMs = this.now() + SWAY.pauseMs;
      this.turn.swayFromMs = this.turn.pausedUntilMs;
      return;
    }
    const carry = this.carry;
    if (carry?.pointerId !== event.pointerId) return;
    this.endCarry(carry);
    if (!carry.lifted) return;
    this.swallowClick = true;
    if (!cancelled) this.drop(carry, this.targetAt(event.clientX, event.clientY));
  }

  /** The item leaves its place for the ghost; it dims there, and every slot its base fits shows it would take it. */
  private lift(carry: Carry): void {
    carry.lifted = true;
    this.card.close();
    this.clearRefusal();
    this.onLift();
    const from = this.root.querySelector(`[data-source="${sourceKey(carry.source)}"]`)?.getBoundingClientRect();
    this.ghost.className = `hud-ghost hud-rarity--${carry.item.rarity}`;
    this.ghost.style.width = `${from?.width ?? 0}px`;
    this.ghost.style.height = `${from?.height ?? 0}px`;
    this.ghost.replaceChildren(
      itemIcon(carry.item.baseId),
      element('span', { className: 'hud-ghost__caption hud-ghost__caption--drop', text: t('Drop') }),
      this.ghostRefusal,
    );
    this.markCarry(carry);
  }

  private markCarry(carry: Carry): void {
    this.root.querySelector(`[data-source="${sourceKey(carry.source)}"]`)?.classList.add('hud-item--lifted');
    for (const slot of slotsFor(carry.item.baseId)) this.places[slot].classList.add('hud-place--fits');
  }

  private endCarry(carry: Carry): void {
    this.carry = undefined;
    if (carry.tab !== undefined) clearTimeout(carry.tab.timer);
    if (!carry.lifted) return;
    setHidden(this.ghost, true);
    for (const node of this.root.querySelectorAll('.hud-item--lifted, .hud-place--fits, .hud-place--over, .hud-place--refuse')) {
      node.classList.remove('hud-item--lifted', 'hud-place--fits', 'hud-place--over', 'hud-place--refuse');
    }
  }

  private targetAt(x: number, y: number): DropTarget {
    const under = document.elementFromPoint(x, y);
    if (under === null) return { kind: 'none' };
    const within = this.root.contains(under);
    const slotPlace = within ? under.closest<HTMLElement>('[data-slot]') : null;
    const slot = EQUIP_SLOTS.find((known) => known === slotPlace?.dataset.slot);
    if (slotPlace !== null && slot !== undefined) return { kind: 'slot', node: slotPlace, slot };
    const cell = within ? under.closest<HTMLElement>('[data-place]') : null;
    if (cell !== null) return { kind: 'place', node: cell, place: Number(cell.dataset.place) };
    const tab = within ? CHARACTER_TABS.find((id) => id === under.closest<HTMLElement>('[data-tab]')?.dataset.tab) : undefined;
    if (tab !== undefined) return { kind: 'tab', id: tab };
    // The play field is the world's canvas, and nothing else on the page is a canvas the pointer meets.
    return under instanceof HTMLCanvasElement ? { kind: 'world', clientX: x, clientY: y } : { kind: 'none' };
  }

  /** Marks where the carried item would go, says on the ghost where it would not, and opens a tab it is held over. */
  private hover(carry: Carry, target: DropTarget): void {
    const node = target.kind === 'slot' || target.kind === 'place' ? target.node : undefined;
    const refusal = this.refusalAt(carry, target);
    const fits = refusal === undefined;
    if (refusal !== undefined && this.ghostRefusal.textContent !== refusal.caption) this.ghostRefusal.textContent = refusal.caption;
    if (node !== carry.over) {
      carry.over?.classList.remove('hud-place--over', 'hud-place--refuse');
      node?.classList.add(fits ? 'hud-place--over' : 'hud-place--refuse');
      carry.over = node;
    }
    this.ghost.classList.toggle('hud-ghost--world', target.kind === 'world' && fits);
    this.ghost.classList.toggle('hud-ghost--refuse', !fits);
    const tab = target.kind === 'tab' && target.id !== this.tab ? target.id : undefined;
    if (tab === carry.tab?.id) return;
    if (carry.tab !== undefined) clearTimeout(carry.tab.timer);
    carry.tab = tab === undefined ? undefined : { id: tab, timer: setTimeout(() => this.selectTab(tab), TAB_SPRING_MS) };
  }

  /**
   * Why the carried item cannot go where it is held, which both the ghost and the letting go read: a
   * slot its base does not fit, a bag place a worn item cannot be put away at with the bag full and
   * the item there not fitting its slot, or the world for an item that stays.
   */
  private refusalAt({ item, source }: Carry, target: DropTarget): Refusal | undefined {
    switch (target.kind) {
      case 'slot': {
        if (slotsFor(item.baseId).includes(target.slot)) return undefined;
        const fits = slotName(baseItem(item.baseId).slot);
        return { caption: t('%@ only', fits), notice: t('Fits only the %@ slot.', fits) };
      }
      case 'place':
        if (!('slot' in source) || unequipItem(this.inventory, source.slot, target.place) !== undefined) return undefined;
        return { caption: t('Bag full'), notice: t('Your bag is full.') };
      case 'world':
        if (droppableItem(this.inventory, item.id) !== undefined) return undefined;
        return { caption: t('Stays with you'), notice: t('This stays with you.') };
      case 'tab':
      case 'none':
        return undefined;
    }
  }

  private drop(carry: Carry, target: DropTarget): void {
    const { item, source } = carry;
    const refusal = this.refusalAt(carry, target);
    if (refusal !== undefined) {
      const from = (): HTMLElement => this.root.querySelector<HTMLElement>(`[data-source="${sourceKey(source)}"]`)?.parentElement ?? this.root;
      this.refuse(target.kind === 'slot' || target.kind === 'place' ? target.node : from(), refusal.notice);
      return;
    }
    switch (target.kind) {
      case 'slot':
        if (!('slot' in source) || source.slot !== target.slot) this.callbacks.onEquip(item.id, target.slot);
        return;
      case 'place':
        if (!('place' in source) || source.place !== target.place) this.callbacks.onMoveItem(item.id, target.place);
        return;
      case 'world':
        this.callbacks.onDropItem(item.id, { clientX: target.clientX, clientY: target.clientY });
        return;
      case 'tab':
      case 'none':
        return;
    }
  }

  /** Says why the item did not go there, beside the place, which shakes. */
  private refuse(anchor: HTMLElement, text: string): void {
    this.clearRefusal();
    this.notice.replaceChildren(element('p', { className: 'hud-tip__warning', text }));
    setHidden(this.notice, false);
    placeBeside(this.notice, anchor, this.notice.parentElement ?? this.root);
    anchor.classList.add('hud-place--shake');
    this.refusal = { anchor, timer: setTimeout(() => this.clearRefusal(), REFUSAL_MS) };
  }

  private clearRefusal(): void {
    if (this.refusal === undefined) return;
    clearTimeout(this.refusal.timer);
    this.refusal.anchor.classList.remove('hud-place--shake');
    this.refusal = undefined;
    setHidden(this.notice, true);
  }

  private startTurn(event: PointerEvent): void {
    if (event.button !== 0) return;
    const radians = this.bodyTurn(this.now());
    this.turn.radians = radians;
    this.turning = { pointerId: event.pointerId, x: event.clientX, radians };
    event.preventDefault();
  }
}
