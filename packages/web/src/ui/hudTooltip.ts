import type { AbilityPool, BaseItemId } from '@somnio/core';
import type { Rarity } from '@somnio/protocol';
import { FINGER_HOLD_MS, TAP_SLOP_PX } from '@/client';
import { element, setHidden } from './dom';
import { itemIcon } from './itemIcons';

/**
 * The HUD's one tooltip, in place of the browser's slow `title`. A mouse or a pen resting on a part
 * shows it at once, and leaving the part, pressing, scrolling, or resizing hides it. A finger has
 * no hover, so a part held for `FINGER_HOLD_MS` shows it until the finger lifts, and that press then
 * presses nothing. A tap, or a hold that slides past `TAP_SLOP_PX` first, presses as usual.
 */

/** One fact in a row of them, in its pool's colour when it is a cost. */
interface TipFact {
  text: string;
  pool?: AbilityPool;
}

export interface Tip {
  title: string;
  /** An item's rarity, whose colour the title takes. */
  rarity?: Rarity;
  /** An item's base, whose icon leads the tip, edged in the rarity's colour. */
  icon?: BaseItemId;
  /** Beside the title: the key that works the part, or the seconds an effect has left. */
  aside?: string;
  facts?: readonly TipFact[];
  lines?: readonly string[];
  /** Why the part cannot act now. */
  warning?: string;
}

/** What a part's tip says at a moment on the HUD's clock, read when it shows and on every tick while it does. */
export type TipSource = (nowMs: number) => Tip;

const TIPS = new WeakMap<Element, TipSource>();

/**
 * Gives a part of the HUD a tip, by default its accessible name. A part with a tip carries no
 * `title`, whose browser tooltip would show beside it a moment later.
 */
export function setTip<T extends HTMLElement>(node: T, source: TipSource = () => ({ title: node.getAttribute('aria-label') ?? '' })): T {
  TIPS.set(node, source);
  node.removeAttribute('title');
  return node;
}

/** The room between the tip and its part, and between the tip and the window's edges. */
const TIP_GAP_PX = 8;

let tipSequence = 0;

export class HUDTooltip {
  readonly root: HTMLElement;
  private readonly container: HTMLElement;
  private anchor: HTMLElement | undefined;
  private shown: string | undefined;
  /** A finger's press on a part, before it has been held long enough to show the part's tip. */
  private hold: { pointerId: number; x: number; y: number; timer: ReturnType<typeof setTimeout> } | undefined;
  /** A finger whose hold showed a tip, whose press then presses nothing. */
  private heldPointer: number | undefined;
  private swallowClick = false;

  /** `container` is the HUD's root, which holds the tip and every part with one. */
  constructor(container: HTMLElement, now: () => number) {
    this.container = container;
    tipSequence += 1;
    this.root = element('div', {
      className: 'fantasy-panel fantasy-panel--opaque hud-tip hidden',
      attributes: { role: 'tooltip', id: `somnio-hud-tip-${tipSequence}` },
    });
    container.addEventListener('pointerover', (event) => {
      // A finger's tip waits for a hold, and a press held from the play field is a drag or a steer.
      if (event.pointerType === 'touch' || event.buttons !== 0) return;
      const anchor = this.anchorOf(event.target);
      if (anchor !== undefined && anchor !== this.anchor) this.show(anchor, now());
    });
    container.addEventListener('pointerout', (event) => {
      if (this.anchor === undefined || this.heldPointer !== undefined) return;
      const into = event.relatedTarget instanceof Node && this.anchor.contains(event.relatedTarget);
      if (!into && event.target instanceof Node && this.anchor.contains(event.target)) this.hide();
    });
    container.addEventListener('pointerdown', (event) => {
      this.hide();
      this.cancelHold();
      this.swallowClick = false;
      if (event.pointerType === 'mouse') return;
      const anchor = this.anchorOf(event.target);
      if (anchor === undefined) return;
      const timer = setTimeout(() => {
        this.hold = undefined;
        this.heldPointer = event.pointerId;
        this.show(anchor, now());
      }, FINGER_HOLD_MS);
      this.hold = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, timer };
    });
    container.addEventListener('pointermove', (event) => {
      if (this.hold?.pointerId === event.pointerId && Math.hypot(event.clientX - this.hold.x, event.clientY - this.hold.y) > TAP_SLOP_PX) this.cancelHold();
    });
    const release = (event: PointerEvent): void => {
      if (this.hold?.pointerId === event.pointerId) this.cancelHold();
      if (this.heldPointer !== event.pointerId) return;
      this.heldPointer = undefined;
      this.swallowClick = event.type === 'pointerup';
      this.hide();
    };
    container.addEventListener('pointerup', release);
    container.addEventListener('pointercancel', release);
    // Ahead of the pressed part's own listener. A keyboard's click, of no pointer, is never swallowed.
    container.addEventListener(
      'click',
      (event) => {
        if (!this.swallowClick || event.detail === 0) return;
        this.swallowClick = false;
        event.preventDefault();
        event.stopPropagation();
      },
      true,
    );
    // Only a scroll that moves the part: the chat scrolls to each new line under a tip on the belt.
    window.addEventListener(
      'scroll',
      (event) => {
        if (this.anchor !== undefined && event.target instanceof Node && event.target.contains(this.anchor)) this.hide();
      },
      true,
    );
    window.addEventListener('resize', () => this.hide());
  }

  /**
   * Follows what the shown tip's part says now, touching the tip only when that changed, and hides
   * it once the part is gone or hidden.
   */
  refresh(nowMs: number): void {
    const anchor = this.anchor;
    if (anchor === undefined) return;
    if (!anchor.isConnected || anchor.closest('.hidden') !== null) {
      this.hide();
      return;
    }
    const tip = TIPS.get(anchor)!(nowMs);
    const shown = JSON.stringify(tip);
    if (shown === this.shown) return;
    this.shown = shown;
    this.root.replaceChildren(...tipNodes(tip));
    setHidden(this.root, false);
    placeBeside(this.root, anchor, this.container);
  }

  hide(): void {
    this.anchor?.removeAttribute('aria-describedby');
    this.anchor = undefined;
    this.shown = undefined;
    setHidden(this.root, true);
  }

  private show(anchor: HTMLElement, nowMs: number): void {
    this.hide();
    this.anchor = anchor;
    anchor.setAttribute('aria-describedby', this.root.id);
    this.refresh(nowMs);
  }

  private cancelHold(): void {
    if (this.hold !== undefined) clearTimeout(this.hold.timer);
    this.hold = undefined;
  }

  /** The nearest part with a tip at or above `target`, within the HUD. */
  private anchorOf(target: EventTarget | null): HTMLElement | undefined {
    for (let node = target instanceof Element ? target : null; node !== null && node !== this.container; node = node.parentElement) {
      if (node instanceof HTMLElement && TIPS.has(node)) return node;
    }
    return undefined;
  }
}

/** Places `node`, shown in `container`, centred over `anchor`, or under it where there is no room above, and inside the container. */
export function placeBeside(node: HTMLElement, anchor: HTMLElement, container: HTMLElement): void {
  const bounds = container.getBoundingClientRect();
  const part = anchor.getBoundingClientRect();
  const width = node.offsetWidth;
  const height = node.offsetHeight;
  const centred = part.left + part.width / 2 - width / 2 - bounds.left;
  const left = Math.max(TIP_GAP_PX, Math.min(centred, bounds.width - width - TIP_GAP_PX));
  const above = part.top - bounds.top - TIP_GAP_PX - height;
  const top = above >= TIP_GAP_PX ? above : part.bottom - bounds.top + TIP_GAP_PX;
  node.style.left = `${Math.round(left)}px`;
  node.style.top = `${Math.round(top)}px`;
}

/** What a tip says, as the elements that show it. */
export function tipNodes(tip: Tip): HTMLElement[] {
  const aside = tip.aside === undefined ? [] : [element('span', { className: 'hud-tip__aside', text: tip.aside })];
  const facts = (tip.facts ?? []).map(({ text, pool }) =>
    element('span', { className: pool === undefined ? 'hud-tip__fact' : `hud-tip__fact hud-tip__fact--${pool}`, text }),
  );
  const titles = [
    element('div', {
      className: 'hud-tip__head',
      children: [
        element('span', { className: tip.rarity === undefined ? 'hud-tip__title' : `hud-tip__title hud-rarity--${tip.rarity}`, text: tip.title }),
        ...aside,
      ],
    }),
    ...(facts.length === 0 ? [] : [element('div', { className: 'hud-tip__facts', children: facts })]),
  ];
  const top =
    tip.icon === undefined
      ? titles
      : [
          element('div', {
            className: tip.rarity === undefined ? 'hud-tip__top' : `hud-tip__top hud-rarity--${tip.rarity}`,
            children: [itemIcon(tip.icon), element('div', { className: 'hud-tip__titles', children: titles })],
          }),
        ];
  return [
    ...top,
    ...(tip.lines ?? []).map((line) => element('p', { className: 'hud-tip__line', text: line })),
    ...(tip.warning === undefined ? [] : [element('p', { className: 'hud-tip__warning', text: tip.warning })]),
  ];
}
