import type { AbilityId, EffectId, People } from '@somnio/core';
import { element } from './dom';

/**
 * The HUD's glyphs, white silhouettes in the weight of Kenney's CC0 icons. Most are those icons, in
 * the asset pack's `UI/`, where `Scripts/bundle-web-assets.sh` names each one. Where Kenney has
 * nothing that fits (the chat, the Moonstone, Cleave, and the peoples' sigils) one is drawn here on a
 * 24-unit grid instead. Each is a CSS mask (`.hud-glyph` in `hud.css`), so it takes the ink of the
 * control it sits on.
 */
export interface HUDGlyph {
  /** The mask image, a CSS `url()`. */
  image: string;
  /** The mask's size in its box, which evens out how much of its square each source draws in. */
  size: string;
}

/** Kenney's "Game Icons" draw in the middle 64% of their square, "Board Game Icons" and the glyphs drawn here in about 84%. */
const GAME_ICONS_SIZE = '130%';

function packed(url: string, size = '100%'): HUDGlyph {
  return { image: `url('${url}')`, size };
}

/** A glyph drawn here: SVG shapes in white, filled even-odd so a shape inside another cuts a hole. */
function drawn(shapes: string): HUDGlyph {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#fff" fill-rule="evenodd" stroke="#fff" stroke-width="0" stroke-linecap="round" stroke-linejoin="round">${shapes}</svg>`;
  return { image: `url("data:image/svg+xml,${encodeURIComponent(svg)}")`, size: '100%' };
}

/** A line drawn at the weight of a Kenney icon's strokes. */
function line(path: string, width = 2.8): string {
  return `<path d="${path}" fill="none" stroke-width="${width}"/>`;
}

export const HUD_ICONS = {
  /** A speech balloon with its tail on the lower left and three dots cut out. */
  chat: drawn(
    '<path d="M5 3h14a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3h-8l-4.6 3.8a.6.6 0 0 1-1-.46V18H5a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3zM9.1 10.5a1.6 1.6 0 1 1-3.2 0 1.6 1.6 0 1 1 3.2 0zM13.6 10.5a1.6 1.6 0 1 1-3.2 0 1.6 1.6 0 1 1 3.2 0zM18.1 10.5a1.6 1.6 0 1 1-3.2 0 1.6 1.6 0 1 1 3.2 0z"/>',
  ),
  players: packed('/assets/UI/icon-players.png', GAME_ICONS_SIZE),
  bag: packed('/assets/UI/icon-bag.png'),
  settings: packed('/assets/UI/icon-settings.png', GAME_ICONS_SIZE),
  menu: packed('/assets/UI/icon-menu.png', GAME_ICONS_SIZE),
  close: packed('/assets/UI/icon-close.png', GAME_ICONS_SIZE),
  run: packed('/assets/UI/icon-run.png', GAME_ICONS_SIZE),
  attack: packed('/assets/UI/icon-sword.png'),
  /** The Moonstone: a smooth stone with a crescent cut into it. */
  mend: drawn('<path d="M12 2c5.8 0 9 4.6 9 10.4C21 18 17.2 22 12 22s-9-4-9-9.6C3 6.6 6.2 2 12 2zM10.95 8.4A4.8 4.8 0 1 0 15.48 14.93 4 4 0 0 1 10.95 8.4z"/>'),
  /** A figure drawn back up off the ground. */
  raise: packed('/assets/UI/icon-raise.png'),
  /** Two blade sweeps, one over the other, across everything in front. */
  cleave: drawn('<path d="M1.5 15Q12-5 22.5 15 12 4 1.5 15zM5.5 20Q12 7 18.5 20 12 13 5.5 20z"/>'),
  challenge: packed('/assets/UI/icon-challenge.png', GAME_ICONS_SIZE),
  brace: packed('/assets/UI/icon-brace.png'),
  lunge: packed('/assets/UI/icon-lunge.png'),
  rally: packed('/assets/UI/icon-rally.png'),
} as const satisfies Record<string, HUDGlyph>;

/** Each ability's glyph on its belt slot. */
export const ABILITY_GLYPHS: Record<AbilityId, HUDGlyph> = {
  cleave: HUD_ICONS.cleave,
  challenge: HUD_ICONS.challenge,
  brace: HUD_ICONS.brace,
  lunge: HUD_ICONS.lunge,
  rally: HUD_ICONS.rally,
};

/** Each effect's glyph on the unit frames: the glyph of the ability that puts it on its holder. */
export const EFFECT_GLYPHS: Record<EffectId, HUDGlyph> = {
  braced: HUD_ICONS.brace,
  challenged: HUD_ICONS.challenge,
};

/** Each people's sigil on the player's own frame: the Waking's open eye, the Deep's closed one, the Shadow's crescent, and the Light's sun. */
export const PEOPLE_SIGILS: Record<People, HUDGlyph> = {
  vigils: drawn(
    '<path d="M1.5 12C4.6 6.9 8.1 4.5 12 4.5s7.4 2.4 10.5 7.5c-3.1 5.1-6.6 7.5-10.5 7.5S4.6 17.1 1.5 12zM16.6 12a4.6 4.6 0 1 1-9.2 0 4.6 4.6 0 1 1 9.2 0zM14.2 12a2.2 2.2 0 1 1-4.4 0 2.2 2.2 0 1 1 4.4 0z"/>',
  ),
  sopors: drawn(line('M2.5 8.5C6 13.5 9 15 12 15s6-1.5 9.5-6.5', 3.2) + line('M5.6 13 4 15.8M9.3 15.2 8.6 18.4M14.7 15.2l.7 3.2M18.4 13l1.6 2.8', 2.6)),
  umbrae: drawn('<path d="M20.5 15.2A9 9 0 1 1 8.8 3.5a10 10 0 0 0 11.7 11.7z"/>'),
  lumina: drawn(
    '<path d="M16.8 12a4.8 4.8 0 1 1-9.6 0 4.8 4.8 0 1 1 9.6 0z"/>' +
      line('M19.6 12H22M17.37 17.37l1.7 1.7M12 19.6V22M6.63 17.37l-1.7 1.7M4.4 12H2M6.63 6.63l-1.7-1.7M12 4.4V2M17.37 6.63l1.7-1.7', 2.6),
  ),
};

/** A glyph as an element, decorative by construction: the accessible name lives on the control. */
export function glyph(art: HUDGlyph): HTMLElement {
  const node = element('span', { className: 'fantasy-icon hud-glyph', attributes: { 'aria-hidden': 'true' } });
  showGlyph(node, art);
  return node;
}

/** Draws another glyph in an element `glyph` made, in place. */
export function showGlyph(node: HTMLElement, art: HUDGlyph): void {
  node.style.setProperty('--hud-glyph', art.image);
  node.style.setProperty('--hud-glyph-size', art.size);
}
