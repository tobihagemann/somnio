import { afterEach, describe, expect, it } from 'vitest';
import { GameHUD } from '@/ui/hud';
import { CHAT_IDLE_MS } from '@/ui/chatPane';
import { HUD_ICONS, PEOPLE_SIGILS } from '@/ui/hudIcons';
import { NAMED_PLACES, placeName } from '@/ui/placeNames';
import { catalogTables, setLocale } from '@/i18n';
import { SECTOR_FIXTURE_NAMES } from '../../core/test/support/sectorFixture.ts';
import type { Energy, InventoryRowMessage } from '@somnio/protocol';
import type { ChatLine } from '@/client';
import type { HUDCallbacks } from '@/ui/hud';
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
    onActivateItem: record('onActivateItem'),
    onToggleRun: record('onToggleRun'),
    onToggleEngage: record('onToggleEngage'),
    onPressPlayer: record('onPressPlayer'),
    onPressOwnFrame: record('onPressOwnFrame'),
    onClearTarget: record('onClearTarget'),
    onOpenSettings: record('onOpenSettings'),
    onHoverChange: record('onHoverChange'),
  };
  return { callbacks, calls, named: (name: keyof HUDCallbacks) => calls.filter(([called]) => called === name).map(([, ...args]) => args) };
}

/** The mask image of the glyph in `node`, which says which glyph it draws. */
function drawnGlyph(node: Element | null): string | undefined {
  return node?.querySelector<HTMLElement>('.hud-glyph')?.style.getPropertyValue('--hud-glyph');
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
const HEALER = { name: 'Smokewalker', people: 'vigils', role: 'healer', condition: 'hale', targeted: false } as const;

describe("a mouse's HUD", () => {
  it('lays out the frames, the clock, the belt with its six slots and Run, the menu, and the chat', () => {
    const { hud, $, button } = makeHUD();

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
    expect([...$('.hud-menu').querySelectorAll('button')].map((node) => node.getAttribute('aria-label'))).toEqual(['Players', 'Bag', 'Settings']);
    expect(button('Run').getAttribute('title')).toBe('Run (Shift)');
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
    expect(slot.title).toBe('Attack (1)');
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
    hud.renderRun(true);
    expect(named('onToggleEngage')).toHaveLength(1);
    expect(named('onToggleRun')).toHaveLength(1);
    expect(button('Run').getAttribute('aria-pressed')).toBe('true');
  });

  it('says what the player studies and how far toward the next rank, else the task they hold, else that they study nothing', () => {
    const { hud, $ } = makeHUD();
    const study = () => $('.hud-study');

    hud.renderLucidity({ role: 'healer', ranks: [{ teachingId: 'touch', rank: 2, practice: 20 }], study: 'touch' });
    expect(study().textContent).toBe('Studying Touch · 40%');
    expect(study().querySelector('b')?.textContent).toBe('Touch');
    hud.renderLucidity({ ranks: [], task: { role: 'fighter', progress: 0 } });
    expect(study().textContent).toBe('Task: 0 of 1');
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
    expect(frame.title).toBe('Target yourself');

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

  it('frames the target with its name, its health, and a ✕ that clears it, and names its condition and the lock only to assistive tech', () => {
    const { hud, $, button, named } = makeHUD();
    const frame = $('.hud-unit--target');
    const ghost = clientEntity({ id: 'monster:1', kind: 'monster', name: 'Ghost', condition: 'wounded' });
    // Its portrait is drawn by the scene in the circle, and carries no sigil.
    expect(hud.portraits.target.parentElement).toBe(frame);
    expect(hud.portraits.target.childElementCount).toBe(0);

    hud.renderTarget({ entity: ghost, health: undefined }, false);
    expect(frame.classList.contains('hidden')).toBe(false);
    expect(frame.textContent).toBe('TargetGhost');
    expect(frame.querySelector('.hud-unit__name')?.textContent).toBe('Ghost');
    expect(frame.getAttribute('style')).toBeNull();
    expect(frame.getAttribute('aria-label')).toBe('Target, wounded');
    expect(frame.querySelector<HTMLElement>('.hud-bar__fill')?.style.width).toBe('62.50%');
    const children = [...frame.querySelectorAll('*')];
    hud.renderTarget({ entity: ghost, health: 0.42 }, true);
    expect(frame.querySelector<HTMLElement>('.hud-bar__fill')?.style.width).toBe('42.00%');
    expect(frame.getAttribute('aria-label')).toBe('Target, wounded, facing locked');
    expect(frame.textContent).toBe('TargetGhost');
    hud.renderTarget({ entity: { ...ghost, condition: 'hurt' }, health: 0.3 }, false);
    expect(frame.getAttribute('aria-label')).toBe('Target, hurt');
    // A frame that swapped its elements under the pointer would lose a press on its ✕.
    expect([...frame.querySelectorAll('*')]).toEqual(children);
    hud.renderTarget({ entity: clientEntity({ id: 'peer-1', kind: 'peer', name: 'Mira' }), health: 1 }, false);
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

  it('opens the Players and Bag windows from the menu, side by side, lit while open, and closes each with its ✕', () => {
    const { hud, $, button, named } = makeHUD();
    const players = $('.hud-window--players');
    const bag = $('.hud-window--bag');

    button('Players').click();
    button('Bag').click();
    expect([players.classList.contains('hidden'), bag.classList.contains('hidden')]).toEqual([false, false]);
    expect([button('Players').getAttribute('aria-pressed'), button('Bag').getAttribute('aria-pressed')]).toEqual(['true', 'true']);
    expect(bag.classList.contains('hud-window--beside')).toBe(true);
    // The newest on top.
    expect(Number(bag.style.getPropertyValue('--hud-window-order'))).toBeGreaterThan(Number(players.style.getPropertyValue('--hud-window-order')));

    button('Close Players').click();
    expect(players.classList.contains('hidden')).toBe(true);
    expect(bag.classList.contains('hud-window--beside')).toBe(false);
    button('Bag').click();
    expect(bag.classList.contains('hidden')).toBe(true);
    expect(hud.isWindowOpen('bag')).toBe(false);

    button('Settings').click();
    expect(named('onOpenSettings')).toEqual([[]]);
  });

  it('closes the open chat first on Escape, then the newest window, then reports nothing left to close', () => {
    const { hud, button } = makeHUD();
    button('Players').click();
    button('Bag').click();
    hud.openChat();

    expect(hud.escape()).toBe(true);
    expect([hud.chatOpen, hud.isWindowOpen('players'), hud.isWindowOpen('bag')]).toEqual([false, true, true]);
    expect(hud.escape()).toBe(true);
    expect([hud.isWindowOpen('players'), hud.isWindowOpen('bag')]).toEqual([true, false]);
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

  it('carries what the player holds in the Bag, using a row on a double click and on Enter', () => {
    const { hud, $, named } = makeHUD();
    const rows: InventoryRowMessage[] = [
      { slot: 0, itemId: 'purse', quantity: 107 },
      { slot: 1, itemId: 'cudgel', quantity: 1, equippedHand: 'right' },
      { slot: 2, itemId: 'moonstone', quantity: 1, equippedHand: 'left' },
      { slot: 3, itemId: 'lantern', quantity: 1 },
    ];
    hud.renderItems(rows);
    const nodes = [...$('.hud-list--bag').querySelectorAll<HTMLElement>('.hud-list__row')];
    expect(nodes.map((node) => [node.querySelector('.hud-list__name')?.textContent, node.querySelector('.hud-list__marker')?.textContent])).toEqual([
      ['Purse', '107'],
      ['Cudgel', '[R]'],
      ['Moonstone', '[L]'],
      ['lantern', ''],
    ]);
    nodes[2]!.dispatchEvent(new Event('dblclick'));
    nodes[2]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(named('onActivateItem')).toEqual([[rows[2]], [rows[2]]]);
    expect($('.hud-window--bag .hud-list__footer').textContent).toBe('Items: 4');
  });

  it('keeps every element of the belt, the frames, and the windows across energy frames and repaints that change nothing they show', () => {
    const { hud } = makeHUD();
    const ghost = clientEntity({ id: 'monster:1', kind: 'monster', name: 'Ghost', condition: 'wounded' });
    const rows: InventoryRowMessage[] = [{ slot: 0, itemId: 'purse', quantity: 5 }];
    const history: ChatLine[] = [{ kind: 'joined', playerName: 'Bren' }];
    const paint = (balanceCurrent: number, health: number): void => {
      hud.renderPools({ ...POOLS, balanceCurrent }, false);
      hud.renderRun(false);
      hud.renderSlotOne(false, 'attack', false);
      hud.renderLucidity({ role: 'healer', ranks: [{ teachingId: 'touch', rank: 2, practice: 20 }], study: 'touch' });
      hud.renderSelf(HEALER);
      hud.renderTarget({ entity: { ...ghost }, health }, false);
      hud.renderPlayers(['Bren', 'Tester'], { own: 'Tester', target: undefined });
      hud.renderItems(rows);
      hud.renderChat(history);
    };
    paint(1, 0.5);
    const before = [...hud.root.querySelectorAll('*')];

    for (const balanceCurrent of [2, 3, 4]) paint(balanceCurrent, 0.5);
    paint(4, 0.4);

    const after = [...hud.root.querySelectorAll('*')];
    expect(after).toHaveLength(before.length);
    after.forEach((node, index) => expect(node).toBe(before[index]));
  });

  it('lists what covers the play field for speech bubbles to keep clear of, open windows and the chat while it shows included', () => {
    const { hud, $, button } = makeHUD();
    const covers = (selector: string) => hud.occluders.includes($(selector));
    expect(
      ['.hud-unit--self', '.hud-unit--target', '.hud-clock', '.hud-globe--health', '.hud-belt__panel', '.hud-globe--spirit', '.hud-menu', '.hud-chat'].map(
        covers,
      ),
    ).toEqual(Array(8).fill(true));
    button('Players').click();
    expect(covers('.hud-window--players')).toBe(true);
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

  it('opens a sheet from ≡ with Players, Bag, Settings, and the study line, and shows one window at a time in its place', () => {
    const { hud, $, button, named } = makeHUD(true);
    const sheet = $('.hud-sheet');
    hud.renderLucidity({ role: 'healer', ranks: [{ teachingId: 'touch', rank: 2, practice: 20 }], study: 'touch' });
    expect(sheet.classList.contains('hidden')).toBe(true);

    button('Menu').click();
    expect(sheet.classList.contains('hidden')).toBe(false);
    expect(button('Menu').getAttribute('aria-expanded')).toBe('true');
    expect([...sheet.querySelectorAll('button')].map((node) => node.textContent)).toEqual(['Players', 'Bag', 'Settings']);
    expect(sheet.querySelector('.hud-study')?.textContent).toBe('Studying Touch · 40%');

    const press = (label: string) => [...sheet.querySelectorAll('button')].find((node) => node.textContent === label)!.click();
    press('Players');
    expect([sheet.classList.contains('hidden'), hud.isWindowOpen('players')]).toEqual([true, true]);
    button('Menu').click();
    press('Bag');
    expect([hud.isWindowOpen('players'), hud.isWindowOpen('bag')]).toEqual([false, true]);
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

describe('place names', () => {
  it('names every committed sector, and splits an unnamed one into words', () => {
    expect([...NAMED_PLACES].sort()).toEqual([...SECTOR_FIXTURE_NAMES].sort());
    expect(placeName('NorthWood')).toBe('North Wood');
    expect(placeName('MistyHollow2')).toBe('Misty Hollow2');
  });
});
