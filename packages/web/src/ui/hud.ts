import { calendarFromWorldSeconds, hourOfDay, sunIsUp } from '@somnio/core';
import type { AbilityId, EngageAction, Inventory } from '@somnio/core';
import { RARITIES } from '@somnio/protocol';
import type { Energy, EquipSlot, LucidityMessage } from '@somnio/protocol';
import type { AbilitySlotState, ChatLine } from '@/client';
import { t } from '@/i18n';
import type { CatalogLocale, CatalogTables } from '@/i18n';
import { DREAM_COLOR, MOONLIGHT, RAISE_COLOR } from '@/scene/combatEffects';
import { RARITY_COLORS } from '@/scene/lootMarkers';
import { cssColor } from '@/scene/overlayArt';
import type { PortraitSlot } from '@/scene/portraits';
import { AbilitySlot, BalanceMeter, PoolGlobe, SlotOneButton, emptySlot, runButton, showStudyLine, studyLine } from './belt';
import { ChatPane } from './chatPane';
import { element, iconButton, isHidden, setHidden } from './dom';
import { HUD_ICONS, glyph } from './hudIcons';
import type { HUDGlyph } from './hudIcons';
import { HUDTooltip, setTip } from './hudTooltip';
import { CharacterWindow } from './characterWindow';
import { HUDWindow, PlayersList } from './hudWindows';
import type { PlayersSelection } from './hudWindows';
import { OwnFrame, TargetFrame } from './unitFrames';
import type { FramedEntity, OwnFrameState } from './unitFrames';

/**
 * The in-game HUD, DOM over the WebGL canvas so `agent-browser snapshot` and assistive technology
 * see it. On a mouse: the player's own frame top left and the target's top centre, the world clock
 * top right, the belt at the bottom centre (the Health and Spirit globes, the Balance arc, slot 1,
 * five slots for the abilities the player has learned, Run, and what the player studies), the menu beside the Spirit globe, and the
 * chat bottom left. On a finger: one strip of frames along the top with the clock and ≡, slot 1 and
 * the ability slots in an arc under the right thumb, Balance as a bar at the bottom centre, and the
 * chat behind an icon bottom left.
 *
 * The menu opens windows. A mouse may keep several open, the newest on top, and a finger one at a time.
 */

export interface HUDCallbacks {
  onSubmitChat: (text: string) => void;
  onChatFocusChange: (focused: boolean) => void;
  onTellPurse: () => void;
  onEquip: (itemId: string, slot?: EquipSlot) => void;
  onUnequip: (slot: EquipSlot) => void;
  onMoveItem: (itemId: string, place: number) => void;
  onDropItem: (itemId: string, at?: { clientX: number; clientY: number }) => void;
  onToggleRun: () => void;
  onToggleEngage: () => void;
  onUseAbility: (abilityId: AbilityId) => void;
  /** A press on a dreamer's name in the Players window. */
  onPressPlayer: (name: string) => void;
  /** A press on the player's own frame, or their own name in the Players window. */
  onPressOwnFrame: () => void;
  onClearTarget: () => void;
  /** The menu's Settings, which is the game menu. */
  onOpenSettings: () => void;
  /** Reports whether the pointer rests on the HUD, so a wheel there scrolls rather than zooms. */
  onHoverChange: (hovering: boolean) => void;
}

export interface HUDOptions {
  tables: CatalogTables;
  locale: CatalogLocale;
  /** A finger's layout rather than a mouse's. */
  coarse: boolean;
  /** The clock the chat's fading, the cooldowns, and the effects' seconds are timed on. */
  now?: () => number;
}

export type HUDWindowId = 'players' | 'character';

/** The keys that open and close each window, the first named in its menu button's tip: the Character window on Diablo's C and I, the Players window on O. */
export const WINDOW_KEYS: Readonly<Record<HUDWindowId, readonly [string, ...string[]]>> = { players: ['o'], character: ['c', 'i'] };

/** Where the world clock stands and where the player stands in it, for the plate at the top right. */
export interface HUDClock {
  worldSeconds: number | undefined;
  place: string | undefined;
}

/** The thumb's corner box, in px, and where a finger's slots lie in it: slot 1, then 2 to 6 on an arc round it, and Run at the arc's end. */
const THUMB = { width: 300, height: 230, act: { x: 262, y: 192 }, run: { x: 58, y: 204 }, radius: 145, firstDegrees: 92, stepDegrees: 22.5 } as const;

/** The keys of the slots for abilities, after slot 1's. */
const ABILITY_KEYS = [2, 3, 4, 5, 6] as const;

/**
 * What a mouse's HUD needs of the window, in px, mirroring `hud.css`. Across: the edge and an 8 px
 * gap on each side, unscaled, plus the scaled widths of two own frames round a target frame squeezed
 * to its portrait and a short name, since the target frame centres between them. The 638 px belt fits
 * whenever that does. Down: the top edge, the 10 px under the windows, and a 120 px window,
 * unscaled, plus the scaled band above the windows (92 px) and the belt with the menu above it
 * (170 px).
 */
const FIT = { across: { fixed: 2 * (12 + 8), scaled: 2 * 250 + 150 }, down: { fixed: 12 + 10 + 120, scaled: 92 + 170 } } as const;

/** How much a mouse's HUD shrinks to fit a window of this size: 1 where it fits whole, to a thousandth, rounded down. */
function hudScale(width: number, height: number): number {
  const fits = Math.min(1, (width - FIT.across.fixed) / FIT.across.scaled, (height - FIT.down.fixed) / FIT.down.scaled);
  return Math.floor(fits * 1000) / 1000;
}

function placeOnThumb(node: HTMLElement, at: { x: number; y: number }): HTMLElement {
  node.style.left = `${at.x}px`;
  node.style.top = `${at.y}px`;
  return node;
}

/** Puts a finger's slot for an ability at its place on the arc round slot 1, from the first place at 0. */
function placeOnArc(node: HTMLElement, index: number): HTMLElement {
  const radians = ((THUMB.firstDegrees + index * THUMB.stepDegrees) * Math.PI) / 180;
  return placeOnThumb(node, { x: THUMB.act.x + THUMB.radius * Math.cos(radians), y: THUMB.act.y - THUMB.radius * Math.sin(radians) });
}

function twoDigits(value: number): string {
  return String(value).padStart(2, '0');
}

/** Gives the node the colours the world draws its effects in, as `--hud-*` properties, so a bar or a marker in one never drifts from the scene's. */
export function paintEffectColors(node: HTMLElement): void {
  node.style.setProperty('--hud-moonlight', cssColor(MOONLIGHT));
  node.style.setProperty('--hud-raise', cssColor(RAISE_COLOR));
  node.style.setProperty('--hud-dream', cssColor(DREAM_COLOR));
}

/** Gives the node each rarity's colour as `--hud-rarity-*`, the colour a drop of it is drawn in on the ground. */
export function paintRarityColors(node: HTMLElement): void {
  for (const rarity of RARITIES) node.style.setProperty(`--hud-rarity-${rarity}`, cssColor(RARITY_COLORS[rarity]));
}

export class GameHUD {
  readonly root: HTMLElement;
  readonly chatInput: HTMLTextAreaElement;
  /** The place each portrait is drawn in, on the canvas under it: each frame's circle, and the Character window's body. */
  readonly portraits: Record<PortraitSlot, HTMLElement>;

  private readonly coarse: boolean;
  private readonly callbacks: HUDCallbacks;
  private readonly ownFrame: OwnFrame;
  private readonly targetFrame: TargetFrame;
  private readonly clockTime: HTMLElement;
  private readonly clockGlyph: HTMLElement;
  private readonly clockPlace: HTMLElement;
  private readonly clock: HTMLElement;
  private readonly globes: { health: PoolGlobe; spirit: PoolGlobe } | undefined;
  private readonly balance: BalanceMeter;
  private readonly slotOne: SlotOneButton;
  /** What stands in each slot for abilities: the slot of the ability learned for it, or else an empty one. */
  private readonly abilityPlaces: HTMLElement[];
  private readonly emptySlots: HTMLElement[];
  private readonly abilitySlots: (AbilitySlot | undefined)[] = ABILITY_KEYS.map(() => undefined);
  private readonly run: HTMLButtonElement;
  private readonly study: HTMLElement;
  private readonly chat: ChatPane;
  private readonly windows: Record<HUDWindowId, HUDWindow>;
  private readonly players: PlayersList;
  private readonly character: CharacterWindow;
  /** The menu's buttons that open each window, lit while it is open. */
  private readonly windowToggles = new Map<HUDWindowId, HTMLButtonElement>();
  /** The open windows, the newest last. */
  private readonly openWindows: HUDWindowId[] = [];
  private readonly sheet: HTMLElement | undefined;
  private readonly sheetToggle: HTMLButtonElement | undefined;
  /** What covers the play field whatever is open, beside the windows, the sheet, and the chat. */
  private readonly fixedOccluders: HTMLElement[];
  private readonly hovered = new Set<HTMLElement>();
  private readonly tooltip: HUDTooltip;
  private readonly now: () => number;
  private shownStudy: string | undefined;
  private shownClock: string | undefined;

  constructor(callbacks: HUDCallbacks, options: HUDOptions) {
    this.callbacks = callbacks;
    this.coarse = options.coarse;
    const now = options.now ?? (() => performance.now());
    this.now = now;

    this.ownFrame = new OwnFrame(() => callbacks.onPressOwnFrame(), this.coarse);
    this.targetFrame = new TargetFrame(() => callbacks.onClearTarget());
    this.character = new CharacterWindow(
      callbacks,
      this.coarse,
      () => this.closeWindow('character'),
      () => this.forgetHover(this.character.card.root),
      () => this.tooltip.hide(),
      now,
    );
    this.portraits = { own: this.ownFrame.portrait, target: this.targetFrame.portrait, body: this.character.body };
    this.clockGlyph = element('span', { className: 'hud-clock__glyph', attributes: { 'aria-hidden': 'true' } });
    this.clockTime = element('span', { className: 'hud-clock__digits' });
    this.clockPlace = element('span', { className: 'hud-clock__place' });
    this.clock = element('div', {
      className: this.coarse ? 'hud-clock' : 'fantasy-panel hud-clock',
      children: [element('span', { className: 'hud-clock__time', children: [this.clockGlyph, this.clockTime] }), this.clockPlace],
    });
    this.balance = new BalanceMeter(this.coarse ? 'bar' : 'arc');
    this.slotOne = new SlotOneButton(() => callbacks.onToggleEngage(), this.coarse);
    this.emptySlots = ABILITY_KEYS.map((key) => emptySlot(key, this.coarse));
    this.abilityPlaces = [...this.emptySlots];
    this.run = runButton(() => callbacks.onToggleRun(), this.coarse);
    this.study = element('p', { className: 'hud-study' });

    this.chat = new ChatPane(
      { onSubmit: (text) => callbacks.onSubmitChat(text), onFocusChange: (focused) => callbacks.onChatFocusChange(focused) },
      options.tables,
      options.locale,
      this.coarse,
      now,
    );
    this.chatInput = this.chat.input;

    this.players = new PlayersList(
      (name) => callbacks.onPressPlayer(name),
      () => callbacks.onPressOwnFrame(),
    );
    this.windows = {
      players: new HUDWindow(t('Players'), () => this.closeWindow('players'), this.players.nodes),
      character: this.character.window,
    };
    this.windows.players.root.classList.add('hud-window--players');

    let layout: HTMLElement[];
    if (this.coarse) {
      this.globes = undefined;
      const sheetButton = (label: string, art: HUDGlyph, onPress: () => void): HTMLButtonElement => {
        const node = element('button', {
          className: 'fantasy-button hud-sheet__item',
          attributes: { type: 'button' },
          children: [glyph(art), element('span', { text: label })],
        });
        node.addEventListener('click', onPress);
        return node;
      };
      const sheet = element('nav', {
        className: 'fantasy-panel fantasy-panel--opaque hud-sheet hidden',
        attributes: { 'aria-label': t('Menu') },
        children: [
          sheetButton(t('Players'), HUD_ICONS.players, () => this.openWindow('players')),
          sheetButton(t('Character'), HUD_ICONS.character, () => this.openWindow('character')),
          sheetButton(t('Settings'), HUD_ICONS.settings, () => this.openSettings()),
          this.study,
        ],
      });
      this.sheet = sheet;
      this.sheetToggle = setTip(
        iconButton(t('Menu'), glyph(HUD_ICONS.menu), () => this.setSheetOpen(isHidden(sheet)), {
          className: 'fantasy-button fantasy-button--compact hud-sheet-toggle',
        }),
      );
      this.sheetToggle.setAttribute('aria-expanded', 'false');
      const strip = element('div', {
        className: 'hud-strip',
        children: [this.ownFrame.root, this.targetFrame.root, element('span', { className: 'hud-strip__spacer' }), this.clock, this.sheetToggle],
      });
      const thumb = element('div', {
        className: 'hud-thumb',
        children: [
          placeOnThumb(this.slotOne.root, THUMB.act),
          ...this.emptySlots.map((slot, index) => placeOnArc(slot, index)),
          placeOnThumb(this.run, THUMB.run),
        ],
      });
      layout = [strip, this.sheet, this.balance.root, thumb, this.chat.root];
      this.fixedOccluders = [
        this.ownFrame.root,
        this.ownFrame.timed.root,
        this.targetFrame.root,
        this.targetFrame.timed.root,
        this.clock,
        this.sheetToggle,
        this.balance.root,
        this.slotOne.root,
        this.run,
      ];
      this.trackHover(strip, thumb, this.sheet, this.balance.root);
    } else {
      this.sheet = undefined;
      this.sheetToggle = undefined;
      this.globes = { health: new PoolGlobe('health', t('Health')), spirit: new PoolGlobe('spirit', t('Spirit')) };
      const slots = element('div', {
        className: 'hud-slots',
        children: [this.slotOne.root, ...this.emptySlots, this.run],
      });
      const panel = element('div', { className: 'fantasy-panel hud-belt__panel', children: [this.balance.root, slots, this.study] });
      const menuButton = (id: HUDWindowId, label: string, art: HUDGlyph): HTMLButtonElement => {
        const key = WINDOW_KEYS[id][0].toUpperCase();
        const node = setTip(
          iconButton(label, glyph(art), () => this.toggleWindow(id), { className: 'fantasy-button fantasy-button--compact hud-menu__item' }),
          () => ({ title: label, aside: key }),
        );
        node.setAttribute('aria-pressed', 'false');
        this.windowToggles.set(id, node);
        return node;
      };
      const menu = element('nav', {
        className: 'hud-menu',
        attributes: { 'aria-label': t('Menu') },
        children: [
          menuButton('players', t('Players'), HUD_ICONS.players),
          menuButton('character', t('Character'), HUD_ICONS.character),
          setTip(
            iconButton(t('Settings'), glyph(HUD_ICONS.settings), () => this.openSettings(), {
              className: 'fantasy-button fantasy-button--compact hud-menu__item',
            }),
          ),
        ],
      });
      const belt = element('div', { className: 'hud-belt', children: [this.globes.health.root, panel, this.globes.spirit.root, menu] });
      layout = [this.ownFrame.root, this.targetFrame.root, this.clock, belt, this.chat.root];
      this.fixedOccluders = [
        this.ownFrame.root,
        this.ownFrame.timed.root,
        this.targetFrame.root,
        this.targetFrame.timed.root,
        this.clock,
        this.globes.health.root,
        panel,
        this.globes.spirit.root,
        menu,
      ];
      this.trackHover(this.ownFrame.root, this.targetFrame.root, this.clock, belt, this.chat.root);
    }
    this.trackHover(this.windows.players.root, this.windows.character.root, this.character.card.root, ...(this.coarse ? [this.chat.root] : []));

    this.root = element('div', {
      className: `hud ${this.coarse ? 'hud--coarse' : 'hud--fine'}`,
      children: [...layout, this.windows.players.root, this.windows.character.root, this.character.card.root, this.character.notice, this.character.ghost],
    });
    this.tooltip = new HUDTooltip(this.root, now);
    this.root.append(this.tooltip.root);
    this.root.style.setProperty('--hud-thumb-width', `${THUMB.width}px`);
    this.root.style.setProperty('--hud-thumb-height', `${THUMB.height}px`);
    paintEffectColors(this.root);
    paintRarityColors(this.root);
    // A control pressed with the pointer hands the keyboard straight back to the world, so Enter
    // opens the chat and Shift runs rather than pressing the control again. A keyboard press keeps it.
    this.root.addEventListener(
      'click',
      (event) => {
        const pressed = event.target instanceof Element ? event.target.closest('button') : null;
        if (event.detail > 0 && pressed !== null) pressed.blur();
      },
      true,
    );
  }

  /** What covers the play field now: the frames, the belt or the thumb's slots, and whatever window, item card, sheet, or chat is open. */
  get occluders(): HTMLElement[] {
    return [
      ...this.fixedOccluders,
      // A mouse's ability slots lie within the belt's panel.
      ...(this.coarse ? this.abilityPlaces : []),
      ...this.chat.occluders,
      this.windows.players.root,
      this.windows.character.root,
      this.character.card.root,
      ...(this.sheet === undefined ? [] : [this.sheet]),
    ];
  }

  get chatOpen(): boolean {
    return this.chat.isOpen;
  }

  /** A mouse's HUD shrinks evenly to fit a window too small for it. A finger's layout keeps its size. */
  setViewport(width: number, height: number): void {
    if (this.coarse) return;
    this.root.style.setProperty('--hud-scale', String(hudScale(width, height)));
  }

  /** Before the player stands in the world nothing of the HUD shows, and whatever was open closes. */
  setShown(shown: boolean): void {
    if (shown === !isHidden(this.root)) return;
    setHidden(this.root, !shown);
    if (!shown) {
      this.tooltip.hide();
      for (const id of [...this.openWindows]) this.closeWindow(id);
      this.setSheetOpen(false);
    }
    this.chat.setShown(shown);
  }

  /** The player's own pools: the globes on a mouse, the bars on a finger's own frame, and Balance on both. */
  renderPools(energy: Energy, winded: boolean): void {
    this.balance.render(energy.balanceCurrent, energy.balanceMax, winded);
    this.ownFrame.renderPools(energy);
    this.globes?.health.render(energy.healthCurrent, energy.healthMax);
    this.globes?.spirit.render(energy.spiritCurrent, energy.spiritMax);
  }

  /** Run lit while it is on, and held off while an effect keeps the player from running. */
  renderRun(running: boolean, heldOff: boolean): void {
    this.run.setAttribute('aria-pressed', String(running));
    this.run.classList.toggle('hud-run--held', heldOff);
    if (heldOff) this.run.setAttribute('aria-description', t('held off'));
    else this.run.removeAttribute('aria-description');
  }

  renderSlotOne(engaged: boolean, action: EngageAction | undefined, targetFallen: boolean): void {
    this.slotOne.render(engaged, action, targetFallen);
  }

  /**
   * The abilities the player has learned, in the slots after slot 1 in the belt's order, and empty
   * slots after them. Each ability keeps its slot while it stays in the same place.
   */
  renderAbilities(slots: readonly AbilitySlotState[]): void {
    const nowMs = this.now();
    ABILITY_KEYS.forEach((key, index) => {
      const state = slots[index];
      let node = this.emptySlots[index]!;
      if (state !== undefined) {
        const { abilityId } = state;
        let slot = this.abilitySlots[index];
        if (slot?.abilityId !== abilityId) {
          slot = new AbilitySlot(abilityId, key, () => this.callbacks.onUseAbility(abilityId), this.coarse);
          this.abilitySlots[index] = slot;
        }
        slot.render(state, nowMs);
        node = slot.root;
      }
      if (node === this.abilityPlaces[index]) return;
      if (this.coarse) placeOnArc(node, index);
      this.abilityPlaces[index]!.replaceWith(node);
      this.abilityPlaces[index] = node;
    });
  }

  renderLucidity(lucidity: LucidityMessage): void {
    const line = studyLine(lucidity);
    const shown = JSON.stringify(line ?? null);
    if (shown === this.shownStudy) return;
    this.shownStudy = shown;
    showStudyLine(this.study, line);
  }

  renderSelf(state: OwnFrameState): void {
    this.ownFrame.render(state, this.now());
  }

  renderTarget(target: FramedEntity | undefined, gazeLocked: boolean): void {
    this.targetFrame.render(target, gazeLocked, this.now());
  }

  renderChat(lines: readonly ChatLine[]): void {
    this.chat.renderLines(lines);
  }

  renderPlayers(players: readonly string[], selection: PlayersSelection): void {
    this.players.render(players, selection);
  }

  renderCharacter(inventory: Inventory, lucidity: LucidityMessage): void {
    this.character.render(inventory, lucidity);
  }

  /** How far the Character window's body is turned from its usual view, in radians. */
  bodyTurn(nowMs: number): number {
    return this.character.bodyTurn(nowMs);
  }

  /** Leaves the Character window's plate open over the body's rect on the page, read with the other rects of the frame. */
  openBodyHole(body: DOMRect): void {
    this.character.openBodyHole(body);
  }

  /**
   * The clock's minute, the chat's fading, and the seconds left on cooldowns and effects, which move
   * with time rather than with a frame from the server, and the tip shown, which follows its part.
   */
  tick(nowMs: number, clock: HUDClock): void {
    this.chat.tick(nowMs);
    for (const slot of this.abilitySlots) slot?.tick(nowMs);
    this.ownFrame.effects.tick(nowMs);
    this.targetFrame.effects.tick(nowMs);
    this.tooltip.refresh(nowMs);
    const shown = JSON.stringify([clock.worldSeconds === undefined ? null : Math.floor(clock.worldSeconds / 60), clock.place ?? null]);
    if (shown === this.shownClock) return;
    this.shownClock = shown;
    if (clock.worldSeconds === undefined) {
      this.clockGlyph.textContent = '';
      this.clockTime.textContent = '';
    } else {
      const { hour, minute } = calendarFromWorldSeconds(clock.worldSeconds);
      const day = sunIsUp(hourOfDay(clock.worldSeconds));
      this.clockGlyph.textContent = day ? '☀' : '☾';
      this.clockGlyph.classList.toggle('hud-clock__glyph--day', day);
      this.clockTime.textContent = `${twoDigits(hour)}:${twoDigits(minute)}`;
    }
    this.clockPlace.textContent = clock.place ?? '';
  }

  /** Brings the chat's faded lines back when the pointer comes to rest over where they lie. */
  revealChatAt(x: number, y: number): void {
    this.chat.revealAt(x, y);
  }

  /** Opens the chat and gives its field the keyboard, closing the menu sheet. */
  openChat(): void {
    this.setSheetOpen(false);
    this.chat.openChat();
  }

  closeChat(): void {
    this.chat.closeChat();
  }

  /**
   * Escape closes what the HUD has open, one thing at a time: the chat, the menu sheet, an item
   * carried, an item's card, then the newest window. Reports whether it closed anything.
   */
  escape(): boolean {
    if (this.chat.isOpen) {
      this.chat.closeChat();
      return true;
    }
    if (this.sheet !== undefined && !isHidden(this.sheet)) {
      this.setSheetOpen(false);
      return true;
    }
    if (this.character.cancelCarry()) return true;
    if (this.character.card.itemId !== undefined) {
      this.character.card.close();
      return true;
    }
    const newest = this.openWindows.at(-1);
    if (newest === undefined) return false;
    this.closeWindow(newest);
    return true;
  }

  /** Whether a window is open. */
  isWindowOpen(id: HUDWindowId): boolean {
    return this.openWindows.includes(id);
  }

  toggleWindow(id: HUDWindowId): void {
    if (this.openWindows.includes(id)) this.closeWindow(id);
    else this.openWindow(id);
  }

  /** Opens a window on top of the others. A finger's layout shows one at a time, in the sheet's place. */
  openWindow(id: HUDWindowId): void {
    if (this.coarse) for (const other of [...this.openWindows]) if (other !== id) this.closeWindow(other);
    this.setSheetOpen(false);
    const at = this.openWindows.indexOf(id);
    if (at >= 0) this.openWindows.splice(at, 1);
    this.openWindows.push(id);
    this.showWindows();
  }

  closeWindow(id: HUDWindowId): void {
    const at = this.openWindows.indexOf(id);
    if (at < 0) return;
    this.openWindows.splice(at, 1);
    this.showWindows();
  }

  private showWindows(): void {
    for (const [id, window] of Object.entries(this.windows) as [HUDWindowId, HUDWindow][]) {
      const order = this.openWindows.indexOf(id);
      setHidden(window.root, order < 0);
      window.root.style.setProperty('--hud-window-order', String(order));
      this.windowToggles.get(id)?.setAttribute('aria-pressed', String(order >= 0));
      if (order < 0) this.forgetHover(window.root);
    }
    // On a mouse the Players window stands beside the Character window while both are open. Where the window is too narrow for both, they share a place and the newer covers the older.
    this.windows.players.root.classList.toggle('hud-window--beside', this.openWindows.includes('character'));
    // What the Character window has under way goes with it.
    if (!this.openWindows.includes('character')) this.character.closed();
    // Its plate is open over the body, so a part of the HUD under it would show through.
    this.root.classList.toggle('hud--character-open', this.openWindows.includes('character'));
  }

  private openSettings(): void {
    this.setSheetOpen(false);
    this.callbacks.onOpenSettings();
  }

  private setSheetOpen(open: boolean): void {
    if (this.sheet === undefined || this.sheetToggle === undefined) return;
    setHidden(this.sheet, !open);
    this.sheetToggle.setAttribute('aria-expanded', String(open));
    if (!open) this.forgetHover(this.sheet);
  }

  /**
   * A pointer sliding straight from one part to the next can report the enter before the exit, so
   * the hovered set rather than one flag keeps the aggregate steady through that reorder.
   */
  private trackHover(...nodes: HTMLElement[]): void {
    for (const node of nodes) {
      node.addEventListener('pointerenter', () => this.setHovered(node, true));
      node.addEventListener('pointerleave', () => this.setHovered(node, false));
    }
  }

  /** A part that hides under the pointer reports no leave. */
  private forgetHover(node: HTMLElement): void {
    this.setHovered(node, false);
  }

  private setHovered(node: HTMLElement, hovering: boolean): void {
    const was = this.hovered.size > 0;
    if (hovering) this.hovered.add(node);
    else this.hovered.delete(node);
    const is = this.hovered.size > 0;
    if (was !== is) this.callbacks.onHoverChange(is);
  }
}
