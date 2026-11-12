import { afterEach, describe, expect, it, vi } from 'vitest';
import { GameHUD } from '@/ui/hud';
import { CHAT_IDLE_MS } from '@/ui/chatPane';
import { TAB_SPRING_MS } from '@/ui/characterWindow';
import { HUD_ICONS, PEOPLE_SIGILS } from '@/ui/hudIcons';
import { ITEM_ICONS } from '@/ui/itemIcons';
import { TIP_HOLD_MS } from '@/ui/hudTooltip';
import { NAMED_PLACES, placeName } from '@/ui/placeNames';
import { SensedMarkers } from '@/ui/sensedMarkers';
import { catalogTables, setLocale } from '@/i18n';
import { SECTOR_FIXTURE_NAMES } from '../../core/test/support/sectorFixture.ts';
import { SOMNIO_PROTOCOL_CONSTANTS } from '@somnio/protocol';
import type { Energy, LucidityMessage } from '@somnio/protocol';
import { TAP_SLOP_PX } from '@/client';
import type { AbilitySlotState, ChatLine } from '@/client';
import type { AbilityId, ItemInstance } from '@somnio/core';
import type { HUDCallbacks } from '@/ui/hud';
import { carrying, item } from './helpers/inventory';
import { clientEntity } from './helpers/worldFixture';

/**
 * The HUD on its own, against `happy-dom`: what each part shows for the state it is handed, what a
 * press on it reports, and that it keeps its elements while what it shows is unchanged. Its wiring
 * to the session through the shell is in `ui.test.ts`.
 */

/** Every press the HUD reports, by callback, in order. */
function recording() {
  const calls: [keyof HUDCallbacks, ...unknown[]][] = [];
  const record =
    <K extends keyof HUDCallbacks>(name: K) =>
    (...args: unknown[]) => {
      calls.push([name, ...args]);
    };
  const callbacks: HUDCallbacks = {
    onSubmitChat: record('onSubmitChat'),
    onChatFocusChange: record('onChatFocusChange'),
    onTellPurse: record('onTellPurse'),
    onEquip: record('onEquip'),
    onUnequip: record('onUnequip'),
    onMoveItem: record('onMoveItem'),
    onDropItem: record('onDropItem'),
    onToggleRun: record('onToggleRun'),
    onToggleEngage: record('onToggleEngage'),
    onUseAbility: record('onUseAbility'),
    onPressPlayer: record('onPressPlayer'),
    onPressOwnFrame: record('onPressOwnFrame'),
    onClearTarget: record('onClearTarget'),
    onOpenSettings: record('onOpenSettings'),
    onHoverChange: record('onHoverChange'),
  };
  return { callbacks, calls, named: (name: keyof HUDCallbacks) => calls.filter(([called]) => called === name).map(([, ...args]) => args) };
}

function point(node: Element, type: string, init: PointerEventInit = {}): void {
  node.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, pointerType: 'mouse', ...init }));
}

/** A pointer coming to rest on `node`, as a mouse with no button held unless `init` says otherwise. */
function hover(node: Element, init: PointerEventInit = {}): void {
  point(node, 'pointerover', init);
}

/** A press as a pointer of the type makes it: down, up, and a click. */
function pointerPress(node: Element, pointerType = 'mouse'): void {
  point(node, 'pointerdown', { pointerType });
  point(node, 'pointerup', { pointerType });
  node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
}

/** Two presses in quick succession, as a browser reports a double click. */
function doubleClick(node: Element, pointerType = 'mouse'): void {
  pointerPress(node, pointerType);
  point(node, 'pointerdown', { pointerType });
  point(node, 'pointerup', { pointerType });
  node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 2 }));
  node.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 }));
}

/** What the open item's card says, its buttons' labels last, or `undefined` while it is closed. */
function cardSays(root: HTMLElement): (string | null)[] | undefined {
  const card = root.querySelector('.hud-item-card');
  if (card === null || card.classList.contains('hidden')) return undefined;
  return [...card.querySelectorAll('.hud-tip__title, .hud-tip__fact, .hud-tip__line, .hud-tip__warning, button')].map((node) => node.textContent);
}

/** What the HUD's tip says, part by part, or `undefined` while it is hidden. */
function tipSays(root: HTMLElement): (string | null)[] | undefined {
  const tip = root.querySelector('[role="tooltip"]');
  if (tip === null || tip.classList.contains('hidden')) return undefined;
  return [...tip.querySelectorAll('.hud-tip__title, .hud-tip__aside, .hud-tip__fact, .hud-tip__line, .hud-tip__warning')].map((node) => node.textContent);
}

/** The mask image of the glyph in `node`, which says which glyph it draws. */
function drawnGlyph(node: Element | null): string | undefined {
  return node?.querySelector<HTMLElement>('.hud-glyph')?.style.getPropertyValue('--hud-glyph');
}

/** The picture of the item in `node`, which says which item it draws. */
function drawnIcon(node: Element | null): string | undefined {
  return node?.querySelector<HTMLImageElement>('.hud-item-icon')?.getAttribute('src') ?? undefined;
}

let clock = 0;
const mounted: HTMLElement[] = [];

/** A HUD in the document, so focus and blur behave as in a browser, on a clock the test moves. */
function makeHUD(coarse = false) {
  const record = recording();
  clock = 1000;
  const hud = new GameHUD(record.callbacks, { tables: catalogTables, locale: 'en', coarse, now: () => clock });
  document.body.append(hud.root);
  mounted.push(hud.root);
  hud.setShown(true);
  const $ = <T extends Element = HTMLElement>(selector: string): T => {
    const node = hud.root.querySelector<T>(selector);
    if (node === null) throw new Error(`no ${selector}`);
    return node;
  };
  const button = (label: string): HTMLButtonElement => $(`button[aria-label="${label}"]`);
  return { hud, $, button, ...record };
}

afterEach(() => {
  for (const root of mounted.splice(0)) root.remove();
  setLocale('en');
});

const POOLS: Energy = { healthCurrent: 30, healthMax: 60, balanceCurrent: 1, balanceMax: 4, spiritCurrent: 5, spiritMax: 10 };
const HEALER = {
  name: 'Smokewalker',
  people: 'vigils',
  role: 'healer',
  condition: 'hale',
  targeted: false,
  effects: [],
  channel: undefined,
  raise: undefined,
} as const;
const NO_CLOCK = { worldSeconds: undefined, place: undefined };
const FIGHTER: LucidityMessage = { role: 'fighter', ranks: [] };

/** An ability's slot the server would act on now, with no cooldown running. */
const ready = (abilityId: AbilityId, rank = 1): AbilitySlotState => ({ abilityId, rank, refusal: undefined, cooldown: undefined });

describe("a mouse's HUD", () => {
  it('lays out the frames, the clock, the belt with its six slots and Run, the menu, and the chat', () => {
    const { hud, $ } = makeHUD();

    expect($('.hud-unit--self').tagName).toBe('BUTTON');
    expect($('.hud-unit--target').classList.contains('hidden')).toBe(true);
    expect($('.hud-clock')).toBeDefined();
    expect([...hud.root.querySelectorAll('.hud-globe')].map((globe) => globe.getAttribute('aria-label'))).toEqual(['Health', 'Spirit']);
    expect($('.hud-balance__arc')).toBeDefined();
    const keys = [...$('.hud-slots').children].map((slot) => slot.querySelector('.hud-slot__key')?.textContent);
    expect(keys).toEqual(['1', '2', '3', '4', '5', '6', '⇧']);
    // Slots 2 to 6 wait for abilities: nothing to press, and no ability drawn in them.
    for (const slot of hud.root.querySelectorAll('.hud-slot--empty')) {
      expect(slot.tagName).toBe('SPAN');
      expect(slot.getAttribute('aria-hidden')).toBe('true');
      expect(slot.querySelector('.hud-glyph')).toBeNull();
    }
    expect([...$('.hud-menu').querySelectorAll('button')].map((node) => node.getAttribute('aria-label'))).toEqual(['Players', 'Character', 'Settings']);
    expect($('.chat-scrollback').getAttribute('role')).toBe('log');
    expect([...hud.root.querySelectorAll('.hud-window')].every((window) => window.classList.contains('hidden'))).toBe(true);
  });

  it('fills the globes and the Balance arc with the exact pools, each by its own maximum', () => {
    const { hud, $ } = makeHUD();
    hud.renderPools(POOLS, false);

    const globe = (pool: string) => $(`.hud-globe--${pool}`);
    expect(globe('health').querySelector<HTMLElement>('.hud-globe__level')?.style.height).toBe('50.00%');
    expect(globe('health').querySelector('.hud-globe__number')?.textContent).toBe('30');
    expect([globe('health').getAttribute('aria-valuenow'), globe('health').getAttribute('aria-valuemax')]).toEqual(['30', '60']);
    expect(globe('spirit').querySelector<HTMLElement>('.hud-globe__level')?.style.height).toBe('50.00%');
    expect(globe('spirit').querySelector('.hud-globe__number')?.textContent).toBe('5');
    expect($('.hud-balance__fill').getAttribute('stroke-dasharray')).toBe('25.00 200');
    expect($('.hud-balance').getAttribute('aria-label')).toBe('Balance 1/4');

    // A maximum that arrives as zero empties the pool rather than drawing NaN.
    hud.renderPools({ ...POOLS, healthMax: 0 }, false);
    expect(globe('health').querySelector<HTMLElement>('.hud-globe__level')?.style.height).toBe('0.00%');
  });

  it('turns the Balance arc orange with a Winded tag only while winded', () => {
    const { hud, $ } = makeHUD();
    hud.renderPools(POOLS, true);
    expect($('.hud-balance').classList.contains('hud-balance--winded')).toBe(true);
    expect($('.hud-winded').classList.contains('hidden')).toBe(false);
    expect($('.hud-winded').textContent).toBe('Winded');
    expect($('.hud-balance').getAttribute('aria-label')).toBe('Balance 1/4, winded');

    hud.renderPools({ ...POOLS, balanceCurrent: 3 }, false);
    expect($('.hud-balance').classList.contains('hud-balance--winded')).toBe(false);
    expect($('.hud-winded').classList.contains('hidden')).toBe(true);
  });

  it('names and draws slot 1 for what it does at the target, greys it out at nothing, and lights it while on', () => {
    const { hud, $ } = makeHUD();
    const slot = $<HTMLButtonElement>('.hud-slot--act');
    const shown = () => [slot.getAttribute('aria-label'), slot.dataset['look'], drawnGlyph(slot), slot.disabled, slot.getAttribute('aria-pressed')];

    hud.renderSlotOne(false, undefined, false);
    expect(shown()).toEqual(['Attack', 'attack', HUD_ICONS.attack.image, true, 'false']);
    hud.renderSlotOne(true, 'attack', false);
    expect(shown()).toEqual(['Attack', 'attack', HUD_ICONS.attack.image, false, 'true']);
    hud.renderSlotOne(true, 'mend', false);
    expect(shown()).toEqual(['Mend', 'mend', HUD_ICONS.mend.image, false, 'true']);
    hud.renderSlotOne(false, 'mend', true);
    expect(shown()).toEqual(['Raise', 'raise', HUD_ICONS.raise.image, false, 'false']);
    // At nothing it keeps the look it last had.
    hud.renderSlotOne(false, undefined, false);
    expect(shown()).toEqual(['Raise', 'raise', HUD_ICONS.raise.image, true, 'false']);
    expect($('.hud-slot--act')).toBe(slot);
  });

  it('reports slot 1 and Run, and lights Run while it is on', () => {
    const { hud, $, button, named } = makeHUD();
    hud.renderSlotOne(false, 'attack', false);
    $<HTMLButtonElement>('.hud-slot--act').click();
    button('Run').click();
    hud.renderRun(true, false);
    expect(named('onToggleEngage')).toHaveLength(1);
    expect(named('onToggleRun')).toHaveLength(1);
    expect(button('Run').getAttribute('aria-pressed')).toBe('true');
  });

  it('shows Run held off while an effect keeps the player from running, still lit and still pressable', () => {
    const { hud, button, named } = makeHUD();
    hud.renderRun(true, true);
    expect(button('Run').classList).toContain('hud-run--held');
    expect(button('Run').getAttribute('aria-description')).toBe('held off');
    expect(button('Run').getAttribute('aria-pressed')).toBe('true');
    button('Run').click();
    expect(named('onToggleRun')).toHaveLength(1);
    hud.renderRun(true, false);
    expect(button('Run').classList).not.toContain('hud-run--held');
    expect(button('Run').hasAttribute('aria-description')).toBe(false);
  });

  it('puts the abilities learned in the slots after slot 1, in the order given, each named, drawn, and keyed, and reports a press', () => {
    const { hud, $, button, named } = makeHUD();
    const slots = () =>
      [...$('.hud-slots').children].slice(1, 6).map((slot) => [slot.querySelector('.hud-slot__key')?.textContent, slot.getAttribute('aria-label')]);

    hud.renderAbilities([ready('cleave'), ready('lunge')]);
    expect(slots()).toEqual([
      ['2', 'Cleave'],
      ['3', 'Lunge'],
      ['4', null],
      ['5', null],
      ['6', null],
    ]);
    expect([drawnGlyph(button('Cleave')), drawnGlyph(button('Lunge'))]).toEqual([HUD_ICONS.cleave.image, HUD_ICONS.lunge.image]);
    button('Lunge').click();
    expect(named('onUseAbility')).toEqual([['lunge']]);

    // An ability learned earlier in the order moves the later ones along.
    hud.renderAbilities([ready('cleave'), ready('brace'), ready('lunge')]);
    expect(slots().map(([key, label]) => `${label}:${key}`)).toEqual(['Cleave:2', 'Brace:3', 'Lunge:4', 'null:5', 'null:6']);
    hud.renderAbilities([]);
    expect($('.hud-slots').querySelectorAll('.hud-slot--empty')).toHaveLength(5);
  });

  it('greys an ability out while the server would not act on it, and sweeps it from the start the server gave while it waits on a cooldown, counting its own down', () => {
    const { hud, button } = makeHUD();
    const slot = () => button('Brace');
    const sweep = () => slot().querySelector<HTMLElement>('.hud-sweep')!;
    const seconds = () => slot().querySelector('.hud-sweep__seconds')?.textContent;
    const look = () => [
      slot().disabled,
      slot().classList.contains('hud-ability--greyed'),
      sweep().classList.contains('hidden'),
      slot().getAttribute('aria-description'),
    ];

    hud.renderAbilities([{ ...ready('brace'), refusal: 'recipient' }]);
    expect(look()).toEqual([true, true, true, null]);
    hud.renderAbilities([ready('brace')]);
    expect(look()).toEqual([false, false, true, null]);

    // Fifteen seconds that began five ago, at 1000 on the HUD's clock.
    const ownCooldown = { startedAtMs: -4000, endsAtMs: 11000, global: false };
    hud.renderAbilities([{ ...ready('brace'), cooldown: ownCooldown }]);
    expect(look()).toEqual([true, false, false, 'cooling down']);
    expect([sweep().style.animationDuration, sweep().style.animationDelay, seconds()]).toEqual(['15000ms', '-5000ms', '10s']);
    const swept = sweep();
    clock = 2000;
    hud.tick(clock, NO_CLOCK);
    expect(seconds()).toBe('9s');
    // Out of reach as well, it is greyed out under the same sweep.
    hud.renderAbilities([{ ...ready('brace'), refusal: 'recipient', cooldown: ownCooldown }]);
    expect(look()).toEqual([true, true, false, 'cooling down']);
    expect(sweep()).toBe(swept);

    // The global cooldown sweeps anew and counts nothing down.
    hud.renderAbilities([{ ...ready('brace'), cooldown: { startedAtMs: 2000, endsAtMs: 2750, global: true } }]);
    expect(sweep()).not.toBe(swept);
    expect([sweep().style.animationDuration, sweep().style.animationDelay, seconds()]).toEqual(['750ms', '0ms', '']);
    hud.renderAbilities([ready('brace')]);
    expect(look()).toEqual([false, false, true, null]);
  });

  it('says what the player studies and how far toward the next rank, else the task they hold, else that they study nothing', () => {
    const { hud, $ } = makeHUD();
    const study = () => $('.hud-study');

    hud.renderLucidity({ role: 'healer', ranks: [{ teachingId: 'touch', rank: 2, practice: 20 }], study: 'touch' });
    expect(study().textContent).toBe('Studying Touch · 40%');
    expect(study().querySelector('b')?.textContent).toBe('Touch');
    hud.renderLucidity({ ranks: [], task: { role: 'fighter', progress: 0 } });
    expect(study().textContent).toBe('Task: 0 of 1');
    hud.renderLucidity({ ranks: [], task: { role: 'mystic', progress: 0b100 } });
    expect(study().textContent).toBe('Task: 1 of 3');
    hud.renderLucidity({ role: 'fighter', ranks: [] });
    expect(study().textContent).toBe('Studying nothing');
    hud.renderLucidity({ ranks: [] });
    expect(study().textContent).toBe('');
  });

  it("shows the player's own frame with their portrait, their people's sigil on a badge at its foot, name, people, and role, and reports a press on it", () => {
    const { hud, $, named } = makeHUD();
    const frame = $<HTMLButtonElement>('.hud-unit--self');
    const portrait = hud.portraits.own;
    expect(portrait.parentElement).toBe(frame);
    expect([portrait.className, portrait.getAttribute('aria-hidden')]).toEqual(['hud-portrait', 'true']);

    hud.renderSelf(HEALER);
    expect(frame.querySelector('.hud-portrait > .hud-sigil')).not.toBeNull();
    expect(frame.querySelector('.hud-unit__name')?.textContent).toBe('Smokewalker');
    expect(frame.querySelector('.hud-unit__traits')?.textContent).toBe('Vigils · Healer');
    expect(drawnGlyph(frame.querySelector('.hud-sigil'))).toBe(PEOPLE_SIGILS.vigils.image);
    expect(frame.getAttribute('aria-pressed')).toBe('false');

    hud.renderSelf({ ...HEALER, people: 'lumina', role: undefined, condition: 'grazed', targeted: true });
    expect(frame.querySelector('.hud-unit__traits')?.textContent).toBe('Lumina · No role yet');
    expect(drawnGlyph(frame.querySelector('.hud-sigil'))).toBe(PEOPLE_SIGILS.lumina.image);
    // The tint rings the portrait and its sigil. The name stays plain text, and no word names the condition.
    expect(frame.style.getPropertyValue('--hud-tint')).toBe('rgb(126, 201, 92)');
    expect(frame.style.getPropertyValue('--hud-tint-ink')).toBe('');
    expect(frame.querySelector('.hud-unit__name')?.getAttribute('style')).toBeNull();
    expect(frame.textContent).toBe('SmokewalkerLumina · No role yet');
    expect(frame.getAttribute('aria-pressed')).toBe('true');

    // A people this client does not know draws no sigil.
    hud.renderSelf({ ...HEALER, people: undefined });
    expect(frame.querySelector('.hud-unit__traits')?.textContent).toBe('Healer');
    expect(frame.querySelector('.hud-sigil')?.childElementCount).toBe(0);
    expect(frame.querySelector('.hud-portrait')).toBe(portrait);
    expect(hud.portraits.own).toBe(portrait);

    frame.click();
    expect(named('onPressOwnFrame')).toEqual([[]]);
  });

  it('shows the effects on the player and on their target in a row on each frame, a glyph each with the whole seconds it has left', () => {
    const { hud, $ } = makeHUD();
    const ghost = clientEntity({ id: 'monster:1', kind: 'monster', name: 'Ghost' });
    const own = $('.hud-unit--self .hud-effects');
    const shown = (row: Element) =>
      [...row.querySelectorAll<HTMLElement>('.hud-effect')].map((effect) => [drawnGlyph(effect), effect.textContent, effect.getAttribute('aria-label')]);
    expect(own.getAttribute('aria-label')).toBe('Effects');
    // Empty, the row stays out of the frame's accessible name.
    hud.renderSelf(HEALER);
    expect(own.getAttribute('aria-hidden')).toBe('true');

    hud.renderSelf({ ...HEALER, effects: [{ effectId: 'braced', endsAtMs: 4200 }] });
    expect(own.getAttribute('aria-hidden')).toBeNull();
    expect(shown(own)).toEqual([[HUD_ICONS.brace.image, '4s', 'Braced, 4 s left']]);
    const braced = own.firstElementChild;
    clock = 2300;
    hud.tick(clock, NO_CLOCK);
    expect(shown(own)).toEqual([[HUD_ICONS.brace.image, '2s', 'Braced, 2 s left']]);
    // Applied again, it keeps its element and starts its seconds over.
    hud.renderSelf({ ...HEALER, effects: [{ effectId: 'braced', endsAtMs: 7000 }] });
    expect(own.firstElementChild).toBe(braced);
    expect(own.textContent).toBe('5s');

    // One without seconds lasts while its holder does.
    hud.renderTarget({ entity: ghost, health: 1, effects: [{ effectId: 'challenged' }], channel: undefined, raise: undefined }, false);
    expect(shown($('.hud-unit--target .hud-effects'))).toEqual([[HUD_ICONS.challenge.image, '', 'Challenged']]);
    hud.renderSelf(HEALER);
    expect(own.childElementCount).toBe(0);
    expect(own.getAttribute('aria-hidden')).toBe('true');
  });

  it("hangs a channel's bar under the own frame and the target's, draining from when it began, and keeps its elements while the channel is the same", () => {
    const { hud, $ } = makeHUD();
    const bren = clientEntity({ id: 'peer-1', kind: 'peer', name: 'Bren' });
    const own = $('.hud-unit--self .hud-timed');
    const fill = (bar: Element) => bar.querySelector<HTMLElement>('.hud-timed__fill')!;
    hud.renderSelf(HEALER);
    expect(own.classList.contains('hidden')).toBe(true);

    const channel = { abilityId: 'deep-mend', startedAtMs: 1000, endsAtMs: 2500 } as const;
    clock = 1200;
    hud.renderSelf({ ...HEALER, channel });
    expect(own.classList.contains('hidden')).toBe(false);
    expect(own.getAttribute('aria-label')).toBe('Channelling Deep mend');
    expect(fill(own).classList.contains('hud-timed__fill--channel')).toBe(true);
    // Rendered late, a tab hidden or drawing slowly, it is already as far drained as the channel has run.
    const drained = fill(own);
    expect([drained.style.animationDuration, drained.style.animationDelay]).toEqual(['1500ms', '-200ms']);
    clock = 1800;
    hud.renderSelf({ ...HEALER, channel: { ...channel } });
    expect(fill(own)).toBe(drained);
    expect(drained.style.animationDelay).toBe('-200ms');

    // A new channel starts a new drain.
    hud.renderSelf({ ...HEALER, channel: { abilityId: 'deep-mend', startedAtMs: 1800, endsAtMs: 3000 } });
    expect(fill(own)).not.toBe(drained);
    expect([fill(own).style.animationDuration, fill(own).style.animationDelay]).toEqual(['1200ms', '0ms']);
    hud.renderSelf(HEALER);
    expect(own.classList.contains('hidden')).toBe(true);

    const target = $('.hud-unit--target .hud-timed');
    hud.renderTarget({ entity: bren, health: 1, effects: [], channel, raise: undefined }, false);
    expect(target.classList.contains('hidden')).toBe(false);
    hud.renderTarget({ entity: bren, health: 1, effects: [], channel: undefined, raise: undefined }, false);
    expect(target.classList.contains('hidden')).toBe(true);
  });

  it("hangs a raise's bar under the target frame and the own frame, filling from as far as the raise has gone, and re-timed only at a new snapshot", () => {
    const { hud, $ } = makeHUD();
    const mira = clientEntity({ id: 'peer-1', kind: 'peer', name: 'Mira', condition: 'fallen' });
    const target = $('.hud-unit--target .hud-timed');
    const fill = (bar: Element) => bar.querySelector<HTMLElement>('.hud-timed__fill')!;
    const timing = (bar: Element) => [fill(bar).style.animationDuration, fill(bar).style.animationDelay, fill(bar).style.animationTimingFunction];
    const raise = { progress: 0.25, seconds: 4.5, healerNames: ['Lumi'], atMs: 1000, endsAtMs: 5500 };
    clock = 1200;
    hud.renderTarget({ entity: mira, health: 0, effects: [], channel: undefined, raise }, false);
    expect(target.classList.contains('hidden')).toBe(false);
    expect(target.getAttribute('aria-label')).toBe('Being drawn back by Lumi');
    expect(fill(target).classList.contains('hud-timed__fill--raise')).toBe(true);
    // Rendered late, it is already as far filled as the raise has gone since its snapshot.
    expect(timing(target)).toEqual(['4500ms', '-200ms', 'linear(0.2500 0.00%, 1.0000 100.00%)']);
    const filling = fill(target);
    clock = 2500;
    hud.renderTarget({ entity: { ...mira }, health: 0, effects: [], channel: undefined, raise: { ...raise } }, false);
    expect(fill(target)).toBe(filling);

    // At twice the pace, half done with 1.5 s left, the new fill starts half full.
    hud.renderTarget(
      {
        entity: mira,
        health: 0,
        effects: [],
        channel: undefined,
        raise: { progress: 0.5, seconds: 1.5, healerNames: ['Lumi', 'Bren'], atMs: 2500, endsAtMs: 4000 },
      },
      false,
    );
    expect(fill(target)).not.toBe(filling);
    expect(target.getAttribute('aria-label')).toBe('Being drawn back by Lumi and Bren');
    expect(timing(target)).toEqual(['1500ms', '0ms', 'linear(0.5000 0.00%, 1.0000 100.00%)']);
    hud.renderTarget({ entity: mira, health: 0, effects: [], channel: undefined, raise: undefined }, false);
    expect(target.classList.contains('hidden')).toBe(true);

    // The player lying fallen sees it under their own frame, and a raise is shown over a channel.
    const own = $('.hud-unit--self .hud-timed');
    const channel = { abilityId: 'deep-mend', startedAtMs: 1000, endsAtMs: 2500 } as const;
    hud.renderSelf({ ...HEALER, condition: 'fallen', channel, raise: { progress: 0, seconds: 6, healerNames: [], atMs: 2500, endsAtMs: 8500 } });
    expect(own.classList.contains('hidden')).toBe(false);
    expect(own.getAttribute('aria-label')).toBe('Being drawn back');
    expect(fill(own).classList.contains('hud-timed__fill--raise')).toBe(true);
    hud.renderSelf({ ...HEALER, condition: 'fallen' });
    expect(own.classList.contains('hidden')).toBe(true);
  });

  it("holds a raise's bar while a channel holds a Healer's pace back, and fills it on from there to where the next snapshot starts it", () => {
    const { hud, $ } = makeHUD();
    const mira = clientEntity({ id: 'peer-1', kind: 'peer', name: 'Mira', condition: 'fallen' });
    const target = $('.hud-unit--target .hud-timed');
    const easing = () => target.querySelector<HTMLElement>('.hud-timed__fill')!.style.animationTimingFunction;
    const show = (raise: { progress: number; seconds: number; pausedSeconds?: number[] }) =>
      hud.renderTarget(
        { entity: mira, health: 0, effects: [], channel: undefined, raise: { ...raise, healerNames: ['Lumi'], atMs: 0, endsAtMs: raise.seconds * 1000 } },
        false,
      );

    // A lone Healer channelling for 1.5 s of the 6 left: it holds a quarter done until the channel ends.
    show({ progress: 0.25, seconds: 6, pausedSeconds: [1.5] });
    expect(easing()).toBe('linear(0.2500 0.00%, 0.2500 25.00%, 1.0000 100.00%)');
    // Two, one channelling for a second: one pace until then, two after, so a sixth of the raise is done by then.
    show({ progress: 0.25, seconds: 2.75, pausedSeconds: [0, 1] });
    expect(easing()).toBe('linear(0.2500 0.00%, 0.4167 36.36%, 1.0000 100.00%)');
    // The snapshot as the channel ends starts the bar where it stood.
    show({ progress: 0.25 + 1 / 6, seconds: 1.75 });
    expect(easing()).toBe('linear(0.4167 0.00%, 1.0000 100.00%)');
  });

  it('names an elite target by its trait and its kind, and again once its trait changes', () => {
    const { hud, $ } = makeHUD();
    const ghost = clientEntity({ id: 'monster:1', kind: 'monster', name: 'Ghost', rank: 'elite', trait: 'stony' });
    hud.renderTarget({ entity: ghost, health: 1, effects: [], channel: undefined, raise: undefined }, false);
    expect($('.hud-unit--target .hud-unit__name').textContent).toBe('Stony Ghost');
    hud.renderTarget({ entity: { ...ghost, trait: 'shielded' }, health: 1, effects: [], channel: undefined, raise: undefined }, false);
    expect($('.hud-unit--target .hud-unit__name').textContent).toBe('Shielded Ghost');
  });

  it('frames the target with its name, its health, and a ✕ that clears it, and names its condition and the lock only to assistive tech', () => {
    const { hud, $, button, named } = makeHUD();
    const frame = $('.hud-unit--target');
    const ghost = clientEntity({ id: 'monster:1', kind: 'monster', name: 'Ghost', condition: 'wounded' });
    // Its portrait is drawn by the scene in the circle, and carries no sigil.
    expect(hud.portraits.target.parentElement).toBe(frame);
    expect(hud.portraits.target.childElementCount).toBe(0);

    hud.renderTarget({ entity: ghost, health: undefined, effects: [], channel: undefined, raise: undefined }, false);
    expect(frame.classList.contains('hidden')).toBe(false);
    expect(frame.textContent).toBe('TargetGhost');
    expect(frame.querySelector('.hud-unit__name')?.textContent).toBe('Ghost');
    expect(frame.getAttribute('style')).toBeNull();
    expect(frame.getAttribute('aria-label')).toBe('Target, wounded');
    expect(frame.querySelector<HTMLElement>('.hud-bar__fill')?.style.width).toBe('62.50%');
    const children = [...frame.querySelectorAll('*')];
    hud.renderTarget({ entity: ghost, health: 0.42, effects: [], channel: undefined, raise: undefined }, true);
    expect(frame.querySelector<HTMLElement>('.hud-bar__fill')?.style.width).toBe('42.00%');
    expect(frame.getAttribute('aria-label')).toBe('Target, wounded, facing locked');
    expect(frame.textContent).toBe('TargetGhost');
    hud.renderTarget({ entity: { ...ghost, condition: 'hurt' }, health: 0.3, effects: [], channel: undefined, raise: undefined }, false);
    expect(frame.getAttribute('aria-label')).toBe('Target, hurt');
    // A frame that swapped its elements under the pointer would lose a press on its ✕.
    expect([...frame.querySelectorAll('*')]).toEqual(children);
    hud.renderTarget(
      { entity: clientEntity({ id: 'peer-1', kind: 'peer', name: 'Mira' }), health: 1, effects: [], channel: undefined, raise: undefined },
      false,
    );
    expect(frame.querySelector('.hud-portrait')).toBe(hud.portraits.target);

    button('Clear target').click();
    expect(named('onClearTarget')).toEqual([[]]);
    hud.renderTarget(undefined, false);
    expect(frame.classList.contains('hidden')).toBe(true);
  });

  it('shows the world clock with the moon by night and the sun by day, and the place the player stands in', () => {
    const { hud, $ } = makeHUD();
    const day = 500 * 336 * 86400;
    const time = () => $('.hud-clock__time').textContent;

    hud.tick(clock, { worldSeconds: day + 22 * 3600 + 40 * 60 + 30, place: placeName('EdariaArena') });
    expect(time()).toBe('☾22:40');
    expect($('.hud-clock__place').textContent).toBe('Arena');
    hud.tick(clock, { worldSeconds: day + 14 * 3600 + 5 * 60, place: placeName('EdariaSquare') });
    expect(time()).toBe('☀14:05');
    expect($('.hud-clock__glyph').getAttribute('aria-hidden')).toBe('true');
    expect($('.hud-clock__place').textContent).toBe('Edaria Square');
    // The sun is up from 6 to 22, as the world's light has it.
    hud.tick(clock, { worldSeconds: day + 5 * 3600 + 59 * 60, place: undefined });
    expect(time()).toBe('☾05:59');
    hud.tick(clock, { worldSeconds: day + 6 * 3600, place: undefined });
    expect(time()).toBe('☀06:00');
  });

  it('opens the Players and Character windows from the menu, Players beside Character, lit while open, and closes each with the ✕ on its corner', () => {
    const { hud, $, button, named } = makeHUD();
    const players = $('.hud-window--players');
    const character = $('.hud-window--character');

    button('Players').click();
    button('Character').click();
    expect([players.classList.contains('hidden'), character.classList.contains('hidden')]).toEqual([false, false]);
    expect([button('Players').getAttribute('aria-pressed'), button('Character').getAttribute('aria-pressed')]).toEqual(['true', 'true']);
    expect([players.classList.contains('hud-window--beside'), character.classList.contains('hud-window--beside')]).toEqual([true, false]);
    // The newest on top.
    expect(Number(character.style.getPropertyValue('--hud-window-order'))).toBeGreaterThan(Number(players.style.getPropertyValue('--hud-window-order')));
    // The ✕ leaves the title alone in its row, as a chrome button of the panel's own.
    for (const window of [players, character]) {
      expect([...window.querySelector('.hud-window__head')!.children].map((node) => node.tagName)).toEqual(['H2']);
      expect(window.querySelector('.hud-window__close')!.parentElement).toBe(window);
      expect(window.querySelector('.hud-window__close')!.classList.contains('fantasy-button')).toBe(true);
    }

    button('Close Character').click();
    expect(character.classList.contains('hidden')).toBe(true);
    expect(players.classList.contains('hud-window--beside')).toBe(false);
    button('Players').click();
    expect(hud.isWindowOpen('players')).toBe(false);

    button('Settings').click();
    expect(named('onOpenSettings')).toEqual([[]]);
  });

  it("names the Character window and the Players window with their keys in the menu buttons' tips", () => {
    const { hud, button } = makeHUD();
    hover(button('Character'));
    expect([tipSays(hud.root), drawnGlyph(button('Character'))]).toEqual([['Character', 'C'], HUD_ICONS.character.image]);
    hover(button('Players'));
    expect([tipSays(hud.root), drawnGlyph(button('Players'))]).toEqual([['Players', 'O'], HUD_ICONS.players.image]);
  });

  it('closes the open chat first on Escape, then the newest window, then reports nothing left to close', () => {
    const { hud, button } = makeHUD();
    button('Players').click();
    button('Character').click();
    hud.openChat();

    expect(hud.escape()).toBe(true);
    expect([hud.chatOpen, hud.isWindowOpen('players'), hud.isWindowOpen('character')]).toEqual([false, true, true]);
    expect(hud.escape()).toBe(true);
    expect([hud.isWindowOpen('players'), hud.isWindowOpen('character')]).toEqual([true, false]);
    expect(hud.escape()).toBe(true);
    expect(hud.isWindowOpen('players')).toBe(false);
    expect(hud.escape()).toBe(false);
  });

  it('lists every dreamer by name, the press on one targeting them and on the own name the player, and marks the target', () => {
    const { hud, $, named } = makeHUD();
    const names = (): HTMLButtonElement[] => [...$('.hud-list--players').querySelectorAll<HTMLButtonElement>('button')];

    hud.renderPlayers(['Bren', '<b>Cara</b>', 'Tester'], { own: 'Tester', target: 'Bren' });
    expect(names().map((node) => [node.textContent, node.getAttribute('aria-pressed')])).toEqual([
      ['Bren', 'true'],
      ['<b>Cara</b>', 'false'],
      ['Tester', 'false'],
    ]);
    expect($('.hud-list--players').querySelector('b')).toBeNull();
    names()[0]!.click();
    names()[2]!.click();
    expect(named('onPressPlayer')).toEqual([['Bren']]);
    expect(named('onPressOwnFrame')).toEqual([[]]);
    expect($('.hud-window--players .hud-list__footer').textContent).toBe('Players: 3');
  });

  it('keeps every element of the belt, the frames, and the windows across energy frames and repaints that change nothing they show, the tip shown over a slot included', () => {
    const { hud, button } = makeHUD();
    const ghost = clientEntity({ id: 'monster:1', kind: 'monster', name: 'Ghost', condition: 'wounded' });
    const inventory = carrying({ coins: 5, worn: [item('cudgel')], bag: [item('cap')] });
    const history: ChatLine[] = [{ kind: 'joined', playerName: 'Bren' }];
    const paint = (balanceCurrent: number, health: number): void => {
      hud.renderPools({ ...POOLS, balanceCurrent }, false);
      hud.renderRun(false, false);
      hud.renderSlotOne(false, 'attack', false);
      // A sweep restarted on every frame would jump back to its start.
      hud.renderAbilities([{ ...ready('brace'), cooldown: { startedAtMs: 0, endsAtMs: 9000, global: false } }, ready('lunge')]);
      hud.renderLucidity({ role: 'healer', ranks: [{ teachingId: 'touch', rank: 2, practice: 20 }], study: 'touch' });
      hud.renderSelf({ ...HEALER, effects: [{ effectId: 'braced', endsAtMs: 5000 }] });
      hud.renderTarget({ entity: { ...ghost }, health, effects: [{ effectId: 'challenged', endsAtMs: 6000 }], channel: undefined, raise: undefined }, false);
      hud.renderPlayers(['Bren', 'Tester'], { own: 'Tester', target: undefined });
      hud.renderCharacter(inventory, FIGHTER);
      hud.renderChat(history);
      hud.tick(clock, NO_CLOCK);
    };
    paint(1, 0.5);
    // An item's open card is kept, so its button is pressed whatever frames arrive between press and release.
    pointerPress(hud.root.querySelector<HTMLButtonElement>('.hud-bag button')!, 'touch');
    // A tip shown over a slot is kept too, so a recovering pool does not make it flicker.
    hover(button('Lunge'));
    hud.tick(clock, NO_CLOCK);
    expect(tipSays(hud.root)?.[0]).toBe('Lunge');
    const before = [...hud.root.querySelectorAll('*')];

    for (const balanceCurrent of [2, 3, 4]) paint(balanceCurrent, 0.5);
    paint(4, 0.4);

    const after = [...hud.root.querySelectorAll('*')];
    expect(after).toHaveLength(before.length);
    after.forEach((node, index) => expect(node).toBe(before[index]));
  });

  it('lists what covers the play field for speech bubbles to keep clear of, open windows, an item card, and the chat while it shows included', () => {
    const { hud, $, button } = makeHUD();
    const covers = (selector: string) => hud.occluders.includes($(selector));
    expect(
      [
        '.hud-unit--self',
        '.hud-unit--self .hud-timed',
        '.hud-unit--target',
        '.hud-unit--target .hud-timed',
        '.hud-clock',
        '.hud-globe--health',
        '.hud-belt__panel',
        '.hud-globe--spirit',
        '.hud-menu',
        '.hud-chat',
      ].map(covers),
    ).toEqual(Array(10).fill(true));
    button('Players').click();
    expect([covers('.hud-window--players'), covers('.hud-item-card')]).toEqual([true, true]);
    hud.tick(clock + CHAT_IDLE_MS + 1, { worldSeconds: undefined, place: undefined });
    expect(covers('.hud-chat')).toBe(false);
  });

  it('reports hover as an aggregate, so sliding from one part to the next does not flicker', () => {
    const { $, named } = makeHUD();
    $('.hud-unit--self').dispatchEvent(new Event('pointerenter'));
    $('.hud-belt').dispatchEvent(new Event('pointerenter'));
    $('.hud-unit--self').dispatchEvent(new Event('pointerleave'));
    expect(named('onHoverChange')).toEqual([[true]]);
  });

  it('shrinks evenly to fit a window too narrow or too short for it, and keeps its size in one it fits', () => {
    const { hud } = makeHUD();
    const scaleAt = (width: number, height: number): string => {
      hud.setViewport(width, height);
      return hud.root.style.getPropertyValue('--hud-scale');
    };
    expect([scaleAt(1440, 900), scaleAt(1280, 720), scaleAt(900, 600), scaleAt(690, 404)]).toEqual(['1', '1', '1', '1']);
    // The top row decides across, and room for a window under it decides down.
    expect([scaleAt(640, 600), scaleAt(560, 600), scaleAt(560, 360), scaleAt(480, 330), scaleAt(1280, 380)]).toEqual(['0.923', '0.8', '0.8', '0.676', '0.908']);
  });

  it('names the globes Gestalt and Geist in German', () => {
    setLocale('de');
    const { hud } = makeHUD();
    expect([...hud.root.querySelectorAll('.hud-globe')].map((globe) => globe.getAttribute('aria-label'))).toEqual(['Gestalt', 'Geist']);
  });
});

describe('the Character window', () => {
  /** The place of a slot on the doll, or of the bag. */
  const slotPlace = (root: HTMLElement, slot: string): HTMLElement => root.querySelector<HTMLElement>(`[data-slot="${slot}"]`)!;
  const bagPlace = (root: HTMLElement, place: number): HTMLElement => root.querySelector<HTMLElement>(`[data-place="${place}"]`)!;
  const itemIn = (place: HTMLElement): HTMLButtonElement => place.querySelector<HTMLButtonElement>('button')!;
  /** What the refusal's line says, or `undefined` while none shows. */
  const refusal = (root: HTMLElement): string | undefined => {
    const notice = root.querySelector('.hud-notice');
    return notice === null || notice.classList.contains('hidden') ? undefined : (notice.textContent ?? undefined);
  };

  /** A pointer of the type taking the item in `from` and moving it over `over`, where `document.elementFromPoint` finds it. */
  function lift(from: Element, over: Element, pointerType = 'mouse'): void {
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(over);
    point(from, 'pointerdown', { pointerType, clientX: 10, clientY: 10 });
    point(document.body, 'pointermove', { pointerType, clientX: 40, clientY: 50 });
    point(document.body, 'pointermove', { pointerType, clientX: 60, clientY: 70 });
  }

  /** The same, let go over `onto`. */
  function carry(from: Element, onto: Element, pointerType = 'mouse'): void {
    lift(from, onto, pointerType);
    point(document.body, 'pointerup', { pointerType, clientX: 60, clientY: 70 });
    vi.restoreAllMocks();
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lays the doll on the bag's columns, armour down the first, the neck and rings down the last, the hands under the body, and the bag's items at their places", () => {
    const { hud, $, named } = makeHUD();
    const rare: ItemInstance = { ...item('cap'), rarity: 'rare', affixes: [{ affixId: 'health', value: 4 }] };
    hud.renderCharacter(
      {
        coins: 107,
        equipped: { head: rare, mainHand: item('cudgel'), ring1: item('ring') },
        bag: [
          { place: 5, item: { ...item('dagger'), rarity: 'magic' } },
          { place: 0, item: item('moonstone') },
        ],
      },
      FIGHTER,
    );
    expect($('.hud-purse').textContent).toBe('Your purse107c');
    const grid = (node: HTMLElement): string => `${node.style.gridColumn} ${node.style.gridRow}`;
    const slots = ['head', 'chest', 'hands', 'legs', 'feet', 'neck', 'ring1', 'ring2', 'mainHand', 'offHand'];
    expect(slots.map((slot) => grid(slotPlace(hud.root, slot)))).toEqual(['1 1', '1 2', '1 3', '1 4', '1 5', '8 1', '8 2', '8 3', '4 5', '5 5']);
    expect(grid(hud.portraits.body)).toBe('2 / 8 1 / 5');
    expect(slots.map((slot) => slotPlace(hud.root, slot).textContent)).toEqual(['', 'Chest', 'Hands', 'Legs', 'Feet', 'Neck', '', 'Ring', '', 'Off hand']);
    expect([itemIn(slotPlace(hud.root, 'head')).getAttribute('aria-label'), itemIn(slotPlace(hud.root, 'ring1')).getAttribute('aria-label')]).toEqual([
      'Head: Leather cap',
      'Ring 1: Iron ring',
    ]);
    expect([itemIn(slotPlace(hud.root, 'head')).className, drawnIcon(slotPlace(hud.root, 'head'))]).toEqual(['hud-item hud-rarity--rare', ITEM_ICONS.cap]);
    const cells = [...$('.hud-bag').children];
    expect(cells).toHaveLength(SOMNIO_PROTOCOL_CONSTANTS.maxBagItems);
    expect([0, 1, 5].map((place) => [cells[place]!.querySelector('button')?.getAttribute('aria-label'), drawnIcon(cells[place]!)])).toEqual([
      ['Moonstone', ITEM_ICONS.moonstone],
      [undefined, undefined],
      ['Dagger', ITEM_ICONS.dagger],
    ]);
    // Rarity colours are the loot markers' on the ground.
    expect(hud.root.style.getPropertyValue('--hud-rarity-magic')).toBe('#7f9bff');

    $('.hud-purse').dispatchEvent(new Event('dblclick'));
    $('.hud-purse').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(named('onTellPurse')).toEqual([[], []]);
  });

  it("gives a mouse Items and Stats tabs and a finger Gear, Items, and Stats, the finger's doll on a tab of its own", () => {
    for (const coarse of [false, true]) {
      const { hud, $ } = makeHUD(coarse);
      const tabs = [...$('.hud-window--character [role="tablist"]').children] as HTMLButtonElement[];
      const showing = () =>
        [...hud.root.querySelectorAll<HTMLElement>('.hud-page')]
          .filter((page) => !page.classList.contains('hidden'))
          .map((page) => page.getAttribute('aria-label'));
      expect(tabs.map((tab) => [tab.textContent, tab.getAttribute('aria-selected')])).toEqual(
        coarse
          ? [
              ['Gear', 'true'],
              ['Items', 'false'],
              ['Stats', 'false'],
            ]
          : [
              ['Items', 'true'],
              ['Stats', 'false'],
            ],
      );
      expect(showing()).toEqual([coarse ? 'Gear' : 'Items']);
      expect(hud.portraits.body.closest('.hud-page')?.getAttribute('aria-label')).toBe(coarse ? 'Gear' : 'Items');
      tabs.at(-1)!.click();
      expect([showing(), tabs.at(-1)!.getAttribute('aria-selected')]).toEqual([['Stats'], 'true']);
    }
  });

  it('totals what ranks and gear give, grouped, with where each comes from, and marks a total that changed since it was last shown', () => {
    const { hud, $ } = makeHUD();
    const sword: ItemInstance = {
      ...item('sword'),
      rarity: 'magic',
      affixes: [
        { affixId: 'damage', value: 2 },
        { affixId: 'swing-speed', value: 5 },
      ],
    };
    const fighter: LucidityMessage = {
      role: 'fighter',
      ranks: [
        { teachingId: 'toughening', rank: 2, practice: 0 },
        { teachingId: 'strike', rank: 1, practice: 0 },
        { teachingId: 'guard', rank: 1, practice: 0 },
        { teachingId: 'follow-through', rank: 1, practice: 0 },
      ],
    };
    const worn = carrying({ worn: [sword, item('shield'), item('cap')] });
    hud.renderCharacter(worn, fighter);
    $<HTMLButtonElement>('[data-tab="stats"]').click();
    const says = () =>
      [...hud.root.querySelectorAll('.hud-stats__group')].map((group) => [
        group.querySelector('.hud-stats__title')?.textContent,
        ...[...group.querySelectorAll('.hud-stat')].map((line) => [...line.children].map((part) => part.textContent).join(' | ')),
      ]);
    expect(says()).toEqual([
      ['Pools', 'Health | 120 | +20 ranks', 'Spirit | 100', 'Balance | 100'],
      [
        'Offence',
        'Damage a swing | 16 | Short sword: 11 · +3 ranks · +2 gear',
        'Time between swings | 0.85 s | +15% swing speed',
        'Balance a swing | 24',
        'Your swings land | 75%',
      ],
      ['Defence', 'Guard | 13 | +8 ranks · +5 gear', 'Ghost strikes land | 47% | 60% − 13% Guard', '...with no Balance left | 77%'],
      ['Recovery', 'Health a second | 0.5', 'Balance a second | 12', 'Spirit a second | 1'],
    ]);
    expect(hud.root.querySelectorAll('.hud-stat--changed')).toHaveLength(0);

    // Changed while the Items tab shows, marked once the Stats show again.
    $<HTMLButtonElement>('[data-tab="items"]').click();
    hud.renderCharacter(carrying({ worn: [sword, item('shield'), item('cap'), item('amulet')] }), fighter);
    $<HTMLButtonElement>('[data-tab="stats"]').click();
    expect([...hud.root.querySelectorAll('.hud-stat--changed')].map((line) => line.getAttribute('data-stat'))).toEqual(['health']);

    hud.renderCharacter(carrying(), { role: 'healer', ranks: [{ teachingId: 'depth', rank: 1, practice: 0 }] });
    expect(says().at(-1)).toEqual(['Mending', 'Health a mend | 15 | +5 ranks']);
    hud.renderCharacter(carrying(), { role: 'mystic', ranks: [] });
    expect(says().at(-1)).toEqual(['Warding', 'Ward strength | 100%']);
  });

  it("shows an item's tip with its icon on a mouse resting on it, with how a double click or a right click acts", () => {
    const { hud, button } = makeHUD();
    hud.renderCharacter(carrying({ worn: [item('cudgel')], bag: [item('wand')] }), FIGHTER);
    button('Character').click();
    hover(itemIn(bagPlace(hud.root, 0)));
    expect(tipSays(hud.root)).toEqual([
      'Wand',
      'Plain',
      'Off hand',
      'In the off hand, it lets a Mystic use their abilities.',
      'Right-click or double-click to equip.',
    ]);
    expect(drawnIcon(hud.root.querySelector('[role="tooltip"] .hud-tip__top'))).toBe(ITEM_ICONS.wand);
    hover(itemIn(slotPlace(hud.root, 'mainHand')));
    expect(tipSays(hud.root)?.at(-1)).toBe('Right-click or double-click to unequip.');
  });

  it("shows an item's tip on a finger's hold, without a click to act by", () => {
    vi.useFakeTimers();
    try {
      const { hud } = makeHUD(true);
      hud.renderCharacter(carrying({ bag: [item('wand')] }), FIGHTER);
      hud.openWindow('character');
      hud.root.querySelector<HTMLButtonElement>('[data-tab="items"]')!.click();
      point(itemIn(bagPlace(hud.root, 0)), 'pointerdown', { pointerType: 'touch' });
      vi.advanceTimersByTime(TIP_HOLD_MS);
      expect(tipSays(hud.root)).toEqual(['Wand', 'Plain', 'Off hand', 'In the off hand, it lets a Mystic use their abilities.']);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does nothing on a mouse's single click, and wears or puts away an item on its double click or right click, never on a finger's", () => {
    const { hud, named } = makeHUD();
    hud.renderCharacter(carrying({ worn: [item('cudgel')], bag: [item('moonstone'), item('ring')] }), FIGHTER);
    pointerPress(itemIn(bagPlace(hud.root, 0)));
    expect([named('onEquip'), cardSays(hud.root)]).toEqual([[], undefined]);

    doubleClick(itemIn(bagPlace(hud.root, 0)));
    point(itemIn(bagPlace(hud.root, 1)), 'pointerdown', { button: 2 });
    itemIn(bagPlace(hud.root, 1)).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    doubleClick(itemIn(slotPlace(hud.root, 'mainHand')));
    expect([named('onEquip'), named('onUnequip'), cardSays(hud.root)]).toEqual([[['moonstone-1'], ['ring-1']], [['mainHand']], undefined]);

    doubleClick(itemIn(bagPlace(hud.root, 0)), 'touch');
    point(itemIn(bagPlace(hud.root, 1)), 'pointerdown', { pointerType: 'touch' });
    itemIn(bagPlace(hud.root, 1)).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    expect(named('onEquip')).toHaveLength(2);
  });

  it("refuses a mouse's unequip into a full bag, saying why beside the slot, which shakes", () => {
    const { hud, named } = makeHUD();
    const bag = Array.from({ length: SOMNIO_PROTOCOL_CONSTANTS.maxBagItems }, (_, index) => item('cap', `cap-${index}`));
    hud.renderCharacter(carrying({ worn: [item('cudgel')], bag }), FIGHTER);
    doubleClick(itemIn(slotPlace(hud.root, 'mainHand')));
    expect([named('onUnequip'), refusal(hud.root), slotPlace(hud.root, 'mainHand').classList.contains('hud-place--shake')]).toEqual([
      [],
      'Your bag is full.',
      true,
    ]);
  });

  it("opens an item's card on a finger's tap, Drop and Equip on a carried item and Unequip on a worn one, each doing what it says", () => {
    const { hud, $, named } = makeHUD(true);
    const magic: ItemInstance = { ...item('sword'), rarity: 'magic', affixes: [{ affixId: 'damage', value: 2 }] };
    hud.renderCharacter(carrying({ worn: [item('cudgel')], bag: [magic, item('moonstone'), item('cap')] }), FIGHTER);
    const sword = itemIn(bagPlace(hud.root, 0));
    pointerPress(sword, 'touch');
    expect(cardSays(hud.root)).toEqual(['Short sword', 'Magic', 'Main hand', '11 damage, 24 balance a swing', '+2 damage', 'Drop', 'Equip']);
    expect([sword.getAttribute('aria-expanded'), $('.hud-item-card').getAttribute('aria-label')]).toEqual(['true', 'Short sword']);
    pointerPress($('.hud-item-card button:last-child'), 'touch');
    expect([named('onEquip'), cardSays(hud.root), sword.getAttribute('aria-expanded')]).toEqual([[['sword-1']], undefined, 'false']);

    // The Moonstone is never dropped, and a worn item is put away rather than dropped.
    pointerPress(itemIn(bagPlace(hud.root, 1)), 'touch');
    expect(cardSays(hud.root)?.slice(-2)).toEqual(['In the off hand, it lets a Healer mend and use their abilities.', 'Equip']);
    pointerPress(itemIn(slotPlace(hud.root, 'mainHand')), 'touch');
    expect(cardSays(hud.root)?.slice(-2)).toEqual(['8 damage, 18 balance a swing', 'Unequip']);
    pointerPress($('.hud-item-card button'), 'touch');
    pointerPress(itemIn(bagPlace(hud.root, 2)), 'touch');
    pointerPress($('.hud-item-card button'), 'touch');
    expect([named('onUnequip'), named('onDropItem')]).toEqual([[['mainHand']], [['cap-1']]]);
  });

  it("closes an item's card on a second tap on it, a press anywhere else, a scroll that moves the item, and a resize, and keeps it open on a press inside it", () => {
    const { hud, $ } = makeHUD(true);
    hud.renderCharacter(carrying({ bag: [item('cap'), item('boots')] }), FIGHTER);
    const [cap, boots] = [itemIn(bagPlace(hud.root, 0)), itemIn(bagPlace(hud.root, 1))];
    pointerPress(cap, 'touch');
    pointerPress(cap, 'touch');
    expect(cardSays(hud.root)).toBeUndefined();
    pointerPress(cap, 'touch');
    point($('.hud-item-card .hud-tip__title'), 'pointerdown', { pointerType: 'touch' });
    expect(cardSays(hud.root)?.[0]).toBe('Leather cap');
    pointerPress(boots, 'touch');
    expect(cardSays(hud.root)?.[0]).toBe('Leather boots');
    point(document.body, 'pointerdown', { pointerType: 'touch' });
    expect(cardSays(hud.root)).toBeUndefined();

    pointerPress(cap, 'touch');
    $('.hud-bag').dispatchEvent(new Event('scroll'));
    expect(cardSays(hud.root)).toBeUndefined();
    pointerPress(cap, 'touch');
    window.dispatchEvent(new Event('resize'));
    expect(cardSays(hud.root)).toBeUndefined();
  });

  it('opens a card from the keyboard with its button focused, and hands the keyboard back to the item when Escape closes it', () => {
    const { hud, $ } = makeHUD();
    hud.renderCharacter(carrying({ worn: [item('cudgel')] }), FIGHTER);
    const worn = itemIn(slotPlace(hud.root, 'mainHand'));
    worn.focus();
    worn.click();
    expect(document.activeElement).toBe($('.hud-item-card button'));
    expect(hud.escape()).toBe(true);
    expect([cardSays(hud.root), document.activeElement]).toEqual([undefined, worn]);
  });

  it("greys out a worn item's Unequip while the bag is full, says why, and gives it back once there is room", () => {
    const { hud, $, named } = makeHUD(true);
    const bag = Array.from({ length: SOMNIO_PROTOCOL_CONSTANTS.maxBagItems }, (_, index) => item('cap', `cap-${index}`));
    hud.renderCharacter(carrying({ worn: [item('cudgel')], bag }), FIGHTER);
    pointerPress(itemIn(slotPlace(hud.root, 'mainHand')), 'touch');
    expect(cardSays(hud.root)).toEqual(['Cudgel', 'Plain', 'Main hand', '8 damage, 18 balance a swing', 'Your bag is full.', 'Unequip']);
    expect($<HTMLButtonElement>('.hud-item-card button').disabled).toBe(true);

    hud.renderCharacter(carrying({ worn: [item('cudgel')], bag: bag.slice(1) }), FIGHTER);
    expect([cardSays(hud.root)?.at(-1), $<HTMLButtonElement>('.hud-item-card button').disabled]).toEqual(['Unequip', false]);
    pointerPress($('.hud-item-card button'), 'touch');
    expect(named('onUnequip')).toEqual([['mainHand']]);
  });

  it('keeps an open card on its item where the item now stands, and closes it once the item is gone', () => {
    const { hud } = makeHUD(true);
    hud.renderCharacter(carrying({ bag: [item('cap'), item('boots')] }), FIGHTER);
    pointerPress(itemIn(bagPlace(hud.root, 1)), 'touch');
    hud.renderCharacter({ coins: 0, equipped: {}, bag: [{ place: 7, item: item('boots') }] }, FIGHTER);
    expect([cardSays(hud.root)?.[0], itemIn(bagPlace(hud.root, 7)).getAttribute('aria-expanded')]).toEqual(['Leather boots', 'true']);
    hud.renderCharacter(carrying({ worn: [item('boots')] }), FIGHTER);
    expect([cardSays(hud.root)?.at(-1), itemIn(slotPlace(hud.root, 'feet')).getAttribute('aria-expanded')]).toEqual(['Unequip', 'true']);
    hud.renderCharacter(carrying(), FIGHTER);
    expect(cardSays(hud.root)).toBeUndefined();
  });

  it("closes an open item's card on Escape before the window, and with the window", () => {
    const { hud, button } = makeHUD(true);
    hud.renderCharacter(carrying({ bag: [item('cap')] }), FIGHTER);
    hud.openWindow('character');
    pointerPress(itemIn(bagPlace(hud.root, 0)), 'touch');
    expect(hud.escape()).toBe(true);
    expect([cardSays(hud.root), hud.isWindowOpen('character')]).toEqual([undefined, true]);
    pointerPress(itemIn(bagPlace(hud.root, 0)), 'touch');
    button('Close Character').click();
    expect(cardSays(hud.root)).toBeUndefined();
  });

  it('carries an item to another place of the bag, onto an occupied one too, with a ghost at a fixed offset from the pointer, and asks nothing for its own place', () => {
    const { hud, named } = makeHUD();
    hud.renderCharacter(carrying({ bag: [item('cap'), item('boots')] }), FIGHTER);
    lift(itemIn(bagPlace(hud.root, 0)), bagPlace(hud.root, 9));
    const ghost = hud.root.querySelector<HTMLElement>('.hud-ghost')!;
    expect([ghost.classList.contains('hidden'), ghost.style.transform, drawnIcon(ghost)]).toEqual([false, 'translate3d(50px, 60px, 0)', ITEM_ICONS.cap]);
    expect([itemIn(bagPlace(hud.root, 0)).classList.contains('hud-item--lifted'), bagPlace(hud.root, 9).classList.contains('hud-place--over')]).toEqual([
      true,
      true,
    ]);
    point(document.body, 'pointerup', { clientX: 60, clientY: 70 });
    vi.restoreAllMocks();
    expect([ghost.classList.contains('hidden'), hud.root.querySelectorAll('.hud-item--lifted, .hud-place--over')]).toEqual([
      true,
      expect.objectContaining({ length: 0 }),
    ]);

    carry(itemIn(bagPlace(hud.root, 0)), bagPlace(hud.root, 1));
    carry(itemIn(bagPlace(hud.root, 1)), bagPlace(hud.root, 1));
    expect(named('onMoveItem')).toEqual([
      ['cap-1', 9],
      ['cap-1', 1],
    ]);
  });

  it('carries an item into a slot its base fits, lighting both ring slots for a ring, and wears it in the slot it was let go on', () => {
    const { hud, named } = makeHUD();
    hud.renderCharacter(carrying({ worn: [item('ring', 'ring-0')], bag: [item('ring'), item('cap')] }), FIGHTER);
    lift(itemIn(bagPlace(hud.root, 0)), slotPlace(hud.root, 'ring2'));
    expect([...hud.root.querySelectorAll('.hud-place--fits')].map((node) => node.getAttribute('data-slot'))).toEqual(['ring1', 'ring2']);
    point(document.body, 'pointerup', { clientX: 60, clientY: 70 });
    vi.restoreAllMocks();
    // One ring slot to the other.
    carry(itemIn(slotPlace(hud.root, 'ring1')), slotPlace(hud.root, 'ring2'));
    carry(itemIn(bagPlace(hud.root, 1)), slotPlace(hud.root, 'head'));
    expect(named('onEquip')).toEqual([
      ['ring-1', 'ring2'],
      ['ring-0', 'ring2'],
      ['cap-1', 'head'],
    ]);
  });

  it('refuses a slot the base does not fit: the ghost says where it goes, and the slot shakes with the reason', () => {
    const { hud, named } = makeHUD();
    hud.renderCharacter(carrying({ bag: [item('trousers')] }), FIGHTER);
    lift(itemIn(bagPlace(hud.root, 0)), slotPlace(hud.root, 'feet'));
    const ghost = hud.root.querySelector<HTMLElement>('.hud-ghost')!;
    expect([
      ghost.classList.contains('hud-ghost--refuse'),
      ghost.querySelector('.hud-ghost__caption--refuse')?.textContent,
      slotPlace(hud.root, 'feet').className,
    ]).toEqual([true, 'Legs only', 'hud-place hud-place--slot hud-place--empty hud-place--refuse']);
    point(document.body, 'pointerup', { clientX: 60, clientY: 70 });
    expect([named('onEquip'), refusal(hud.root), slotPlace(hud.root, 'feet').classList.contains('hud-place--shake')]).toEqual([
      [],
      'Fits only the Legs slot.',
      true,
    ]);
  });

  it('puts a worn item away at the place it is let go on, and refuses a full bag where the item there does not fit its slot', () => {
    const { hud, named } = makeHUD();
    hud.renderCharacter(carrying({ worn: [item('cap')], bag: [item('boots')] }), FIGHTER);
    carry(itemIn(slotPlace(hud.root, 'head')), bagPlace(hud.root, 4));
    expect(named('onMoveItem')).toEqual([['cap-1', 4]]);

    const bag = Array.from({ length: SOMNIO_PROTOCOL_CONSTANTS.maxBagItems }, (_, index) => item(index === 3 ? 'cap' : 'boots', `piece-${index}`));
    hud.renderCharacter(carrying({ worn: [item('cap')], bag }), FIGHTER);
    carry(itemIn(slotPlace(hud.root, 'head')), bagPlace(hud.root, 5));
    expect([named('onMoveItem'), refusal(hud.root)]).toEqual([[['cap-1', 4]], 'Your bag is full.']);
    carry(itemIn(slotPlace(hud.root, 'head')), bagPlace(hud.root, 3));
    expect(named('onMoveItem')).toEqual([
      ['cap-1', 4],
      ['cap-1', 3],
    ]);
  });

  it("says on a worn item's ghost over a place that the full bag refuses it, marking the place refused, and refuses it there on letting go", () => {
    const { hud, named } = makeHUD();
    const bag = Array.from({ length: SOMNIO_PROTOCOL_CONSTANTS.maxBagItems }, (_, index) => item(index === 3 ? 'cap' : 'boots', `piece-${index}`));
    hud.renderCharacter(carrying({ worn: [item('cap')], bag }), FIGHTER);
    const ghost = hud.root.querySelector<HTMLElement>('.hud-ghost')!;
    const over = (): [boolean, string | null | undefined, boolean, boolean] => [
      ghost.classList.contains('hud-ghost--refuse'),
      ghost.querySelector('.hud-ghost__caption--refuse')?.textContent,
      bagPlace(hud.root, 5).classList.contains('hud-place--refuse'),
      bagPlace(hud.root, 5).classList.contains('hud-place--over'),
    ];
    lift(itemIn(slotPlace(hud.root, 'head')), bagPlace(hud.root, 5));
    expect(over()).toEqual([true, 'Bag full', true, false]);
    point(document.body, 'pointerup', { clientX: 60, clientY: 70 });
    vi.restoreAllMocks();
    expect([named('onMoveItem'), refusal(hud.root), bagPlace(hud.root, 5).classList.contains('hud-place--shake')]).toEqual([[], 'Your bag is full.', true]);

    // Over the place of a cap, which the head takes in its stead, the ghost refuses nothing.
    lift(itemIn(slotPlace(hud.root, 'head')), bagPlace(hud.root, 3));
    expect([ghost.classList.contains('hud-ghost--refuse'), bagPlace(hud.root, 3).className]).toEqual([false, 'hud-place hud-place--over']);
  });

  it('drops an item carried out onto the world toward where it is let go, a worn one too whatever room the bag has, saying Drop on the ghost, but keeps the Moonstone, its ghost saying it stays', () => {
    const { hud, named } = makeHUD();
    const letGo = { clientX: 60, clientY: 70 };
    const world = document.body.appendChild(document.createElement('canvas'));
    try {
      hud.renderCharacter(carrying({ worn: [item('cap')], bag: [item('boots'), item('moonstone')] }), FIGHTER);
      lift(itemIn(bagPlace(hud.root, 0)), world);
      const ghost = hud.root.querySelector<HTMLElement>('.hud-ghost')!;
      expect([ghost.classList.contains('hud-ghost--world'), ghost.classList.contains('hud-ghost--refuse')]).toEqual([true, false]);
      point(document.body, 'pointerup', { clientX: 60, clientY: 70 });
      vi.restoreAllMocks();
      carry(itemIn(slotPlace(hud.root, 'head')), world);
      // Over the world the Moonstone's ghost says it stays rather than Drop.
      lift(itemIn(bagPlace(hud.root, 1)), world);
      expect([
        ghost.classList.contains('hud-ghost--world'),
        ghost.classList.contains('hud-ghost--refuse'),
        ghost.querySelector('.hud-ghost__caption--refuse')?.textContent,
      ]).toEqual([false, true, 'Stays with you']);
      point(document.body, 'pointerup', { clientX: 60, clientY: 70 });
      vi.restoreAllMocks();
      expect([named('onDropItem'), refusal(hud.root)]).toEqual([
        [
          ['boots-1', letGo],
          ['cap-1', letGo],
        ],
        'This stays with you.',
      ]);

      const bag = Array.from({ length: SOMNIO_PROTOCOL_CONSTANTS.maxBagItems }, (_, index) => item('boots', `boots-${index}`));
      hud.renderCharacter(carrying({ worn: [item('cap')], bag }), FIGHTER);
      carry(itemIn(slotPlace(hud.root, 'head')), world);
      expect(named('onDropItem')).toEqual([
        ['boots-1', letGo],
        ['cap-1', letGo],
        ['cap-1', letGo],
      ]);
    } finally {
      world.remove();
    }
  });

  it("lets a finger's tap open the card while its drag carries the item, and opens a tab the item is held over", () => {
    vi.useFakeTimers();
    try {
      const { hud, named } = makeHUD(true);
      hud.renderCharacter(carrying({ bag: [item('cap')] }), FIGHTER);
      hud.openWindow('character');
      hud.root.querySelector<HTMLButtonElement>('[data-tab="items"]')!.click();
      const tab = hud.root.querySelector<HTMLButtonElement>('[data-tab="gear"]')!;
      lift(itemIn(bagPlace(hud.root, 0)), tab, 'touch');
      vi.advanceTimersByTime(TAB_SPRING_MS);
      expect(tab.getAttribute('aria-selected')).toBe('true');
      vi.spyOn(document, 'elementFromPoint').mockReturnValue(slotPlace(hud.root, 'head'));
      point(document.body, 'pointerup', { pointerType: 'touch', clientX: 60, clientY: 70 });
      // A drag lets go of no tap.
      itemIn(bagPlace(hud.root, 0)).dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
      expect([named('onEquip'), cardSays(hud.root)]).toEqual([[['cap-1', 'head']], undefined]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets go of an item carried on Escape, before the card and the window', () => {
    const { hud, named } = makeHUD();
    hud.renderCharacter(carrying({ bag: [item('cap')] }), FIGHTER);
    hud.openWindow('character');
    lift(itemIn(bagPlace(hud.root, 0)), bagPlace(hud.root, 4));
    expect(hud.escape()).toBe(true);
    point(document.body, 'pointerup', { clientX: 60, clientY: 70 });
    expect([named('onMoveItem'), hud.isWindowOpen('character'), hud.root.querySelector('.hud-ghost')!.classList.contains('hidden')]).toEqual([[], true, true]);
  });

  it('turns the body by a drag, in its view alone, holds it there a while, and then sways it slowly round that turn', () => {
    const { hud } = makeHUD();
    expect(hud.bodyTurn(clock)).toBe(0);
    point(hud.portraits.body, 'pointerdown', { clientX: 100 });
    point(document.body, 'pointermove', { clientX: 150 });
    expect(hud.bodyTurn(clock)).toBeCloseTo(0.6, 6);
    point(document.body, 'pointerup', { clientX: 150 });
    expect(hud.bodyTurn(clock + 3000)).toBeCloseTo(0.6, 6);
    // A quarter of the sway's period after the hold, it stands at the sway's far side.
    expect(hud.bodyTurn(clock + 3500 + 3500)).toBeCloseTo(0.6 + (40 * Math.PI) / 180, 6);
  });

  it("leaves the window's plate open over the body's rect, and closes it while the body is not shown", () => {
    const { hud, $ } = makeHUD();
    const window = $('.hud-window--character');
    const hole = () => ['left', 'top', 'width', 'height'].map((side) => window.style.getPropertyValue(`--hud-hole-${side}`));
    vi.spyOn(window, 'getBoundingClientRect').mockReturnValue(new DOMRect(900, 100, 388, 500));
    hud.openBodyHole(new DOMRect(964.4, 182, 256, 172));
    expect(hole()).toEqual(['64px', '82px', '256px', '172px']);
    hud.openBodyHole(new DOMRect(0, 0, 0, 0));
    expect(hole()).toEqual(['', '', '', '']);
  });
});

describe("a mouse's chat", () => {
  const lines = (count: number): ChatLine[] => Array.from({ length: count }, (_, index) => ({ kind: 'joined', playerName: `Dreamer${index}` }));

  it('fades its lines once nothing was said for a while, and brings them back with a new line and while the pointer rests on them', () => {
    const { hud, $ } = makeHUD();
    const pane = $('.hud-chat');
    const idle = () => pane.classList.contains('hud-chat--idle');
    hud.renderChat(lines(1));

    hud.tick(clock + CHAT_IDLE_MS - 1, { worldSeconds: undefined, place: undefined });
    expect(idle()).toBe(false);
    clock += CHAT_IDLE_MS + 1;
    hud.tick(clock, { worldSeconds: undefined, place: undefined });
    expect(idle()).toBe(true);

    hud.renderChat(lines(2));
    expect(idle()).toBe(false);

    clock += CHAT_IDLE_MS + 1;
    hud.tick(clock, { worldSeconds: undefined, place: undefined });
    const scrollback = $('.chat-scrollback');
    scrollback.getBoundingClientRect = () => new DOMRect(12, 560, 296, 140);
    hud.revealChatAt(600, 600);
    expect(idle()).toBe(true);
    hud.revealChatAt(100, 600);
    expect(idle()).toBe(false);
    pane.dispatchEvent(new Event('pointerenter'));
    clock += CHAT_IDLE_MS + 1;
    hud.tick(clock, { worldSeconds: undefined, place: undefined });
    expect(idle()).toBe(false);
  });

  it('opens with the field focused, sends a line on Enter and closes, and hands the keyboard back', () => {
    const { hud, $, named } = makeHUD();
    const field = hud.chatInput;
    expect(field.classList.contains('hidden')).toBe(true);

    hud.openChat();
    expect(hud.chatOpen).toBe(true);
    expect($('.hud-chat').classList.contains('hud-chat--open')).toBe(true);
    expect(field.classList.contains('hidden')).toBe(false);
    expect(document.activeElement).toBe(field);

    field.value = '/y hallo';
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(named('onSubmitChat')).toEqual([['/y hallo']]);
    expect([hud.chatOpen, field.value, document.activeElement === field]).toEqual([false, '', false]);
    expect(named('onChatFocusChange')).toEqual([[true], [false]]);
  });

  it('closes on Enter in an empty field, sending nothing', () => {
    const { hud, named } = makeHUD();
    hud.openChat();
    hud.chatInput.value = '   ';
    hud.chatInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(named('onSubmitChat')).toEqual([]);
    expect(hud.chatOpen).toBe(false);
  });

  it('swallows Shift-Enter rather than inserting a line break, keeping the field and its draft', () => {
    const { hud, named } = makeHUD();
    hud.openChat();
    hud.chatInput.value = 'zwei';
    const event = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true });
    hud.chatInput.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(named('onSubmitChat')).toEqual([]);
    expect([hud.chatOpen, hud.chatInput.value, document.activeElement === hud.chatInput]).toEqual([true, 'zwei', true]);
  });

  it('opens on a press at its lines, for a player with no keyboard at hand', () => {
    const { hud, $ } = makeHUD();
    $('.chat-scrollback').click();
    expect(hud.chatOpen).toBe(true);
  });

  it('inserts chat as text, never as markup, under the greeting, and keeps its lines across a render that brought none', () => {
    const { hud, $ } = makeHUD();
    const rows = (): Element[] => [...$('.chat-scrollback').querySelectorAll('.chat-line')];
    const history: ChatLine[] = [{ kind: 'spokenByPeer', senderName: '<img src=x onerror=alert(1)>', message: '<script>x</script>', speech: 'say' }];

    hud.renderChat(history);
    expect(hud.root.querySelector('img')).toBeNull();
    expect(hud.root.querySelector('script')).toBeNull();
    expect(rows()[0]?.textContent).toBe('Welcome to Somnio!');
    expect(rows()[1]?.textContent).toContain('<img src=x onerror=alert(1)>');
    const shown = rows();
    hud.renderChat(history);
    rows().forEach((row, index) => expect(row).toBe(shown[index]));
  });

  it('teaches the whisper and yell commands in the empty field', () => {
    const { hud } = makeHUD();
    expect(hud.chatInput.getAttribute('placeholder')).toBe('Talk here. /w to whisper, /y to yell');
  });
});

describe("a finger's HUD", () => {
  it('puts the frames in one strip at the top, with the clock and ≡ at its end, and the pools on the own frame', () => {
    const { hud, $ } = makeHUD(true);
    const strip = $('.hud-strip');
    expect([...strip.children].map((node) => node.className.split(' ').find((name) => name.startsWith('hud-')))).toEqual([
      'hud-unit',
      'hud-unit',
      'hud-strip__spacer',
      'hud-clock',
      'hud-sheet-toggle',
    ]);
    expect(hud.root.querySelector('.hud-globe')).toBeNull();
    hud.renderPools(POOLS, false);
    expect([...$('.hud-unit--self').querySelectorAll('.hud-bar')].map((bar) => bar.getAttribute('aria-label'))).toEqual(['Health 30/60', 'Spirit 5/10']);
    hud.renderSelf(HEALER);
    expect([hud.portraits.own.parentElement, hud.portraits.target.parentElement]).toEqual([$('.hud-unit--self'), $('.hud-unit--target')]);
    expect(drawnGlyph(hud.portraits.own.querySelector('.hud-sigil'))).toBe(PEOPLE_SIGILS.vigils.image);
    expect($('.hud-balance--bar .hud-bar__fill').style.width).toBe('25.00%');
  });

  it('keeps its size in a small window', () => {
    const { hud } = makeHUD(true);
    hud.setViewport(480, 330);
    expect(hud.root.style.getPropertyValue('--hud-scale')).toBe('');
  });

  it('puts slot 1 under the right thumb, slots 2 to 6 on an arc round it, and Run at its end', () => {
    const { hud, $ } = makeHUD(true);
    const thumb = $('.hud-thumb');
    const orbs = [...thumb.children] as HTMLElement[];
    expect(orbs.map((orb) => orb.className)).toEqual(['hud-orb hud-orb--act', ...Array(5).fill('hud-orb hud-orb--empty'), 'hud-orb hud-orb--run']);
    expect(orbs.slice(1, 6).map((orb) => orb.textContent)).toEqual(['2', '3', '4', '5', '6']);
    // Each orb on the arc lies the arc's radius from slot 1.
    const at = (orb: HTMLElement) => ({ x: Number.parseFloat(orb.style.left), y: Number.parseFloat(orb.style.top) });
    const act = at(orbs[0]!);
    for (const orb of orbs.slice(1, 6)) expect(Math.hypot(at(orb).x - act.x, at(orb).y - act.y)).toBeCloseTo(145, 3);
    expect($('.hud-orb--run').textContent).toBe('Run');
    hud.renderSlotOne(false, 'mend', false);
    expect(orbs[0]!.getAttribute('aria-label')).toBe('Mend');
    expect(hud.root.querySelector('.hud-menu')).toBeNull();
  });

  it("puts an ability's round button at its slot's place on the arc, among what covers the play field", () => {
    const { hud, $, button } = makeHUD(true);
    const empty = [...$('.hud-thumb').children][1] as HTMLElement;
    expect(hud.occluders).toContain(empty);

    hud.renderAbilities([ready('cleave')]);
    const orb = button('Cleave');
    expect([orb.className, orb.querySelector('.hud-slot__key')]).toEqual(['hud-orb hud-orb--ability', null]);
    expect([orb.style.left, orb.style.top]).toEqual([empty.style.left, empty.style.top]);
    expect(hud.occluders).toContain(orb);
    expect(hud.occluders).not.toContain(empty);
  });

  it('opens a sheet from ≡ with Players, Character, Settings, and the study line, and shows one window at a time in its place', () => {
    const { hud, $, button, named } = makeHUD(true);
    const sheet = $('.hud-sheet');
    hud.renderLucidity({ role: 'healer', ranks: [{ teachingId: 'touch', rank: 2, practice: 20 }], study: 'touch' });
    expect(sheet.classList.contains('hidden')).toBe(true);

    button('Menu').click();
    expect(sheet.classList.contains('hidden')).toBe(false);
    expect(button('Menu').getAttribute('aria-expanded')).toBe('true');
    expect([...sheet.querySelectorAll('button')].map((node) => node.textContent)).toEqual(['Players', 'Character', 'Settings']);
    expect(sheet.querySelector('.hud-study')?.textContent).toBe('Studying Touch · 40%');

    const press = (label: string) => [...sheet.querySelectorAll('button')].find((node) => node.textContent === label)!.click();
    press('Players');
    expect([sheet.classList.contains('hidden'), hud.isWindowOpen('players')]).toEqual([true, true]);
    button('Menu').click();
    press('Character');
    expect([hud.isWindowOpen('players'), hud.isWindowOpen('character')]).toEqual([false, true]);
    // The window covers the thumb, which would show through the plate's opening over the body.
    expect(hud.root.classList.contains('hud--character-open')).toBe(true);
    button('Menu').click();
    press('Settings');
    expect(named('onOpenSettings')).toEqual([[]]);
    expect(sheet.classList.contains('hidden')).toBe(true);
  });

  it('closes the sheet on Escape before the window under it', () => {
    const { hud, button } = makeHUD(true);
    hud.openWindow('players');
    button('Menu').click();
    expect(hud.escape()).toBe(true);
    expect([button('Menu').getAttribute('aria-expanded'), hud.isWindowOpen('players')]).toEqual(['false', true]);
    expect(hud.escape()).toBe(true);
    expect(hud.isWindowOpen('players')).toBe(false);
  });

  it('keeps the chat behind an icon, its newest lines peeking above it, and opens it as a panel with a ✕', () => {
    const { hud, $, button } = makeHUD(true);
    hud.renderChat([
      { kind: 'joined', playerName: 'A' },
      { kind: 'joined', playerName: 'B' },
      { kind: 'joined', playerName: 'C' },
    ]);
    expect([...$('.hud-chat-peek').children].map((line) => line.textContent)).toEqual(['A entered the game.', 'B entered the game.', 'C entered the game.']);
    const panel = $('.hud-chat');
    expect(panel.classList.contains('hidden')).toBe(true);

    button('Chat').click();
    expect([panel.classList.contains('hidden'), $('.hud-chat-peek').classList.contains('hidden'), document.activeElement === hud.chatInput]).toEqual([
      false,
      true,
      true,
    ]);
    button('Close Chat').click();
    expect([panel.classList.contains('hidden'), hud.chatOpen, document.activeElement === hud.chatInput]).toEqual([true, false, false]);

    clock += CHAT_IDLE_MS + 1;
    hud.tick(clock, { worldSeconds: undefined, place: undefined });
    expect($('.hud-chat-peek').classList.contains('hud-chat--idle')).toBe(true);
  });
});

describe("the HUD's tip", () => {
  it('shows at once over an ability: its name, key, cost in its pool, timing and reach at the rank held, what it teaches, and why it waits', () => {
    const { hud, button } = makeHUD();
    hud.renderAbilities([{ ...ready('deep-mend', 2), refusal: 'cost' }]);
    const slot = button('Deep mend');
    hover(slot.querySelector('.hud-glyph')!);

    const tip = hud.root.querySelector<HTMLElement>('[role="tooltip"]')!;
    expect(tipSays(hud.root)).toEqual([
      'Deep mend',
      '2',
      '18 Spirit',
      '1.35 s channel',
      '6 s cooldown',
      'The dreamer you target, up to 5 m away, or yourself',
      'Stand still and pour a deep mend into the dreamer you target, or into yourself. Moving breaks it off. Each rank mends more, and sooner.',
      'Not enough Spirit',
    ]);
    expect(tip.querySelector('.hud-tip__fact')?.className).toBe('hud-tip__fact hud-tip__fact--spirit');
    expect(slot.getAttribute('aria-describedby')).toBe(tip.id);

    // Waiting only on its own cooldown, it counts down to ready.
    hud.renderAbilities([{ ...ready('deep-mend', 2), cooldown: { startedAtMs: 0, endsAtMs: 4200, global: false } }]);
    hud.tick(clock, NO_CLOCK);
    expect(tipSays(hud.root)?.at(-1)).toBe('Ready in 4 s');
    clock = 2300;
    hud.tick(clock, NO_CLOCK);
    expect(tipSays(hud.root)?.at(-1)).toBe('Ready in 2 s');

    // A Fighter's ability spends Balance, lands at once, and names what it needs in hand.
    hud.renderAbilities([{ ...ready('cleave'), refusal: 'hand' }]);
    hover(button('Cleave'));
    expect(tipSays(hud.root)?.slice(2, 6)).toEqual(['16 Balance', 'Instant', '6 s cooldown', 'Nightmares in reach, in front of you']);
    expect(tipSays(hud.root)?.at(-1)).toBe('Needs a weapon or an empty main hand');
  });

  it("gives an area ability round dreamers its reach centre to centre, the rule's own number, and one round nightmares its reach beyond contact", () => {
    const { hud, button } = makeHUD();
    hud.renderAbilities([ready('radiance'), ready('veil'), ready('challenge')]);
    hover(button('Radiance'));
    expect(tipSays(hud.root)).toContain('You and dreamers up to 5 m around you');
    hover(button('Veil'));
    expect(tipSays(hud.root)).toContain('You and dreamers up to 5 m around you');
    hover(button('Challenge'));
    expect(tipSays(hud.root)).toContain('Nightmares up to 5 m around you');
  });

  it('names slot 1, Run, and an empty slot with their keys, and an effect with what it does and its seconds left', () => {
    const { hud, $, button } = makeHUD();
    hud.renderSlotOne(false, 'attack', false);
    hover($('.hud-slot--act'));
    expect(tipSays(hud.root)).toEqual(['Attack', '1']);
    hover(button('Run'));
    expect(tipSays(hud.root)).toEqual(['Run', 'Shift']);
    hover($('.hud-slot--empty'));
    expect(tipSays(hud.root)).toEqual(['Empty slot', '2', 'An ability you learn takes this slot.']);

    hud.renderSelf({ ...HEALER, effects: [{ effectId: 'renewing', endsAtMs: 9200 }] });
    hover($('.hud-effect__glyph'));
    expect(tipSays(hud.root)).toEqual(['Renewing', '9s', 'Mends a little every second.']);
    const tip = hud.root.querySelector('[role="tooltip"]');
    clock = 3200;
    hud.tick(clock, NO_CLOCK);
    expect(tipSays(hud.root)).toEqual(['Renewing', '6s', 'Mends a little every second.']);
    expect(hud.root.querySelector('[role="tooltip"]')).toBe(tip);
  });

  it('hides when the pointer leaves, presses, or scrolls, when its part goes, and when the HUD hides', () => {
    const { hud, $, button } = makeHUD();
    hud.renderAbilities([ready('brace')]);
    const slot = button('Brace');
    const glyph = slot.querySelector('.hud-glyph')!;

    hover(glyph);
    // Moving within the part keeps it.
    point(glyph, 'pointerout', { relatedTarget: slot });
    expect(tipSays(hud.root)?.[0]).toBe('Brace');
    point(slot, 'pointerout', { relatedTarget: $('.hud-slots') });
    expect(tipSays(hud.root)).toBeUndefined();
    expect(slot.hasAttribute('aria-describedby')).toBe(false);

    hover(slot);
    point(slot, 'pointerdown');
    expect(tipSays(hud.root)).toBeUndefined();

    hover(button('Run'));
    document.dispatchEvent(new Event('scroll'));
    expect(tipSays(hud.root)).toBeUndefined();

    hover(slot);
    hud.renderAbilities([ready('lunge')]);
    hud.tick(clock, NO_CLOCK);
    expect(tipSays(hud.root)).toBeUndefined();

    hover(button('Run'));
    hud.setShown(false);
    expect(tipSays(hud.root)).toBeUndefined();
  });

  it('shows nothing for a press held from the play field or for a finger passing over', () => {
    const { hud, button } = makeHUD();
    hover(button('Run'), { buttons: 1 });
    expect(tipSays(hud.root)).toBeUndefined();
    hover(button('Run'), { pointerType: 'touch' });
    expect(tipSays(hud.root)).toBeUndefined();
  });

  it("shows a finger's tip after a hold, without using what it holds, while a quick tap uses it as ever", () => {
    vi.useFakeTimers();
    try {
      const { hud, button, named } = makeHUD(true);
      hud.renderAbilities([ready('cleave')]);
      const orb = button('Cleave');
      const tap = (held: number): void => {
        point(orb, 'pointerdown', { pointerType: 'touch' });
        vi.advanceTimersByTime(held);
        point(orb, 'pointerup', { pointerType: 'touch' });
        orb.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
      };

      point(orb, 'pointerdown', { pointerType: 'touch' });
      vi.advanceTimersByTime(TIP_HOLD_MS);
      expect(tipSays(hud.root)?.[0]).toBe('Cleave');
      point(orb, 'pointerup', { pointerType: 'touch' });
      orb.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
      expect(tipSays(hud.root)).toBeUndefined();
      expect(named('onUseAbility')).toEqual([]);

      tap(TIP_HOLD_MS - 50);
      expect(tipSays(hud.root)).toBeUndefined();
      expect(named('onUseAbility')).toEqual([['cleave']]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets go of a finger's hold that slides past the tap slop, showing no tip, and the press is a press as ever", () => {
    vi.useFakeTimers();
    try {
      const { hud, button, named } = makeHUD(true);
      hud.renderAbilities([ready('cleave')]);
      const orb = button('Cleave');
      const press = (slide: number): void => {
        point(orb, 'pointerdown', { pointerType: 'touch', clientX: 100, clientY: 100 });
        point(orb, 'pointermove', { pointerType: 'touch', clientX: 100 + slide, clientY: 100 });
        vi.advanceTimersByTime(TIP_HOLD_MS);
      };
      const release = (): void => {
        point(orb, 'pointerup', { pointerType: 'touch' });
        orb.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
      };

      press(TAP_SLOP_PX);
      expect(tipSays(hud.root)?.[0]).toBe('Cleave');
      release();
      expect(named('onUseAbility')).toEqual([]);

      press(TAP_SLOP_PX + 1);
      expect(tipSays(hud.root)).toBeUndefined();
      release();
      expect(named('onUseAbility')).toEqual([['cleave']]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('takes the colours the world draws its effects in, on the HUD and on the sensed markers', () => {
    for (const root of [makeHUD().hud.root, new SensedMarkers().root]) {
      expect(['--hud-moonlight', '--hud-raise', '--hud-dream'].map((name) => root.style.getPropertyValue(name))).toEqual(['#d8e6ff', '#ffd27a', '#c4a8ff']);
    }
  });

  it('leaves no browser tooltip on any part of the HUD', () => {
    const { hud } = makeHUD();
    const ghost = clientEntity({ id: 'monster:1', kind: 'monster', name: 'Ghost' });
    hud.renderPools(POOLS, false);
    hud.renderSlotOne(false, 'attack', false);
    hud.renderAbilities([ready('brace')]);
    hud.renderSelf({ ...HEALER, effects: [{ effectId: 'braced', endsAtMs: 4200 }], channel: { abilityId: 'deep-mend', startedAtMs: 1000, endsAtMs: 2500 } });
    hud.renderTarget({ entity: ghost, health: 1, effects: [{ effectId: 'challenged' }], channel: undefined, raise: undefined }, false);
    expect(hud.root.querySelectorAll('[title]')).toHaveLength(0);
    expect(makeHUD(true).hud.root.querySelectorAll('[title]')).toHaveLength(0);
    const sensed = new SensedMarkers();
    const mira = { name: 'Mira', at: { x: 30, z: 10 }, centre: { x: 3, y: 0 }, toward: 0 };
    sensed.render({ halfSize: { x: 4, y: 3 }, markers: [mira] }, new DOMRect(0, 0, 800, 600), { x: 10, z: 10 });
    expect(sensed.root.querySelectorAll('.hud-sensed__marker')).toHaveLength(1);
    expect(sensed.root.querySelectorAll('[title]')).toHaveLength(0);
  });
});

describe('place names', () => {
  it('names every committed sector, and splits an unnamed one into words', () => {
    expect([...NAMED_PLACES].sort()).toEqual([...SECTOR_FIXTURE_NAMES].sort());
    expect(placeName('NorthWood')).toBe('North Wood');
    expect(placeName('MistyHollow2')).toBe('Misty Hollow2');
  });
});
