import { clamp, conditionMidpoint, peopleLabelKey, poolShare, roleLabelKey } from '@somnio/core';
import type { EffectId, People } from '@somnio/core';
import type { Condition, Energy, Role } from '@somnio/protocol';
import { wholeSecondsLeft } from '@/client';
import type { ClientEffect, ClientEntity } from '@/client';
import { t } from '@/i18n';
import { playerPlaqueBackground } from '@/scene/overlayArt';
import { element, iconButton, setHidden } from './dom';
import { EFFECT_GLYPHS, HUD_ICONS, PEOPLE_SIGILS, glyph } from './hudIcons';

/**
 * The unit frames at the top: the player's own at the top left, a press on which makes them their
 * own target, and the target's at the top centre. Each carries a row of the effects on its entity.
 */

/** A condition as a word, which the target frame carries in its accessible name. */
const CONDITION_WORDS: Record<Condition, () => string> = {
  hale: () => t('hale'),
  grazed: () => t('grazed'),
  wounded: () => t('wounded'),
  hurt: () => t('hurt'),
  failing: () => t('failing'),
  fallen: () => t('fallen'),
};

const EFFECT_NAMES: Record<EffectId, () => string> = {
  braced: () => t('Braced'),
  challenged: () => t('Challenged'),
};

/**
 * The effects on a framed entity, one glyph each with the whole seconds it has left, in the order
 * the server sent them. An effect keeps its element while it holds, refreshed or not.
 */
class EffectRow {
  readonly root: HTMLElement;
  private readonly items = new Map<EffectId, { root: HTMLElement; seconds: HTMLElement; endsAtMs: number | undefined; shown: string | undefined }>();
  private shown: string | undefined;

  constructor() {
    this.root = element('span', { className: 'hud-effects', attributes: { role: 'list', 'aria-label': t('Effects'), 'aria-hidden': 'true' } });
  }

  render(effects: readonly ClientEffect[], nowMs: number): void {
    const shown = JSON.stringify(effects);
    if (shown === this.shown) return;
    this.shown = shown;
    // An empty row keeps its height, so the frame does not jump, but stays out of the frame's name.
    if (effects.length === 0) this.root.setAttribute('aria-hidden', 'true');
    else this.root.removeAttribute('aria-hidden');
    const held = new Set(effects.map(({ effectId }) => effectId));
    for (const effectId of this.items.keys()) if (!held.has(effectId)) this.items.delete(effectId);
    for (const { effectId, endsAtMs } of effects) {
      const item = this.items.get(effectId);
      if (item !== undefined) {
        item.endsAtMs = endsAtMs;
        continue;
      }
      const seconds = element('span', { className: 'hud-effect__seconds', attributes: { 'aria-hidden': 'true' } });
      const root = element('span', {
        className: 'hud-effect',
        attributes: { role: 'listitem', title: EFFECT_NAMES[effectId]() },
        children: [element('span', { className: 'hud-effect__glyph', children: [glyph(EFFECT_GLYPHS[effectId])] }), seconds],
      });
      this.items.set(effectId, { root, seconds, endsAtMs, shown: undefined });
    }
    const roots = effects.map(({ effectId }) => this.items.get(effectId)!.root);
    if (roots.some((root, index) => this.root.children[index] !== root) || this.root.children.length !== roots.length) this.root.replaceChildren(...roots);
    this.tick(nowMs);
  }

  /** The whole seconds each effect has left, and its name with them for assistive tech. An effect without an end shows none. */
  tick(nowMs: number): void {
    for (const [effectId, item] of this.items) {
      const left = item.endsAtMs === undefined ? undefined : String(wholeSecondsLeft(item.endsAtMs, nowMs));
      const shown = left ?? '';
      if (shown === item.shown) continue;
      item.shown = shown;
      item.seconds.textContent = left === undefined ? '' : t('%@s', left);
      item.root.setAttribute('aria-label', left === undefined ? EFFECT_NAMES[effectId]() : t('%1$@, %2$@ s left', EFFECT_NAMES[effectId](), left));
    }
  }
}

/** A thin bar: a dark track with a light rim and a fill as wide as its share. */
export interface ShareBar {
  root: HTMLElement;
  fill: HTMLElement;
}

export function shareBar(fillClass: string): ShareBar {
  const fill = element('span', { className: `hud-bar__fill ${fillClass}` });
  return { root: element('span', { className: 'hud-bar', attributes: { role: 'img' }, children: [fill] }), fill };
}

/** Sets a bar's fill and the reading its tooltip and accessible name carry. */
export function showShare(bar: ShareBar, share: number, reading: string): void {
  bar.fill.style.width = `${(clamp(share, 0, 1) * 100).toFixed(2)}%`;
  bar.root.setAttribute('title', reading);
  bar.root.setAttribute('aria-label', reading);
}

/**
 * A frame's portrait: a ring round a circle left open, through which the scene draws the body on the
 * canvas under the HUD (`scene/portraits.ts`).
 */
function portraitSlot(...children: HTMLElement[]): HTMLElement {
  return element('span', { className: 'hud-portrait', attributes: { 'aria-hidden': 'true' }, children });
}

/** Rings the portrait in the tint of the player's own plaque, which follows their condition. */
function ringPortrait(frame: HTMLElement, condition: Condition): void {
  frame.style.setProperty('--hud-tint', playerPlaqueBackground(condition));
}

/** What the player's own frame shows. Their people is unknown when the server names one this client does not know. */
export interface OwnFrameState {
  name: string;
  people: People | undefined;
  role: Role | undefined;
  condition: Condition;
  /** Whether the player is their own target. */
  targeted: boolean;
  effects: readonly ClientEffect[];
}

export class OwnFrame {
  readonly root: HTMLButtonElement;
  readonly portrait: HTMLElement;
  readonly effects = new EffectRow();
  /** The people's sigil, on a badge at the portrait's foot. */
  private readonly sigil: HTMLElement;
  private readonly name: HTMLElement;
  /** The people and the role, on a mouse's frame. */
  private readonly traits: HTMLElement | undefined;
  /** Health and Spirit, on a finger's frame, which has no globes. */
  private readonly pools: { health: ShareBar; spirit: ShareBar } | undefined;
  private shown: string | undefined;
  /** The people whose sigil is drawn, `null` before the first render. */
  private shownPeople: People | undefined | null = null;
  private shownPools: string | undefined;

  constructor(onPress: () => void, coarse: boolean) {
    this.sigil = element('span', { className: 'hud-sigil' });
    this.portrait = portraitSlot(this.sigil);
    this.name = element('span', { className: 'hud-unit__name' });
    this.traits = coarse ? undefined : element('span', { className: 'hud-unit__traits' });
    this.pools = coarse ? { health: shareBar('hud-bar__fill--health'), spirit: shareBar('hud-bar__fill--spirit') } : undefined;
    const lines = [
      this.name,
      ...(this.traits === undefined ? [] : [this.traits]),
      ...(this.pools === undefined ? [] : [this.pools.health.root, this.pools.spirit.root]),
      this.effects.root,
    ];
    this.root = element('button', {
      className: 'fantasy-panel hud-unit hud-unit--self',
      attributes: { type: 'button', title: t('Target yourself'), 'aria-pressed': 'false' },
      children: [this.portrait, element('span', { className: 'hud-unit__lines', children: lines })],
    });
    this.root.addEventListener('click', onPress);
  }

  render(state: OwnFrameState, nowMs: number): void {
    this.effects.render(state.effects, nowMs);
    const shown = JSON.stringify([state.name, state.people ?? null, state.role ?? null, state.condition, state.targeted]);
    if (shown === this.shown) return;
    this.shown = shown;
    this.name.textContent = state.name;
    ringPortrait(this.root, state.condition);
    this.root.dataset['condition'] = state.condition;
    this.root.setAttribute('aria-pressed', String(state.targeted));
    if (state.people !== this.shownPeople) {
      this.shownPeople = state.people;
      this.sigil.replaceChildren(...(state.people === undefined ? [] : [glyph(PEOPLE_SIGILS[state.people])]));
    }
    if (this.traits !== undefined) {
      const role = state.role === undefined ? t('No role yet') : t(roleLabelKey(state.role));
      this.traits.textContent = state.people === undefined ? role : `${t(peopleLabelKey(state.people))} · ${role}`;
    }
  }

  /** A finger's frame carries the player's Health and Spirit as two bars. */
  renderPools(energy: Energy): void {
    if (this.pools === undefined) return;
    const shown = JSON.stringify([energy.healthCurrent, energy.healthMax, energy.spiritCurrent, energy.spiritMax]);
    if (shown === this.shownPools) return;
    this.shownPools = shown;
    showShare(this.pools.health, poolShare(energy.healthCurrent, energy.healthMax), `${t('Health')} ${energy.healthCurrent}/${energy.healthMax}`);
    showShare(this.pools.spirit, poolShare(energy.spiritCurrent, energy.spiritMax), `${t('Spirit')} ${energy.spiritCurrent}/${energy.spiritMax}`);
  }
}

/** What the target frame shows: the entity, its effects, and the share of its health the server last sent, `undefined` before it has. */
export interface FramedEntity {
  entity: ClientEntity;
  health: number | undefined;
  effects: readonly ClientEffect[];
}

/**
 * The target's frame: its name over a bar of its health, and a ✕ that clears the target. Its
 * condition, and whether the player's facing is locked on it, are in its accessible name; the
 * world shows the lock by the reticle round the target.
 */
export class TargetFrame {
  readonly root: HTMLElement;
  readonly portrait: HTMLElement;
  readonly effects = new EffectRow();
  private readonly name: HTMLElement;
  private readonly health: ShareBar;
  /** What it shows, compared by value: an entity is a new object after each of its moves. */
  private shown: string | undefined;

  constructor(onClear: () => void) {
    this.name = element('span', { className: 'hud-unit__name' });
    this.health = shareBar('hud-bar__fill--health');
    const clear = iconButton(t('Clear target'), glyph(HUD_ICONS.close), onClear, { className: 'hud-unit__clear' });
    this.portrait = portraitSlot();
    const lines = element('span', {
      className: 'hud-unit__lines',
      children: [element('span', { className: 'hud-unit__caption', text: t('Target') }), this.name, this.health.root, this.effects.root],
    });
    this.root = element('section', {
      className: 'fantasy-panel hud-unit hud-unit--target hidden',
      attributes: { 'aria-label': t('Target') },
      children: [this.portrait, lines, clear],
    });
  }

  render(target: FramedEntity | undefined, gazeLocked: boolean, nowMs: number): void {
    this.effects.render(target?.effects ?? [], nowMs);
    const shown =
      target === undefined
        ? undefined
        : JSON.stringify([target.entity.id, target.entity.name, target.entity.kind, target.entity.condition, target.health ?? null, gazeLocked]);
    if (shown === this.shown) return;
    this.shown = shown;
    setHidden(this.root, target === undefined);
    if (target === undefined) return;
    const { entity, health } = target;
    // A nightmare's name is its kind's catalog key; a dreamer's or an NPC's is their own.
    this.name.textContent = entity.kind === 'monster' ? t(entity.name) : entity.name;
    const condition = CONDITION_WORDS[entity.condition]();
    this.root.setAttribute('aria-label', gazeLocked ? t('Target, %@, facing locked', condition) : t('Target, %@', condition));
    // Before the server has sent the share itself, the middle of the band.
    const share = health ?? conditionMidpoint(entity.condition);
    showShare(this.health, share, health === undefined ? t('Health') : `${t('Health')} ${Math.round(clamp(share, 0, 1) * 100)}%`);
  }
}
