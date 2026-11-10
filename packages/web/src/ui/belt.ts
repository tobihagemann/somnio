import { abilityTeaching, isTeachingId, poolShare, practiceNeeded, teaching } from '@somnio/core';
import type { AbilityId, EngageAction } from '@somnio/core';
import type { LucidityMessage } from '@somnio/protocol';
import { taskIsDone, wholeSecondsLeft } from '@/client';
import type { AbilitySlotState, CooldownSpan } from '@/client';
import { t } from '@/i18n';
import { SVG_NAMESPACE, element, setHidden } from './dom';
import { ABILITY_GLYPHS, HUD_ICONS, glyph, showGlyph } from './hudIcons';
import { taskProgressText } from './servicePanel';
import { shareBar, showShare } from './unitFrames';
import type { ShareBar } from './unitFrames';

/**
 * The controls the HUD's belt is built from: the Health and Spirit globes, the Balance meter, slot 1,
 * the ability slots, Run, and the line that says what the player studies. A mouse's belt sits
 * at the bottom centre; a finger's keeps slot 1 and Run under the right thumb and Balance as a bar.
 */

/**
 * A globe's ring, in a box as wide as the globe: its line, and an arc outside it at the top and at
 * the bottom, as the chrome's borders carry brackets outside their corners. The sides stay bare,
 * where the belt's panel tucks under the globe.
 */
const GLOBE_RING = { size: 110, radius: 54, bracketRadius: 58.5, bracketDegrees: 44 } as const;

function globeRing(): SVGSVGElement {
  const { size, radius, bracketRadius, bracketDegrees } = GLOBE_RING;
  const centre = size / 2;
  const point = (degrees: number): string => {
    const radians = (degrees * Math.PI) / 180;
    return `${(centre + bracketRadius * Math.cos(radians)).toFixed(2)} ${(centre + bracketRadius * Math.sin(radians)).toFixed(2)}`;
  };
  const brackets = [90, 270].map((at) => `M${point(at - bracketDegrees / 2)}A${bracketRadius} ${bracketRadius} 0 0 1 ${point(at + bracketDegrees / 2)}`);
  const svg = document.createElementNS(SVG_NAMESPACE, 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('hud-globe__ring');
  const circle = document.createElementNS(SVG_NAMESPACE, 'circle');
  circle.setAttribute('cx', String(centre));
  circle.setAttribute('cy', String(centre));
  circle.setAttribute('r', String(radius));
  const arcs = document.createElementNS(SVG_NAMESPACE, 'path');
  arcs.setAttribute('d', brackets.join(''));
  svg.append(circle, arcs);
  return svg;
}

/** A pool as a dark well in a line-art ring, filled flat from the bottom to its share, and showing its number. */
export class PoolGlobe {
  readonly root: HTMLElement;
  private readonly level: HTMLElement;
  private readonly value: HTMLElement;
  private shown: string | undefined;

  constructor(pool: 'health' | 'spirit', label: string) {
    this.level = element('span', { className: 'hud-globe__level' });
    this.value = element('span', { className: 'hud-globe__number' });
    this.root = element('div', {
      className: `hud-globe hud-globe--${pool}`,
      attributes: { role: 'meter', 'aria-label': label, 'aria-valuemin': 0 },
      children: [
        element('span', { className: 'hud-globe__well', children: [this.level] }),
        globeRing(),
        element('span', { className: 'hud-globe__value', attributes: { 'aria-hidden': 'true' }, children: [this.value, element('small', { text: label })] }),
      ],
    });
  }

  render(current: number, max: number): void {
    const shown = JSON.stringify([current, max]);
    if (shown === this.shown) return;
    this.shown = shown;
    this.level.style.height = `${(poolShare(current, max) * 100).toFixed(2)}%`;
    this.value.textContent = String(current);
    this.root.setAttribute('aria-valuenow', String(current));
    this.root.setAttribute('aria-valuemax', String(max));
  }
}

/** The arc across the belt's top, in a box as wide as the belt that it is stretched to. */
const BALANCE_ARC = 'M4 15 Q196 -1 388 15';

/**
 * Balance: a gold arc across a mouse's belt, or a thin bar on a finger's layout. While the player is
 * winded it turns orange and a tag says so.
 */
export class BalanceMeter {
  readonly root: HTMLElement;
  private readonly arcFill: SVGPathElement | undefined;
  private readonly bar: ShareBar | undefined;
  private readonly windedTag: HTMLElement;
  private shown: string | undefined;

  constructor(shape: 'arc' | 'bar') {
    this.windedTag = element('span', { className: 'hud-winded hidden', text: t('Winded'), attributes: { 'aria-hidden': 'true' } });
    if (shape === 'arc') {
      const svg = document.createElementNS(SVG_NAMESPACE, 'svg');
      svg.setAttribute('viewBox', '0 0 392 18');
      svg.setAttribute('preserveAspectRatio', 'none');
      svg.setAttribute('aria-hidden', 'true');
      svg.classList.add('hud-balance__arc');
      const path = (className: string): SVGPathElement => {
        const node = document.createElementNS(SVG_NAMESPACE, 'path');
        node.setAttribute('d', BALANCE_ARC);
        node.setAttribute('class', className);
        svg.append(node);
        return node;
      };
      path('hud-balance__edge');
      path('hud-balance__track');
      this.arcFill = path('hud-balance__fill');
      this.arcFill.setAttribute('pathLength', '100');
      this.arcFill.setAttribute('stroke-dasharray', '0 200');
      this.arcFill.setAttribute('stroke-opacity', '0');
      this.root = element('div', { className: 'hud-balance hud-balance--arc', attributes: { role: 'meter', 'aria-valuemin': 0 } });
      this.root.append(this.windedTag, svg);
    } else {
      this.bar = shareBar('hud-bar__fill--balance');
      this.bar.root.removeAttribute('role');
      this.root = element('div', {
        className: 'hud-balance hud-balance--bar',
        attributes: { role: 'meter', 'aria-valuemin': 0 },
        children: [this.windedTag, this.bar.root],
      });
    }
  }

  render(current: number, max: number, winded: boolean): void {
    const shown = JSON.stringify([current, max, winded]);
    if (shown === this.shown) return;
    this.shown = shown;
    const share = poolShare(current, max);
    const reading = `${t('Balance')} ${current}/${max}${winded ? `, ${t('winded')}` : ''}`;
    // The gap runs past the path's end, so the dash is drawn once.
    this.arcFill?.setAttribute('stroke-dasharray', `${(share * 100).toFixed(2)} 200`);
    // An empty pool draws no round cap at all.
    this.arcFill?.setAttribute('stroke-opacity', share > 0 ? '1' : '0');
    if (this.bar !== undefined) showShare(this.bar, share, reading);
    this.root.setAttribute('aria-label', reading);
    this.root.setAttribute('title', reading);
    this.root.setAttribute('aria-valuenow', String(current));
    this.root.setAttribute('aria-valuemax', String(max));
    this.root.classList.toggle('hud-balance--winded', winded);
    setHidden(this.windedTag, !winded);
  }
}

/** What slot 1 looks like: Attack at a nightmare, Mend at a standing dreamer, and Raise at a fallen one. */
export type SlotOneLook = EngageAction | 'raise';

const SLOT_ONE_LABELS: Record<SlotOneLook, () => string> = {
  attack: () => t('Attack'),
  mend: () => t('Mend'),
  raise: () => t('Raise'),
};

/**
 * Slot 1's toggle, named and drawn for what it does at the target, lit and pressed while it is on,
 * and greyed out while it can do nothing there, keeping its last look then. It stays one element,
 * its glyph swapped in place, so a click is never lost to a repaint.
 */
export class SlotOneButton {
  readonly root: HTMLButtonElement;
  private readonly glyph: HTMLElement;
  private readonly orb: boolean;
  private look: SlotOneLook = 'attack';
  private shown: string | undefined;

  /** `orb` is a finger's big round button; otherwise a square slot with its key number. */
  constructor(onPress: () => void, orb: boolean) {
    this.glyph = glyph(HUD_ICONS.attack);
    this.root = element('button', {
      className: orb ? 'hud-orb hud-orb--act' : 'fantasy-button hud-slot hud-slot--act',
      attributes: { type: 'button', 'aria-pressed': 'false' },
      children: [...(orb ? [] : [element('span', { className: 'hud-slot__key', text: '1', attributes: { 'aria-hidden': 'true' } })]), this.glyph],
    });
    this.root.addEventListener('click', onPress);
    this.orb = orb;
  }

  render(engaged: boolean, action: EngageAction | undefined, targetFallen: boolean): void {
    if (action !== undefined) this.look = action === 'mend' && targetFallen ? 'raise' : action;
    const shown = JSON.stringify([engaged, action ?? null, this.look]);
    if (shown === this.shown) return;
    this.shown = shown;
    this.root.setAttribute('aria-pressed', String(engaged));
    this.root.disabled = action === undefined;
    this.root.dataset['look'] = this.look;
    showGlyph(this.glyph, HUD_ICONS[this.look]);
    const label = SLOT_ONE_LABELS[this.look]();
    this.root.setAttribute('aria-label', label);
    this.root.setAttribute('title', this.orb ? label : `${label} (1)`);
  }
}

/** The Run toggle, lit while Run is on. */
export function runButton(onPress: () => void, orb: boolean): HTMLButtonElement {
  const node = orb
    ? element('button', { className: 'hud-orb hud-orb--run', text: t('Run'), attributes: { type: 'button', 'aria-pressed': 'false' } })
    : element('button', {
        className: 'fantasy-button hud-slot hud-slot--run',
        attributes: { type: 'button', 'aria-pressed': 'false', 'aria-label': t('Run'), title: t('Run (Shift)') },
        children: [element('span', { className: 'hud-slot__key', text: '⇧', attributes: { 'aria-hidden': 'true' } }), glyph(HUD_ICONS.run)],
      });
  node.addEventListener('click', onPress);
  return node;
}

/**
 * An ability's slot, named and drawn for it, greyed out while the server would not act on it, and
 * swept dark while it waits on a cooldown. The sweep is a CSS animation timed from when the server
 * says the cooldown began, so the slot keeps its elements while what it shows is unchanged, and only
 * a new cooldown starts a new sweep. Its own cooldown counts down in whole seconds; the short global
 * one only sweeps.
 */
export class AbilitySlot {
  readonly root: HTMLButtonElement;
  readonly abilityId: AbilityId;
  private sweep: HTMLElement;
  private readonly seconds: HTMLElement;
  private cooldown: CooldownSpan | undefined;
  private shown: string | undefined;
  private shownSeconds = '';

  /** `orb` is a finger's round button on the arc; otherwise a square slot with its key number. */
  constructor(abilityId: AbilityId, key: number, onPress: () => void, orb: boolean) {
    this.abilityId = abilityId;
    const label = t(teaching(abilityTeaching(abilityId)).labelKey);
    this.sweep = element('span', { className: 'hud-sweep hidden', attributes: { 'aria-hidden': 'true' } });
    this.seconds = element('span', { className: 'hud-sweep__seconds', attributes: { 'aria-hidden': 'true' } });
    this.root = element('button', {
      className: orb ? 'hud-orb hud-orb--ability' : 'fantasy-button hud-slot hud-slot--ability',
      attributes: { type: 'button', 'aria-label': label, title: orb ? label : `${label} (${key})` },
      children: [
        ...(orb ? [] : [element('span', { className: 'hud-slot__key', text: String(key), attributes: { 'aria-hidden': 'true' } })]),
        glyph(ABILITY_GLYPHS[abilityId]),
        this.sweep,
        this.seconds,
      ],
    });
    this.root.addEventListener('click', onPress);
  }

  render(state: AbilitySlotState, nowMs: number): void {
    const shown = JSON.stringify([state.usable, state.cooldown ?? null]);
    if (shown === this.shown) return;
    this.shown = shown;
    const cooling = state.cooldown !== undefined;
    this.root.disabled = !state.usable || cooling;
    this.root.classList.toggle('hud-ability--greyed', !state.usable);
    if (cooling) this.root.setAttribute('aria-description', t('cooling down'));
    else this.root.removeAttribute('aria-description');
    if (JSON.stringify(state.cooldown ?? null) !== JSON.stringify(this.cooldown ?? null)) this.startSweep(state.cooldown, nowMs);
    this.tick(nowMs);
  }

  /** The whole seconds left on the slot's own cooldown. */
  tick(nowMs: number): void {
    const cooldown = this.cooldown;
    const seconds = cooldown === undefined || cooldown.global ? '' : t('%@s', String(wholeSecondsLeft(cooldown.endsAtMs, nowMs)));
    if (seconds === this.shownSeconds) return;
    this.shownSeconds = seconds;
    this.seconds.textContent = seconds;
  }

  /** A new sweep for a new cooldown, already as far along as the cooldown is: an animation restarts only on a new element. */
  private startSweep(cooldown: CooldownSpan | undefined, nowMs: number): void {
    this.cooldown = cooldown;
    if (cooldown === undefined) {
      setHidden(this.sweep, true);
      return;
    }
    const sweep = element('span', { className: 'hud-sweep', attributes: { 'aria-hidden': 'true' } });
    sweep.style.animationDuration = `${Math.round(cooldown.endsAtMs - cooldown.startedAtMs)}ms`;
    sweep.style.animationDelay = `${Math.round(cooldown.startedAtMs - nowMs)}ms`;
    this.sweep.replaceWith(sweep);
    this.sweep = sweep;
  }
}

/** A slot no ability fills yet, with its key number. */
export function emptySlot(key: number, orb: boolean): HTMLElement {
  return element('span', {
    className: orb ? 'hud-orb hud-orb--empty' : 'fantasy-button hud-slot hud-slot--empty',
    attributes: { 'aria-hidden': 'true', title: t('Empty slot') },
    children: [element('span', { className: 'hud-slot__key', text: String(key) })],
  });
}

/**
 * The one line under the slots, the first that applies: a task done, which sends the player back to
 * their master; what they study and how far toward its next rank, as a share; the task they hold;
 * or, for a role holder, that they study nothing. `emphasis` is the teaching's name, to stress.
 */
export function studyLine(lucidity: LucidityMessage): { text: string; emphasis?: string } | undefined {
  const task = lucidity.task;
  const progress = task === undefined ? undefined : taskProgressText(task);
  if (task !== undefined && taskIsDone(task)) return { text: t('Your task is done. Return to your master.') };
  const study = lucidity.study;
  if (study !== undefined && isTeachingId(study)) {
    const held = lucidity.ranks.find((rank) => rank.teachingId === study);
    const share = Math.floor(((held?.practice ?? 0) / practiceNeeded(held?.rank ?? 0)) * 100);
    const name = t(teaching(study).labelKey);
    return { text: t('Studying %1$@ · %2$@%%', name, String(Math.min(share, 100))), emphasis: name };
  }
  if (progress !== undefined) return { text: t('Task: %@', progress) };
  return lucidity.role === undefined ? undefined : { text: t('Studying nothing') };
}

/** Writes a study line into `node`, its teaching's name in bold. */
export function showStudyLine(node: HTMLElement, line: ReturnType<typeof studyLine>): void {
  if (line === undefined) {
    node.replaceChildren();
    return;
  }
  const at = line.emphasis === undefined ? -1 : line.text.indexOf(line.emphasis);
  if (line.emphasis === undefined || at < 0) {
    node.replaceChildren(line.text);
    return;
  }
  node.replaceChildren(line.text.slice(0, at), element('b', { text: line.emphasis }), line.text.slice(at + line.emphasis.length));
}
