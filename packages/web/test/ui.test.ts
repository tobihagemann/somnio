import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { WEB_ROOT } from './helpers/paths';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppShell, FallenNotice, GamePanels, Overlays, ServicePanel, detectDesktop, element, field } from '@/ui';
import { catalogTables, setLocale } from '@/i18n';
import { mouseFacingHeading } from '@/client';
import type { RegistrationForm } from '@/client';
import { fullPools, headingRadians } from '@somnio/core';
import { SOMNIO_PROTOCOL_CONSTANTS, decodeSomnioMessage, encodeSomnioMessage } from '@somnio/protocol';
import type { InventoryRowMessage, LucidityMessage, NPCService, SomnioMessage } from '@somnio/protocol';
import { fakeSocketFactory } from './helpers/fakeSocket';
import type { FakeSocket } from './helpers/fakeSocket';
import { outdoorSector } from '../../core/test/support/worldFixture.ts';
import { clientEntity, enterSpaceFrame, entityFrame, sectorFrame } from './helpers/worldFixture';
import type { ChatLine } from '@/client';

/**
 * The DOM layer, against `happy-dom`.
 *
 * WebGL is unavailable here, which is convenient rather than limiting: it exercises the same
 * no-WebGL path a real browser with a blocklisted driver takes, and everything the shell does that
 * is *not* rendering — the overlays, the panels, the host handlers, the notices — is fully driven.
 */

const chromePath = resolve(WEB_ROOT, 'src/ui/chrome.css');

function noopCallbacks(): ConstructorParameters<typeof GamePanels>[0] {
  return {
    onSubmitChat: () => {},
    onChatFocusChange: () => {},
    onActivateItem: () => {},
    onFloatingHoverChange: () => {},
  };
}

function overlayCallbacks(): ConstructorParameters<typeof Overlays>[0] {
  return {
    onLogin: () => {},
    onRegister: () => {},
    onShowOverlay: () => {},
    onResume: () => {},
    onDismissOverlay: () => {},
    onCancelRegistration: () => {},
    onLeaveGame: () => {},
    onRetryConnection: () => {},
    onToggleFullscreen: () => {},
    appVersion: '1.2.3',
  };
}

describe('panel chrome metrics', () => {
  const css = readFileSync(chromePath, 'utf8');

  it('slices the border image at 36 image pixels', () => {
    // The chrome's cap inset is 18 *points* against an already-halved image. A literal 18 here
    // slices at half the intended depth and cuts through the corner
    // ornaments — the single easiest thing to get wrong in this file.
    expect(css).toContain('border-image-slice: 36');
    expect(css).not.toMatch(/border-image-slice:\s*18\b/);
  });

  it('draws the border 18 CSS pixels wide', () => {
    expect(css).toContain('--somnio-cap-inset: 18px');
    expect(css).toContain('border-image-width: var(--somnio-cap-inset)');
  });

  it('reproduces the plate inset and content padding', () => {
    expect(css).toContain('--somnio-plate-inset: 3px');
    expect(css).toContain('--somnio-content-padding: 20px');
  });

  it('uses the four semantic texture stems', () => {
    for (const stem of ['panel-primary', 'panel-button', 'panel-button-hover', 'divider']) {
      expect(css).toContain(`/assets/UI/${stem}.png`);
    }
  });

  it('slices the title flanks so only their middle band stretches', () => {
    const flank = /\.overlay-title::before,\s*\.overlay-title::after\s*\{([^}]*)\}/.exec(css)?.[1];
    expect(flank).toBeDefined();
    // Doubled from `.resizable(capInsets: leading 12, trailing 24)` for the same halved-image
    // reason as the panel border, plus `fill` so the stretchable middle is painted at all.
    expect(flank).toContain('border-image-slice: 0 48 0 24 fill');
    expect(flank).toContain('border-image-width: 0 24px 0 12px');
    // The sheet is 192x44. Scaling it whole into the flank's box squashes the end ornament and
    // the line weight together, which reads as a cramped smudge rather than a broken layout.
    expect(flank).toContain('height: 22px');
    // Anchored to a declaration: the rule's own comment names the mistake it is guarding against.
    expect(flank).not.toMatch(/^\s*background-size:/m);
  });

  it('mirrors the trailing flank so both ornaments face the title', () => {
    // `FantasyFlankedLabel` is [.trailing, label, .leading], and the sheet authors its ornament on
    // the trailing end — so the *right* flank is the mirrored one. Flipping the left one instead
    // turns both ornaments outward, which still renders and still looks deliberate.
    expect(css).toMatch(/\.overlay-title::after\s*\{[^}]*scaleX\(-1\)/);
    expect(css).not.toMatch(/\.overlay-title::before\s*\{[^}]*scaleX\(-1\)/);
  });

  it('lays the chat panel out as a fixed-width column with a gap', () => {
    const panel = /\n\.chat-panel\s*\{([^}]*)\}/.exec(css)?.[1];
    expect(panel).toBeDefined();
    expect(panel).toContain('width: 380px');
    // Without the gap the scrollback's 3px line margin is the only thing between the history and
    // the input.
    expect(panel).toContain('gap: 8px');

    const field = /\.chat-panel \.fantasy-field\s*\{([^}]*)\}/.exec(css)?.[1];
    // The designed text area is 44px: a 52px field box, 6px of chrome padding around it, and 4px
    // of container inset taken off the inside. A 52px box instead leaves 38px of text — a whole
    // row less, which makes the field look shallow.
    expect(field).toContain('height: 64px');
    expect(field).toContain('padding: 9px');
    // 44 / 16 is exactly 2.75 rows; `line-height: normal` is ~15.6 and drifts off that count.
    expect(field).toContain('line-height: 16px');
  });

  it('draws the standalone rule without the ornamented sheet', () => {
    const divider = /\n\.fantasy-divider\s*\{([^}]*)\}/.exec(css)?.[1];
    expect(divider).toBeDefined();
    // `FantasyDivider` is two plain rules with a 3pt gap. Borrowing `divider.png` hangs a
    // half-cut end ornament off every standalone rule in the app.
    expect(divider).not.toContain('divider.png');
    expect(divider).toContain('background-size: 100% 1.5px');
  });
});

describe('the four floating panels', () => {
  it('renders HUD, chat, players, and items', () => {
    const panels = new GamePanels(noopCallbacks(), catalogTables, 'en');

    expect(panels.root.querySelectorAll('.floating')).toHaveLength(4);
    expect(panels.root.querySelector('.chat-scrollback')).not.toBeNull();
    expect(panels.root.querySelector('.trailing-list--players')).not.toBeNull();
    expect(panels.root.querySelector('.trailing-list--items')).not.toBeNull();
    expect(panels.root.querySelectorAll('.hud-bar__track')).toHaveLength(3);
  });

  /** A bar is a bare track: its name is carried by `title` and `aria-label`, never drawn. */
  it('names the energy bars without rendering text beside them', () => {
    const panels = new GamePanels(noopCallbacks(), catalogTables, 'en');

    const tracks = [...panels.root.querySelectorAll('.hud-bar__track')];
    expect(tracks.map((node) => node.getAttribute('aria-label'))).toEqual(['Health', 'Balance', 'Spirit']);
    for (const track of tracks) expect(track.textContent).toBe('');

    panels.renderEnergy(
      {
        healthCurrent: 30,
        healthMax: 60,
        balanceCurrent: 1,
        balanceMax: 2,
        spiritCurrent: 5,
        spiritMax: 5,
      },
      false,
    );
    expect(tracks[0]?.getAttribute('aria-label')).toBe('Health 30/60');
    expect(tracks[0]?.getAttribute('title')).toBe('Health 30/60');
    // Each pool reads its own pair: three distinct readings, so a swapped pair cannot pass.
    expect(tracks.map((node) => node.getAttribute('title'))).toEqual(['Health 30/60', 'Balance 1/2', 'Spirit 5/5']);
  });

  /** The canon names of the three pools, which are not translations of the English ones. */
  it('names the energy bars Gestalt, Gleichgewicht, and Geist in German', () => {
    setLocale('de');
    try {
      const panels = new GamePanels(noopCallbacks(), catalogTables, 'de');
      const tracks = [...panels.root.querySelectorAll('.hud-bar__track')];
      expect(tracks.map((node) => node.getAttribute('aria-label'))).toEqual(['Gestalt', 'Gleichgewicht', 'Geist']);
    } finally {
      setLocale('en');
    }
  });

  /**
   * The panel toggles render a glyph with the text only as a tooltip, so the label has to be
   * carried out-of-band or the accessible name is lost with the visible text.
   */
  it('renders the three panel toggles as named icon buttons', () => {
    const panels = new GamePanels(noopCallbacks(), catalogTables, 'en');

    const toggles = [...panels.root.querySelectorAll('.fantasy-button--compact')];
    expect(toggles.map((node) => node.getAttribute('aria-label'))).toEqual(['Chat', 'Players', 'Items']);
    for (const toggle of toggles) {
      expect(toggle.textContent).toBe('');
      expect(toggle.querySelector('svg.fantasy-icon path')?.getAttribute('d')).toBeTruthy();
      expect(toggle.getAttribute('title')).toBe(toggle.getAttribute('aria-label'));
    }
  });

  it('toggles its panel body on click', () => {
    const panels = new GamePanels(noopCallbacks(), catalogTables, 'en');
    const chatBody = panels.root.querySelector('.chat-panel') as HTMLElement;
    // Scoped to the button: the scrollback and the chat input carry the same accessible name.
    const toggle = panels.root.querySelector('button[aria-label="Chat"]') as HTMLButtonElement;

    expect(chatBody.classList.contains('hidden')).toBe(false);
    toggle.click();
    expect(chatBody.classList.contains('hidden')).toBe(true);
    toggle.click();
    expect(chatBody.classList.contains('hidden')).toBe(false);
  });

  it('scales each energy bar by its own maximum', () => {
    const panels = new GamePanels(noopCallbacks(), catalogTables, 'en');

    panels.renderEnergy(
      {
        healthCurrent: 50,
        healthMax: 100,
        balanceCurrent: 3,
        balanceMax: 4,
        spiritCurrent: 0,
        spiritMax: 10,
      },
      false,
    );

    const widths = [...panels.root.querySelectorAll('.hud-bar__fill')].map((node) => (node as HTMLElement).style.width);
    // Pixels against the 148px span, not a percentage of the 150px track: a percentage runs the
    // full bar one pixel past the track's trailing seam.
    expect(widths).toEqual(['74px', '111px', '0px']);
  });

  it('collapses a bar whose maximum arrives as zero instead of rendering NaN', () => {
    const panels = new GamePanels(noopCallbacks(), catalogTables, 'en');

    panels.renderEnergy(
      {
        healthCurrent: 5,
        healthMax: 0,
        balanceCurrent: 0,
        balanceMax: 1,
        spiritCurrent: 0,
        spiritMax: 1,
      },
      false,
    );

    const first = panels.root.querySelector('.hud-bar__fill') as HTMLElement;
    expect(first.style.width).toBe('0px');
  });

  it('inserts chat as text, never as markup', () => {
    const panels = new GamePanels(noopCallbacks(), catalogTables, 'en');
    const hostile: ChatLine[] = [{ kind: 'spokenByPeer', senderName: '<img src=x onerror=alert(1)>', message: '<script>x</script>', speech: 'say' }];

    panels.renderChat(hostile);

    // The last row, not the first: the scrollback synthesizes the startup greeting ahead of the
    // delivered lines.
    const rows = panels.root.querySelectorAll('.chat-line');
    const row = rows[rows.length - 1];
    // Peer names and chat text are attacker-chosen, and a stored session token makes an injected
    // script materially worse than a defaced panel.
    expect(panels.root.querySelector('img')).toBeNull();
    expect(panels.root.querySelector('script')).toBeNull();
    expect(row?.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  /** The shell renders on every `energy` frame, and replacing the lines takes a reader's text selection with them. */
  it('keeps the chat lines across a render that brought none, and replaces them when one arrived', () => {
    const panels = new GamePanels(noopCallbacks(), catalogTables, 'en');
    const rows = (): Element[] => [...panels.root.querySelectorAll('.chat-line')];
    const history: ChatLine[] = [{ kind: 'joined', playerName: 'Saibot' }];

    panels.renderChat(history);
    const shown = rows();
    panels.renderChat(history);
    expect(rows()).toEqual(shown);
    expect(rows()[0]).toBe(shown[0]);

    history.push({ kind: 'joined', playerName: 'Bren' });
    panels.renderChat(history);
    expect(rows().map((row) => row.textContent)).toEqual(['Welcome to Somnio!', 'Saibot entered the game.', 'Bren entered the game.']);

    // At its cap the history keeps its length while its oldest line gives way to the newest.
    history.shift();
    history.push({ kind: 'left', playerName: 'Saibot' });
    panels.renderChat(history);
    expect(rows().map((row) => row.textContent)).toEqual(['Welcome to Somnio!', 'Bren entered the game.', 'Saibot left the game.']);
  });

  /**
   * The chat panel always opens with this line, prepended at render time rather than stored.
   * Synthesized at render time, so the scrollback cap can never trim it away.
   */
  it('always opens the scrollback with the startup greeting', () => {
    const panels = new GamePanels(noopCallbacks(), catalogTables, 'en');

    panels.renderChat([]);
    expect(panels.root.querySelector('.chat-line')?.textContent).toBe('Welcome to Somnio!');

    panels.renderChat([{ kind: 'joined', playerName: 'Saibot' }]);
    const rows = panels.root.querySelectorAll('.chat-line');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toBe('Welcome to Somnio!');
  });

  it('inserts a player name as text, never as markup', () => {
    const panels = new GamePanels(noopCallbacks(), catalogTables, 'en');

    panels.renderPlayers(['<b>bold</b>']);

    const row = panels.root.querySelector('.trailing-list--players .list-row');
    expect(row?.querySelector('b')).toBeNull();
    expect(row?.textContent).toBe('<b>bold</b>');
  });

  it('labels inventory rows from the item table, counts the purse, and marks the equipped one', () => {
    const panels = new GamePanels(noopCallbacks(), catalogTables, 'en');
    const rows: InventoryRowMessage[] = [
      { slot: 0, itemId: 'purse', quantity: 107 },
      { slot: 1, itemId: 'cudgel', quantity: 1, equippedHand: 'right' },
      { slot: 2, itemId: 'cudgel', quantity: 1, equippedHand: 'left' },
      { slot: 3, itemId: 'cudgel', quantity: 1 },
    ];

    panels.renderItems(rows);

    const rowNodes = [...panels.root.querySelectorAll('.trailing-list--items .list-row')];
    expect(rowNodes.map((node) => node.querySelector('.list-row__name')?.textContent)).toEqual(['Purse', 'Cudgel', 'Cudgel', 'Cudgel']);
    // The purse shows its coins; an equipped row marks the hand rather than restyling the row, and
    // the player never picks one.
    expect(rowNodes.map((node) => node.querySelector('.list-row__marker')?.textContent)).toEqual(['107', '[R]', '[L]', '']);
  });

  /** A blank row tells an operator nothing; the raw id names the item the table is missing. */
  it('renders the raw id of an item the item table does not know', () => {
    const panels = new GamePanels(noopCallbacks(), catalogTables, 'en');

    panels.renderItems([{ slot: 0, itemId: 'lantern', quantity: 1 }]);

    expect(panels.root.querySelector('.trailing-list--items .list-row__name')?.textContent).toBe('lantern');
  });

  it('hands the activated row to the callback on a double click and on Enter', () => {
    const activated: InventoryRowMessage[] = [];
    const panels = new GamePanels({ ...noopCallbacks(), onActivateItem: (row) => activated.push(row) }, catalogTables, 'en');
    const purse = { slot: 0, itemId: 'purse', quantity: 7 };
    panels.renderItems([purse]);
    const node = panels.root.querySelector('.trailing-list--items .list-row') as HTMLElement;

    node.dispatchEvent(new Event('dblclick'));
    node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));

    expect(activated).toEqual([purse, purse]);
  });

  /** The shell renders on every `energy` frame, and a row replaced between two clicks never sees the double click. */
  it('keeps its rows across a render of the same inventory, and replaces them for a new one', () => {
    const panels = new GamePanels(noopCallbacks(), catalogTables, 'en');
    const rows = [{ slot: 0, itemId: 'mondstein', quantity: 1 }];
    const row = (): Element | null => panels.root.querySelector('.trailing-list--items .list-row');

    panels.renderItems(rows);
    const first = row();
    panels.renderItems(rows);
    expect(row()).toBe(first);

    panels.renderItems([{ slot: 0, itemId: 'mondstein', quantity: 1, equippedHand: 'right' }]);
    expect(row()).not.toBe(first);
    expect(row()?.querySelector('.list-row__marker')?.textContent).toBe('[R]');
  });

  /** Both trailing lists carry a count footer. */
  it('renders the Players and Items count footers', () => {
    const panels = new GamePanels(noopCallbacks(), catalogTables, 'en');

    panels.renderPlayers(['Greta', 'Tobi']);
    panels.renderItems([
      { slot: 0, itemId: 'purse', quantity: 0 },
      { slot: 1, itemId: 'cudgel', quantity: 1, equippedHand: 'left' },
      { slot: 2, itemId: 'lantern', quantity: 1 },
    ]);

    const footers = [...panels.root.querySelectorAll('.list-footer')].map((node) => node.textContent);
    expect(footers).toEqual(['Players: 2', 'Items: 3']);
  });

  /** The rule between scrollback and input has no counterpart in `chatPanel`. */
  it('puts no divider between the scrollback and the chat input', () => {
    const panels = new GamePanels(noopCallbacks(), catalogTables, 'en');
    expect(panels.root.querySelector('.chat-panel .fantasy-divider')).toBeNull();
  });

  /**
   * `ReturnSubmittingTextView` calls `makeFirstResponder(nil)` after `onSubmit`, and the blank case
   * takes the same path — the blur sits outside the guard. Without it the gameplay gate stays closed
   * on `isChatInputFocused` and WASD is dead after every line the player sends.
   */
  it.each([
    { label: 'a sent line', text: 'hallo', submits: ['hallo'] },
    { label: 'a blank line', text: '   ', submits: [] },
  ])('hands the keyboard back after Enter on $label', ({ text, submits }) => {
    const submitted: string[] = [];
    const focusEvents: boolean[] = [];
    const panels = new GamePanels(
      {
        ...noopCallbacks(),
        onSubmitChat: (line) => submitted.push(line),
        onChatFocusChange: (focused) => focusEvents.push(focused),
      },
      catalogTables,
      'en',
    );
    // `blur()` only fires the event when the element actually holds focus, so it has to be in the
    // document and focused first — a detached element would pass this vacuously.
    document.body.append(panels.root);
    panels.chatInput.focus();
    panels.chatInput.value = text;

    panels.chatInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    expect(submitted).toEqual(submits);
    expect(panels.chatInput.value).toBe('');
    expect(focusEvents).toEqual([true, false]);
    expect(document.activeElement).not.toBe(panels.chatInput);
    panels.root.remove();
  });

  it('swallows Shift-Enter rather than inserting a line break', () => {
    const submitted: string[] = [];
    const panels = new GamePanels({ ...noopCallbacks(), onSubmitChat: (text) => submitted.push(text) }, catalogTables, 'en');
    document.body.append(panels.root);
    panels.chatInput.focus();
    panels.chatInput.value = 'zwei';

    panels.chatInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));

    expect(submitted).toEqual([]);
    // Focus is kept — the player is still composing — but the keystroke inserts nothing, because a
    // newline reaches no renderer: the bubble wrap tokenizes on spaces and canvas text drops it.
    expect(document.activeElement).toBe(panels.chatInput);
    expect(panels.chatInput.value).toBe('zwei');
    panels.root.remove();
  });

  it('teaches the whisper and yell commands in the empty chat field', () => {
    const panels = new GamePanels(noopCallbacks(), catalogTables, 'en');
    const placeholder = panels.chatInput.getAttribute('placeholder') ?? '';
    expect(placeholder).toContain('/w');
    expect(placeholder).toContain('/y');
  });

  it('reports chat focus so the caller can close the gameplay gate', () => {
    const focusEvents: boolean[] = [];
    const panels = new GamePanels({ ...noopCallbacks(), onChatFocusChange: (focused) => focusEvents.push(focused) }, catalogTables, 'en');

    panels.chatInput.dispatchEvent(new FocusEvent('focus'));
    panels.chatInput.dispatchEvent(new FocusEvent('blur'));

    expect(focusEvents).toEqual([true, false]);
  });

  it('reports hover as an aggregate, so sliding between panels does not flicker', () => {
    const hovers: boolean[] = [];
    const panels = new GamePanels({ ...noopCallbacks(), onFloatingHoverChange: (hovering) => hovers.push(hovering) }, catalogTables, 'en');
    const [first, second] = [...panels.root.querySelectorAll('.floating')];

    // Enter the second before leaving the first — the reorder a real cursor produces.
    first?.dispatchEvent(new Event('pointerenter'));
    second?.dispatchEvent(new Event('pointerenter'));
    first?.dispatchEvent(new Event('pointerleave'));

    expect(hovers).toEqual([true]);
  });
});

describe('overlays', () => {
  it('presents exactly one overlay at a time', () => {
    const overlays = new Overlays(overlayCallbacks());

    overlays.present({ kind: 'gameMenu' });

    const visible = [...overlays.root.querySelectorAll('.overlay-scrim')].filter((node) => !node.classList.contains('hidden'));
    expect(visible).toHaveLength(1);
  });

  it('hides every overlay when none is presented', () => {
    const overlays = new Overlays(overlayCallbacks());
    overlays.present({ kind: 'login' });

    overlays.present(undefined);

    const visible = [...overlays.root.querySelectorAll('.overlay-scrim')].filter((node) => !node.classList.contains('hidden'));
    expect(visible).toHaveLength(0);
  });

  it('uses a real password input with autocomplete tokens', () => {
    const overlays = new Overlays(overlayCallbacks());

    const password = overlays.root.querySelector('input[type="password"]');
    // The whole reason the login form is DOM rather than drawn in WebGL: a password manager has to
    // be able to recognize and fill it.
    expect(password).not.toBeNull();
    expect(password?.getAttribute('autocomplete')).toBe('current-password');
    expect(overlays.loginNickname.getAttribute('autocomplete')).toBe('username');
  });

  /**
   * The login form's validation branches, as a table — the shape the registration form already had
   * and this one did not. That asymmetry is what let the empty-password branch go missing: three
   * one-off tests covered the nickname twice and the password not at all, so `submitLogin` capped
   * the password from above only and a blank one shipped a `login` frame the server answered
   * `badCredentials`. The player then read "Bad credentials." about a password they never typed.
   *
   * `onLogin` not firing is the assertion that matters; the visible error is what distinguishes a
   * refusal from a silent no-op.
   */
  it.each([
    ['an empty nickname', { nickname: '', password: 'hunter22' }],
    // 24 four-byte emoji is 96 UTF-8 bytes but only 48 UTF-16 code units, so a `.length` check
    // against the 64-byte identifier cap would wave it through and the server would refuse it.
    ['a nickname past the byte cap', { nickname: '\u{1F600}'.repeat(24), password: 'hunter22' }],
    ['a nickname that is only whitespace', { nickname: '   ', password: 'hunter22' }],
    ['an empty password', { nickname: 'Tester', password: '' }],
    ['a password past the byte cap', { nickname: 'Tester', password: '\u{1F600}'.repeat(64) }],
  ])('refuses to open a connection with %s', (_label, { nickname, password }) => {
    let attempts = 0;
    const overlays = new Overlays({ ...overlayCallbacks(), onLogin: () => (attempts += 1) });
    overlays.present({ kind: 'login' });
    overlays.loginNickname.value = nickname;
    (overlays.root.querySelector('input[type="password"]') as HTMLInputElement).value = password;

    overlays.root.querySelector('form')?.dispatchEvent(new Event('submit', { cancelable: true }));

    expect(attempts).toBe(0);
    expect(overlays.root.querySelector('.form-error')?.classList.contains('hidden')).toBe(false);
  });

  it('passes a valid login through with the remember-me flag', () => {
    const logins: { nickname: string; rememberMe: boolean }[] = [];
    const overlays = new Overlays({
      ...overlayCallbacks(),
      onLogin: (credentials) => logins.push(credentials),
    });
    overlays.present({ kind: 'login' });
    overlays.loginNickname.value = 'Tester';
    const password = overlays.root.querySelector('input[type="password"]') as HTMLInputElement;
    password.value = 'hunter22';
    const remember = overlays.root.querySelector('input[type="checkbox"]') as HTMLInputElement;
    remember.checked = true;

    overlays.root.querySelector('form')?.dispatchEvent(new Event('submit', { cancelable: true }));

    expect(logins).toEqual([{ nickname: 'Tester', password: 'hunter22', rememberMe: true }]);
  });

  it('words the version-skew message differently in each direction', () => {
    const overlays = new Overlays(overlayCallbacks());

    overlays.present({ kind: 'updateRequired', skew: 'clientOutdated' });
    const outdatedClient = overlays.root.textContent ?? '';
    overlays.present({ kind: 'updateRequired', skew: 'serverOutdated' });
    const outdatedServer = overlays.root.textContent ?? '';

    // Each direction against its own sentence, not merely against the other: asserting only that
    // the two differ holds with the arms swapped, which tells a player on an old client to wait for
    // a deploy that already finished, and a player mid-rollout to go and find an update that does
    // not exist. Those are the two wrong answers this branch exists to avoid.
    expect(outdatedClient).toContain('update your client');
    expect(outdatedServer).toContain('server is being updated');
    expect(outdatedClient).not.toContain('server is being updated');
    expect(outdatedServer).not.toContain('update your client');
  });

  it('offers no auto-update path', () => {
    const overlays = new Overlays(overlayCallbacks());

    // A browser client updates by reloading; a "Check for Updates..." button would do nothing.
    expect(overlays.root.textContent).not.toContain('Check for Updates');
  });

  it('names the titleless dialogs without giving them a visible heading', () => {
    const overlays = new Overlays(overlayCallbacks());

    // Registration and the credits are the two panels built with no title. The accessible name has
    // to survive anyway, because a DOM dialog has no window to borrow one from.
    for (const name of ['Sign Up', 'About Somnio']) {
      const dialog = overlays.root.querySelector(`[aria-label="${name}"]`);
      expect(dialog, name).not.toBeNull();
      expect(dialog?.querySelector(':scope > .overlay-title')?.textContent ?? '').not.toBe(name);
    }
  });

  it('credits the asset packs in world-build order under the credits heading', () => {
    const overlays = new Overlays(overlayCallbacks());
    const about = overlays.root.querySelector('[aria-label="About Somnio"]');

    expect(about?.querySelector('.overlay-title--large')?.textContent).toBe('Somnio');
    expect([...(about?.querySelectorAll('.about-credits p') ?? [])].map((node) => node.textContent)).toEqual([
      '3D characters and props by KayKit.',
      'Ghost model by Quaternius.',
      'Floor textures by ambientCG.',
      'UI borders by Kenney.',
    ]);
  });

  it('carries the revival blurb resolved out of the catalog', () => {
    const overlays = new Overlays(overlayCallbacks());

    const blurb = overlays.root.querySelector('.about-blurb')?.textContent ?? '';
    // Asserting on the years rather than a sentence: they are the same in both catalog locales, so
    // this fails on a missing key (which renders as the bare key) without pinning the prose.
    expect(blurb).toContain('2003');
    expect(blurb).not.toBe('Thanks paragraph');
  });
});

describe('field helpers', () => {
  it('associates the label with its input', () => {
    const { row, input } = field('Nickname');

    const label = row.querySelector('label');
    expect(label?.getAttribute('for')).toBe(input.id);
    expect(input.id.length).toBeGreaterThan(0);
  });

  /**
   * Slugifying drops punctuation, so the registration form's "Password:" and "Password (*):"
   * collapse to the same slug. Sharing an id points both labels at the first input and leaves the
   * repeat field with no accessible name and no password-manager association at all.
   */
  it('gives labels that slugify identically their own ids', () => {
    const first = field('Password:');
    const second = field('Password (*):');

    expect(first.input.id).not.toBe(second.input.id);
    expect(first.row.querySelector('label')?.getAttribute('for')).toBe(first.input.id);
    expect(second.row.querySelector('label')?.getAttribute('for')).toBe(second.input.id);
  });
});

describe('the app shell in a host that cannot render', () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = element('div');
    document.body.append(container);
  });

  afterEach(() => {
    container.remove();
  });

  it('shows the WebGL notice and never a blank canvas', () => {
    new AppShell({ container, capabilities: { hasWebGL: false, isDesktop: true } });

    const notice = container.querySelector('.blocking-notice:not(.hidden)');
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toContain('WebGL');
  });

  it('shows the desktop-only notice at a handheld viewport', () => {
    new AppShell({ container, capabilities: { hasWebGL: true, isDesktop: false } });

    const notice = container.querySelector('.blocking-notice:not(.hidden)');
    expect(notice?.textContent).toContain('keyboard');
  });

  it('prefers the mobile notice over the WebGL one when both apply', () => {
    // A phone with no WebGL is still first and foremost the wrong device; telling the player to try
    // a different browser would be advice they cannot act on.
    new AppShell({ container, capabilities: { hasWebGL: false, isDesktop: false } });

    const visible = [...container.querySelectorAll('.blocking-notice:not(.hidden)')];
    expect(visible).toHaveLength(1);
    expect(visible[0]?.textContent).toContain('keyboard');
  });

  it('builds no scene when the host cannot render one', () => {
    const shell = new AppShell({ container, capabilities: { hasWebGL: false, isDesktop: true } });

    // The controller falls back to the no-op surface, so nothing downstream has to null-check.
    expect(shell.scene).toBeUndefined();
    expect(shell.controller.connectionState).toBe('disconnected');
  });
});

/**
 * Driven from the socket rather than from the controller, because that is where the gap was: the
 * controller re-presented the login overlay correctly on a rejected password and the DOM never
 * heard about it, so `presentedOverlay` assertions passed while the dialog stayed shut.
 */
describe('the login overlay across an authentication attempt', () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = element('div');
    document.body.append(container);
  });

  afterEach(() => {
    container.remove();
  });

  function loginShell(): { shell: AppShell; socket: () => FakeSocket; dialogVisible: () => boolean } {
    const { factory, latest } = fakeSocketFactory();
    const shell = new AppShell({
      container,
      capabilities: { hasWebGL: true, isDesktop: true },
      startRendering: false,
      socketFactory: factory,
    });
    const dialogVisible = () => {
      const scrim = container.querySelector('[aria-label="Somnio"]')?.closest('.overlay-scrim');
      return scrim !== null && scrim !== undefined && !scrim.classList.contains('hidden');
    };
    return { shell, socket: latest, dialogVisible };
  }

  function submitLogin(shell: AppShell, container: HTMLElement): void {
    shell.overlays.loginNickname.value = 'Tester';
    const password = container.querySelector('input[type="password"]') as HTMLInputElement;
    password.value = 'hunter22';
    container.querySelector('form')?.dispatchEvent(new Event('submit', { cancelable: true }));
  }

  it('keeps the dialog up while the login is still in flight', () => {
    const { shell, socket, dialogVisible } = loginShell();
    expect(dialogVisible()).toBe(true);

    submitLogin(shell, container);
    socket().open();
    socket().deliverText(
      encodeSomnioMessage({
        tag: 'hello',
        payload: { protocolVersion: SOMNIO_PROTOCOL_CONSTANTS.helloVersion },
      }),
    );

    // `submitLogin` does not touch the overlay; dismissing on submit leaves a rejected password
    // with nothing on screen to return to.
    expect(shell.controller.connectionState).toBe('awaitingLoginResult');
    expect(dialogVisible()).toBe(true);
  });

  it('leaves the dialog open when the server rejects the credentials', () => {
    const { shell, socket, dialogVisible } = loginShell();
    submitLogin(shell, container);
    socket().open();
    socket().deliverText(
      encodeSomnioMessage({
        tag: 'hello',
        payload: { protocolVersion: SOMNIO_PROTOCOL_CONSTANTS.helloVersion },
      }),
    );

    socket().deliverText(encodeSomnioMessage({ tag: 'loginResult', payload: { result: 'badCredentials' } }));

    expect(dialogVisible()).toBe(true);
    expect(shell.controller.connectionState).toBe('disconnected');
    // The reason goes to the chat scrollback rather than inline in the form — the
    // registration overlay is the only one that carries its error in the panel. So the scrollback
    // has to be *readable* behind the overlay, which is why the panels are not gated on the
    // connection: with the socket torn down, a state-gated panel would hide the explanation.
    const scrollback = container.querySelector('.chat-scrollback');
    expect(scrollback?.textContent ?? '').not.toBe('');
    expect(scrollback?.closest('.floating')?.classList.contains('hidden')).toBe(false);
    expect(shell.panels.root.classList.contains('hidden')).toBe(false);
  });

  it('replaces the dialog with the version notice on a skewed hello', () => {
    const { shell, socket, dialogVisible } = loginShell();
    submitLogin(shell, container);
    socket().open();

    socket().deliverText(
      encodeSomnioMessage({
        tag: 'hello',
        payload: { protocolVersion: SOMNIO_PROTOCOL_CONSTANTS.helloVersion + 1 },
      }),
    );

    // The same unrendered-assignment bug: the skew overlay is presented from the hello handler,
    // which no chat line or session change follows.
    expect(dialogVisible()).toBe(false);
    expect(shell.controller.presentedOverlay?.kind).toBe('updateRequired');
    const notice = container.querySelector('[aria-label="Update required"]')?.closest('.overlay-scrim');
    expect(notice?.classList.contains('hidden')).toBe(false);
  });

  it('takes the dialog down once the world arrives', () => {
    const { shell, socket, dialogVisible } = loginShell();
    submitLogin(shell, container);
    socket().open();
    socket().deliverText(
      encodeSomnioMessage({
        tag: 'hello',
        payload: { protocolVersion: SOMNIO_PROTOCOL_CONSTANTS.helloVersion },
      }),
    );
    socket().deliverText(encodeSomnioMessage({ tag: 'loginResult', payload: { result: 'ok' } }));
    expect(dialogVisible()).toBe(true);

    socket().deliverText(encodeSomnioMessage(enterSpaceFrame('EdariaBibliothek')));

    expect(dialogVisible()).toBe(false);
    expect(shell.controller.presentedOverlay).toBeUndefined();
  });
});

describe('desktop detection', () => {
  const nativeWidth = window.innerWidth;

  afterEach(() => {
    // happy-dom's navigator is shared across tests in the file, so the stub has to be undone or
    // every later `matchMedia('(pointer: coarse)')` keeps answering true.
    Object.defineProperty(window.navigator, 'maxTouchPoints', { value: 0, configurable: true });
    Object.defineProperty(window, 'innerWidth', { value: nativeWidth, configurable: true });
  });

  it('treats a wide viewport as desktop even with a coarse pointer', () => {
    // A touchscreen laptop has a coarse pointer and a real keyboard, so the pointer alone is not
    // enough to send the player away.
    //
    // The stub is what makes this test mean what its name says: happy-dom derives
    // `(pointer: coarse)` from `navigator.maxTouchPoints`, which defaults to 0, so without it the
    // coarse branch is never taken and the assertion would hold for `return true`.
    Object.defineProperty(window.navigator, 'maxTouchPoints', { value: 1, configurable: true });
    expect(window.matchMedia('(pointer: coarse)').matches).toBe(true);

    expect(detectDesktop()).toBe(true);
  });

  it('sends a coarse-pointer handheld to the desktop-only notice', () => {
    // The other half of the predicate. Without a case that asserts `false`, every assertion in
    // this block holds for `return true` — and so does inverting the query to `(pointer: fine)`,
    // which would send desktop players away and let phones in.
    Object.defineProperty(window.navigator, 'maxTouchPoints', { value: 1, configurable: true });
    Object.defineProperty(window, 'innerWidth', { value: 480, configurable: true });

    expect(detectDesktop()).toBe(false);
  });

  it('treats a narrow window with a fine pointer as desktop', () => {
    // A desktop browser dragged narrow is still a desktop: the viewport alone must not decide,
    // or a resized window loses its keyboard controls mid-session.
    Object.defineProperty(window, 'innerWidth', { value: 480, configurable: true });

    expect(window.matchMedia('(pointer: coarse)').matches).toBe(false);
    expect(detectDesktop()).toBe(true);
  });
});

describe('the registration form validates before it sends', () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = element('div');
    document.body.append(container);
  });

  afterEach(() => {
    container.remove();
  });

  interface RegistrationRig {
    fields: Record<'nickname' | 'password' | 'repeat' | 'email', HTMLInputElement>;
    people: HTMLSelectElement;
    lastForm: () => RegistrationForm | undefined;
    submit: () => void;
    forms: number;
    error: () => string;
    shell: AppShell;
  }

  function registrationRig(container: HTMLElement): RegistrationRig {
    let submissions = 0;
    let lastForm: RegistrationForm | undefined;
    const shell = new AppShell({
      container,
      capabilities: { hasWebGL: true, isDesktop: true },
      startRendering: false,
      socketFactory: fakeSocketFactory().factory,
    });
    shell.overlays.present({ kind: 'registration' });
    const rig = {
      shell,
      get forms() {
        return submissions;
      },
    } as unknown as RegistrationRig;

    // The registration card is the second dialog; its form carries five rows where login has three.
    const forms = [...container.querySelectorAll('form')];
    const form = forms.find((each) => each.querySelectorAll('input, select').length >= 5);
    if (form === undefined) throw new Error('registration form not found');
    const inputs = [...form.querySelectorAll('input')];
    const passwords = inputs.filter((each) => each.type === 'password');
    const texts = inputs.filter((each) => each.type !== 'password');
    const nickname = texts[0];
    const email = texts.at(-1);
    const password = passwords[0];
    const repeat = passwords[1];
    if (nickname === undefined || email === undefined || password === undefined || repeat === undefined) {
      throw new Error('registration fields not found');
    }

    shell.controller.register = (form) => {
      submissions += 1;
      lastForm = form;
    };

    const selectList = form.querySelectorAll('select');
    const people = selectList[0];
    if (people === undefined || selectList.length !== 1) throw new Error('registration select not found');

    return Object.assign(rig, {
      fields: { nickname, password, repeat, email },
      people,
      lastForm: () => lastForm,
      submit: () => form.dispatchEvent(new Event('submit', { cancelable: true })),
      error: () => form.parentElement?.querySelector('.form-error')?.textContent ?? '',
    });
  }

  function fill(rig: RegistrationRig, overrides: Partial<Record<string, string>> = {}): void {
    rig.fields.nickname.value = overrides['nickname'] ?? 'Tester';
    rig.fields.password.value = overrides['password'] ?? 'hunter22';
    rig.fields.repeat.value = overrides['repeat'] ?? 'hunter22';
    rig.fields.email.value = overrides['email'] ?? 'tester@example.com';
  }

  it('sends when every field is valid', () => {
    const rig = registrationRig(container);
    fill(rig);
    rig.submit();
    expect(rig.forms).toBe(1);
  });

  it('offers the four peoples under the People label', () => {
    const rig = registrationRig(container);

    expect([...rig.people.options].map((option) => [option.value, option.textContent])).toEqual([
      ['wachen', 'Wachen'],
      ['soporen', 'Soporen'],
      ['umbren', 'Umbren'],
      ['lumina', 'Lumina'],
    ]);
    expect(rig.people.labels[0]?.textContent).toBe('People:');
  });

  /**
   * The people is the one choice a player can never correct afterwards, and it travels as a plain
   * string the form's own validation does not look at, so a hard-coded value reaches the account
   * silently. Asserting the call happened is not enough: it fires either way.
   */
  it('carries the chosen people through to the register call', () => {
    const rig = registrationRig(container);
    fill(rig);
    rig.people.value = 'umbren';
    rig.submit();

    expect(rig.lastForm()).toEqual({ nickname: 'Tester', password: 'hunter22', passwordRepeat: 'hunter22', people: 'umbren', email: 'tester@example.com' });
  });

  /**
   * Four validation branches share three messages, so any one of them can be lost without changing
   * what the other tests observe. `onRegister` *not* firing is the assertion that matters: a form
   * that validated nothing would send and let the server answer `.failure`, which renders as an
   * unexplained "Registration failed." the player cannot act on.
   */
  it.each([
    ['an empty nickname', { nickname: '' }],
    ['an over-cap nickname', { nickname: 'a'.repeat(65) }],
    ['a short password', { password: 'short', repeat: 'short' }],
    ['mismatched passwords', { repeat: 'different' }],
    ['an empty email', { email: '' }],
    ['an over-cap email', { email: `${'a'.repeat(60)}@example.com` }],
  ])('refuses to send with %s', (_label, overrides) => {
    const rig = registrationRig(container);
    fill(rig, overrides);
    rig.submit();
    expect(rig.forms).toBe(0);
    expect(rig.error()).not.toBe('');
  });

  /** The reason has to reach the form the player is looking at, each result with its own sentence. */
  it.each([
    ['nicknameExists', 'Nickname already exists.'],
    ['nameNotAllowed', 'That name uses characters Somnio does not allow.'],
    ['failure', 'Registration failed.'],
    ['throttled', 'Too many attempts. Wait a little before trying again.'],
  ] as const)('shows the reason for a %s result in the registration form', (result, reason) => {
    const rig = registrationRig(container);
    // The controller owns the overlay: the repaint after a result presents whatever it holds.
    rig.shell.controller.presentedOverlay = { kind: 'registration' };
    const visibleErrors = () =>
      [...container.querySelectorAll('.form-error')].filter((node) => node.closest('.hidden') === null).map((node) => node.textContent);
    expect(visibleErrors()).toEqual([]);

    rig.shell.controller.dispatch({ tag: 'registerResult', payload: { result } });

    expect(visibleErrors()).toEqual([reason]);
  });

  /** A successful registration returns to a login form that is already filled in. */
  it('pre-fills the login form from the registration values', () => {
    const rig = registrationRig(container);
    fill(rig);
    rig.submit();
    expect(rig.shell.overlays.loginNickname.value).toBe('Tester');
  });
});

describe('leaving the game clears every credential surface', () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = element('div');
    document.body.append(container);
  });

  afterEach(() => {
    container.remove();
  });

  /**
   * Every credential-bearing field in the card, seeded so a clear is observable. Shared because the
   * cases below differ only in what triggers the clear: duplicating the sweep would mean a new
   * field type could be added to one copy and missed by the other, leaving the wiring cases green
   * while a plaintext password survived in the DOM.
   */
  function credentialRig(host: HTMLElement) {
    const { factory, latest } = fakeSocketFactory();
    const shell = new AppShell({ container: host, startRendering: false, socketFactory: factory });
    const inputs = [...host.querySelectorAll('input')];
    const filled = inputs.filter((input) => input.type === 'text' || input.type === 'password' || input.type === 'email');
    for (const input of filled) input.value = 'leaked-value';
    const remember = inputs.find((input) => input.type === 'checkbox');
    if (remember !== undefined) remember.checked = true;
    return { shell, filled, remember, socket: latest };
  }

  function expectCleared(rig: ReturnType<typeof credentialRig>) {
    for (const input of rig.filled) expect(input.value).toBe('');
    if (rig.remember !== undefined) expect(rig.remember.checked).toBe(false);
  }

  /**
   * The registration form is reachable from the same card and holds a plaintext password, so an
   * abandoned sign-up must not survive the departing player either. Nothing else clears it: the
   * login form is wiped on this same path, but `submitRegistration` only ever writes.
   */
  it('empties the registration form too, not only the login form', () => {
    const rig = credentialRig(container);
    rig.shell.overlays.clearCredentialForms();
    expectCleared(rig);
  });

  /**
   * Drives the whole composition rather than `clearCredentialForms` directly. The controller tests
   * prove `endSessionIdentity` fires its callback and the test above proves the callback empties
   * both forms, but neither observes the wire between them — remove `onSessionIdentityEnded` from
   * `AppShell` and both still pass while a real Leave Game leaves two plaintext passwords in the DOM.
   */
  it('empties the forms through the real Leave Game wiring, not just the method', () => {
    const rig = credentialRig(container);
    rig.shell.controller.leaveGame();
    expectCleared(rig);
  });

  /**
   * The path the player does not choose. A dropped connection returns them to the login card with
   * no action on their part, so it has to empty the forms for the same reason Leave Game does —
   * otherwise a server restart is enough to leave one player's password in front of the next.
   */
  it('empties the forms when the connection drops, not only on an explicit leave', () => {
    const rig = credentialRig(container);
    rig.shell.controller.beginSession({
      kind: 'login',
      credentials: { nickname: 'Ida', password: 'hunter2-long', rememberMe: false },
    });
    rig.socket().open();
    // A peer close with nothing user-initiated behind it — a server restart is enough.
    rig.socket().deliverClose();
    expectCleared(rig);
  });
});

describe('overlay focus moves on entry, not on every repaint', () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = element('div');
    document.body.append(container);
  });

  afterEach(() => {
    container.remove();
  });

  /**
   * `AppShell` wires `onChatLinesChanged` to `render()`, and `render()` re-presents the current
   * overlay, so focusing on every call moves the caret to field one mid-keystroke: the rest of a
   * password being typed lands in the plaintext nickname box and Return submits it as the nickname.
   *
   * One `Overlays` across the whole case on purpose — each overlay is built once and shown or
   * hidden, so a fresh instance per assertion would prove nothing about a repaint.
   */
  it('leaves the caret alone when the login card is presented again', () => {
    const shell = new AppShell({ container, startRendering: false });
    shell.overlays.present({ kind: 'login' });

    const password = [...container.querySelectorAll('input')].find((input) => input.type === 'password');
    expect(password).toBeDefined();
    password!.focus();
    expect(document.activeElement).toBe(password);

    shell.overlays.present({ kind: 'login' });

    expect(document.activeElement).toBe(password);
  });

  it('focuses the first field on entering an overlay, including the registration card', () => {
    const shell = new AppShell({ container, startRendering: false });

    shell.overlays.present({ kind: 'login' });
    expect(document.activeElement).toBe(shell.overlays.loginNickname);

    shell.overlays.present({ kind: 'registration' });
    expect(document.activeElement).not.toBe(shell.overlays.loginNickname);
    expect((document.activeElement as HTMLInputElement | null)?.tagName).toBe('INPUT');
  });
});

describe('the HUD beyond its bars', () => {
  const energy = { healthCurrent: 30, healthMax: 60, balanceCurrent: 4, balanceMax: 100, spiritCurrent: 5, spiritMax: 5 };

  it('marks the balance bar, and names the state, only while winded', () => {
    const panels = new GamePanels(noopCallbacks(), catalogTables, 'en');
    const tracks = (): Element[] => [...panels.root.querySelectorAll('.hud-bar__track')];

    panels.renderEnergy(energy, true);
    expect(tracks().map((track) => track.classList.contains('hud-bar__track--winded'))).toEqual([false, true, false]);
    expect(tracks().map((track) => track.getAttribute('aria-label'))).toEqual(['Health 30/60', 'Balance 4/100, winded', 'Spirit 5/5']);

    panels.renderEnergy({ ...energy, balanceCurrent: 15 }, false);
    expect(tracks().some((track) => track.classList.contains('hud-bar__track--winded'))).toBe(false);
    expect(tracks()[1]?.getAttribute('title')).toBe('Balance 15/100');
  });

  it.each<[string, LucidityMessage, string[]]>([
    ['a dreamer with no role', { ranks: [] }, ['No role yet']],
    ['a dreamer on a trial', { ranks: [], task: { role: 'heiler', progress: 0 } }, ['No role yet', 'Task: 0 of 1']],
    [
      'a Kämpfer studying, with a task under way',
      {
        role: 'kaempfer',
        ranks: [{ teachingId: 'strike', rank: 1, practice: 12.9 }],
        study: 'strike',
        task: { role: 'kaempfer', teachingId: 'follow-through', progress: 2 },
      },
      ['Kämpfer', 'Studying Strike: 12 of 35', 'Task: 2 of 3'],
    ],
    [
      'a Heiler studying nothing, with a task done',
      { role: 'heiler', ranks: [{ teachingId: 'touch', rank: 3, practice: 0 }], task: { role: 'heiler', teachingId: 'drawing-back', progress: 60 } },
      ['Heiler', 'Studying nothing', 'Your task is done. Return to your master.'],
    ],
  ])('shows the role, the study, and the task of %s', (_label, lucidity, lines) => {
    const panels = new GamePanels(noopCallbacks(), catalogTables, 'en');
    panels.renderLucidity(lucidity);
    expect([...panels.root.querySelectorAll('.hud-lucidity__line')].map((line) => line.textContent)).toEqual(lines);
  });
});

describe('the service panel', () => {
  function mount() {
    const calls: string[] = [];
    const panel = new ServicePanel({
      onAskTask: (teachingId) => calls.push(`ask:${teachingId ?? 'trial'}`),
      onCompleteTask: () => calls.push('complete'),
      onAbandonTask: () => calls.push('abandon'),
      onStudy: (teachingId) => calls.push(`study:${teachingId}`),
      onClose: () => calls.push('close'),
    });
    const npc = (service: NPCService, id = 'npc:EdariaMitte/pugnax', name = 'Pugnax') => clientEntity({ id, kind: 'npc', name, service });
    const buttons = (): string[] => [...panel.root.querySelectorAll('button')].map((node) => `${node.textContent}${node.disabled ? ' (disabled)' : ''}`);
    const press = (label: string): void => {
      const node = [...panel.root.querySelectorAll('button')].find((candidate) => candidate.textContent === label);
      if (node === undefined) throw new Error(`no button "${label}"`);
      node.click();
    };
    const text = (): string => panel.root.textContent ?? '';
    const row = (id: string): string => panel.root.querySelector(`[data-teaching="${id}"]`)?.textContent ?? '';
    return { panel, calls, npc, buttons, press, text, row };
  }

  beforeEach(() => setLocale('en'));

  it('is hidden with no NPC, and for an NPC with nothing to offer', () => {
    const p = mount();
    p.panel.render(undefined, { ranks: [] });
    expect(p.panel.root.classList.contains('hidden')).toBe(true);
    p.panel.render(clientEntity({ id: 'npc:EdariaBibliothek/libus', kind: 'npc' }), { ranks: [] });
    expect(p.panel.root.classList.contains('hidden')).toBe(true);
  });

  it('offers a dreamer with no role the trial, with what it asks and the condition it is held under', () => {
    const p = mount();
    p.panel.render(p.npc('heilerMaster', 'npc:EdariaMitte/sana', 'Sana'), { ranks: [] });
    expect(p.panel.root.classList.contains('hidden')).toBe(false);
    expect(p.panel.root.querySelector('h1')?.textContent).toBe('Sana');
    expect(p.text()).toContain('Master of the Heiler');
    expect(p.text()).toContain('Passing it commits you to nothing');
    expect(p.text()).toContain('Walk to the Nordwald and come back.');
    expect(p.text()).toContain('You cannot strike while you hold this trial.');
    p.press('Ask for the trial');
    p.press('Close');
    expect(p.calls).toEqual(['ask:trial', 'close']);
  });

  /** The shell renders on every `energy` frame, and a button replaced under a held pointer never gets its click. */
  it('keeps its controls across a render that changed nothing, and replaces them when the lucidity or the NPC did', () => {
    const p = mount();
    const lucidity = { ranks: [] };
    const control = (): Element | null => p.panel.root.querySelector('.service-body button');

    p.panel.render(p.npc('kaempferMaster'), lucidity);
    const first = control();
    p.panel.render(p.npc('kaempferMaster'), lucidity);
    expect(control()).toBe(first);

    p.panel.render(p.npc('kaempferMaster'), { ranks: [], task: { role: 'kaempfer', progress: 0 } });
    expect(control()?.textContent).toBe('Give up the trial');

    p.panel.render(p.npc('heilerMaster', 'npc:EdariaMitte/sana', 'Sana'), lucidity);
    const asked = control();
    expect(asked?.textContent).toBe('Ask for the trial');
    // Another master, with nothing else changed.
    p.panel.render(p.npc('kaempferMaster'), lucidity);
    expect(p.panel.root.querySelector('h1')?.textContent).toBe('Pugnax');
    expect(p.text()).toContain('Master of the Kämpfer');
    p.panel.render(p.npc('heilerMaster', 'npc:EdariaMitte/sana', 'Sana'), lucidity);
    p.panel.render(undefined, lucidity);
    p.panel.render(p.npc('heilerMaster', 'npc:EdariaMitte/sana', 'Sana'), lucidity);
    expect(control()).not.toBe(asked);
    expect(p.buttons()).toEqual(['Ask for the trial', 'Close']);
  });

  it('shows a trial under way with its progress and a way to give it up', () => {
    const p = mount();
    p.panel.render(p.npc('kaempferMaster'), { ranks: [], task: { role: 'kaempfer', progress: 0 } });
    expect(p.text()).toContain('Your trial');
    expect(p.text()).toContain('Drive off a nightmare. 0 of 1');
    expect(p.buttons()).toEqual(['Give up the trial', 'Close']);
    p.press('Give up the trial');
    expect(p.calls).toEqual(['abandon']);
  });

  it('asks a dreamer who passed the trial before making them the role for good', () => {
    const p = mount();
    p.panel.render(p.npc('kaempferMaster'), { ranks: [], task: { role: 'kaempfer', progress: 1 } });
    expect(p.text()).toContain('Become a Kämpfer?');
    expect(p.text()).toContain('for good');
    expect(p.buttons()).toEqual(['Not yet', 'Become a Kämpfer', 'Close']);
    p.press('Not yet');
    p.press('Become a Kämpfer');
    expect(p.calls).toEqual(['close', 'complete']);
  });

  it("tells a dreamer on the other master's trial that they hold one", () => {
    const p = mount();
    p.panel.render(p.npc('kaempferMaster'), { ranks: [], task: { role: 'heiler', progress: 1 } });
    expect(p.text()).toContain("You hold another master's trial.");
    expect(p.buttons()).toEqual(['Give up that trial', 'Close']);
  });

  it('refuses a dreamer of the other role', () => {
    const p = mount();
    p.panel.render(p.npc('kaempferMaster'), { role: 'heiler', ranks: [{ teachingId: 'touch', rank: 1, practice: 0 }] });
    expect(p.text()).toContain('You are a Heiler. Pugnax has nothing to teach you.');
    expect(p.buttons()).toEqual(['Close']);
  });

  const headings = (panel: ServicePanel): string[] => [...panel.root.querySelectorAll('h2')].map((node) => node.textContent ?? '');

  it("sorts a Kämpfer's teachings by what can be done with each: studied, open to study, not yet, mastered", () => {
    const p = mount();
    const lucidity: LucidityMessage = {
      role: 'kaempfer',
      ranks: [
        { teachingId: 'strike', rank: 1, practice: 12.5 },
        { teachingId: 'toughening', rank: 5, practice: 0 },
      ],
      study: 'strike',
    };
    p.panel.render(p.npc('kaempferMaster'), lucidity);
    expect(p.text()).toContain('You study one teaching at a time.');
    expect(headings(p.panel)).toEqual(['You are studying', 'You can study', 'Not yet', 'Mastered']);
    expect([...p.panel.root.querySelectorAll('[data-teaching]')].map((node) => node.getAttribute('data-teaching'))).toEqual([
      'strike',
      'guard',
      'balance-recovery',
      'follow-through',
      'toughening',
    ]);
    expect(p.row('strike')).toContain('Rank 1 of 5');
    expect(p.row('strike')).toContain('12 of 35 practice toward rank 2');
    expect(p.row('guard')).toContain('Study this');
    expect(p.row('follow-through')).toContain('Needs Strike at rank 2');
    expect(p.row('toughening')).toContain('Rank 5 of 5');
    // One control per teaching that has something to do, and none for the rest.
    expect(p.buttons()).toEqual(['Study this', 'Study this', 'Close']);
    p.press('Study this');
    expect(p.calls).toEqual(['study:guard']);
  });

  it('walks a teaching earned by a task from taking the task to learning it, saying what the task is before it is taken', () => {
    const p = mount();
    const ready: LucidityMessage = { role: 'kaempfer', ranks: [{ teachingId: 'strike', rank: 2, practice: 0 }] };
    p.panel.render(p.npc('kaempferMaster'), ready);
    expect(p.text()).toContain('You study nothing. Choose a teaching below.');
    expect(headings(p.panel)).toEqual(['You can study', 'Earned by a task']);
    expect(p.row('follow-through')).toContain('Pugnax teaches its first rank for a task.');
    expect(p.row('follow-through')).toContain('Drive off 3 nightmares.');
    expect(p.row('follow-through')).toContain('Falling starts the count over.');
    p.press('Take the task');

    p.panel.render(p.npc('kaempferMaster'), { ...ready, task: { role: 'kaempfer', teachingId: 'follow-through', progress: 2 } });
    expect(p.row('follow-through')).toContain('Drive off 3 nightmares. 2 of 3');
    p.press('Give up the task');

    p.panel.render(p.npc('kaempferMaster'), { ...ready, task: { role: 'kaempfer', teachingId: 'follow-through', progress: 3 } });
    expect(p.row('follow-through')).toContain('You did what Pugnax asked.');
    p.press('Learn Follow-through');
    expect(p.calls).toEqual(['ask:follow-through', 'abandon', 'complete']);
  });

  it('holds back a second task while one is held, and says why', () => {
    const p = mount();
    const lucidity: LucidityMessage = {
      role: 'heiler',
      ranks: [{ teachingId: 'touch', rank: 2, practice: 0 }],
      task: { role: 'heiler', teachingId: 'nothing-this-client-knows', progress: 0 },
    };
    p.panel.render(p.npc('heilerMaster', 'npc:EdariaMitte/sana', 'Sana'), lucidity);
    expect(p.row('drawing-back')).toContain('Mend 60 health on other dreamers.');
    expect(p.row('drawing-back')).toContain('Finish your current task first.');
    expect(p.buttons()).not.toContain('Take the task');
  });

  it('renders in German', () => {
    setLocale('de');
    const p = mount();
    p.panel.render(p.npc('kaempferMaster'), { role: 'kaempfer', ranks: [{ teachingId: 'strike', rank: 1, practice: 0 }], study: 'strike' });
    expect(headings(p.panel)).toEqual(['Das lernst du', 'Das kannst du lernen', 'Noch nicht']);
    expect(p.row('follow-through')).toContain('Braucht Schlag auf Rang 2');
  });
});

describe('the fallen notice', () => {
  function mount() {
    let wakes = 0;
    const notice = new FallenNotice(() => {
      wakes += 1;
    });
    const visible = (): string[] =>
      [...notice.root.querySelectorAll('button')].filter((node) => node.closest('.hidden') === null).map((node) => node.textContent ?? '');
    const press = (label: string): void => [...notice.root.querySelectorAll('button')].find((node) => node.textContent === label)!.click();
    return { notice, visible, press, wakes: () => wakes };
  }

  beforeEach(() => setLocale('en'));

  it('shows only while the player lies fallen', () => {
    const n = mount();
    n.notice.render({ fallen: false, raise: undefined });
    expect(n.notice.root.classList.contains('hidden')).toBe(true);
    n.notice.render({ fallen: true, raise: undefined });
    expect(n.notice.root.classList.contains('hidden')).toBe(false);
    expect(n.notice.root.textContent).toContain('You cannot move, but you can still speak.');
  });

  it('gives up in two steps, naming where the dreamer will wake', () => {
    const n = mount();
    n.notice.render({ fallen: true, raise: undefined });
    expect(n.visible()).toEqual(['Give up']);
    n.press('Give up');
    expect(n.visible()).toEqual(['Stay', 'Wake there']);
    expect(n.notice.root.textContent).toContain('You will wake at the inn, weakened.');
    expect(n.wakes()).toBe(0);
    n.press('Stay');
    expect(n.visible()).toEqual(['Give up']);
    n.press('Give up');
    n.press('Wake there');
    expect(n.wakes()).toBe(1);
  });

  it('starts from the first step again after the dreamer has stood up', () => {
    const n = mount();
    n.notice.render({ fallen: true, raise: undefined });
    n.press('Give up');
    n.notice.render({ fallen: false, raise: undefined });
    n.notice.render({ fallen: true, raise: undefined });
    expect(n.visible()).toEqual(['Give up']);
  });

  it('counts a raise down while one runs', () => {
    const n = mount();
    n.notice.render({ fallen: true, raise: { healerName: 'Lumi', secondsLeft: 4 } });
    expect(n.notice.root.textContent).toContain('Lumi is drawing you back: 4 s');
    n.notice.render({ fallen: true, raise: undefined });
    expect(n.notice.root.querySelector('p.hidden')?.textContent).toContain('Lumi');
  });
});

/**
 * The session, the two panels, and the play field each have a suite of their own. These drive the
 * whole composition over a socket, because only that shows a press reaches the session and a
 * button reaches the request it names.
 */
describe('the play field and the panels through the shell', () => {
  const PUGNAX = 'npc:Meadow/pugnax';
  let container: HTMLElement;

  beforeEach(() => {
    setLocale('en');
    container = element('div');
    document.body.append(container);
  });

  afterEach(() => {
    container.remove();
  });

  /** A player in the world beside Pugnax, with another dreamer near, and every frame the client has sent since. */
  function playing() {
    const { factory, latest } = fakeSocketFactory();
    const shell = new AppShell({ container, capabilities: { hasWebGL: true, isDesktop: true }, startRendering: false, socketFactory: factory });
    shell.overlays.loginNickname.value = 'Tester';
    (container.querySelector('input[type="password"]') as HTMLInputElement).value = 'hunter22';
    container.querySelector('form')?.dispatchEvent(new Event('submit', { cancelable: true }));
    const socket = latest();
    const deliver = (message: SomnioMessage): void => socket.deliverText(encodeSomnioMessage(message));
    socket.open();
    deliver({ tag: 'hello', payload: { protocolVersion: SOMNIO_PROTOCOL_CONSTANTS.helloVersion } });
    deliver({ tag: 'loginResult', payload: { result: 'ok' } });
    deliver(enterSpaceFrame());
    deliver(sectorFrame(outdoorSector('Meadow', { x: 0, z: 0 })));
    deliver(entityFrame());
    deliver(entityFrame({ id: PUGNAX, kind: 'npc', name: 'Pugnax', x: 10, z: 9, service: 'kaempferMaster' }));
    deliver(entityFrame({ id: 'bren', name: 'Bren', x: 11, z: 10 }));
    deliver({ tag: 'energy', payload: fullPools([]) });
    deliver({ tag: 'lucidity', payload: { ranks: [] } });
    socket.sent.length = 0;
    const sent = (): SomnioMessage[] => socket.sent.map((text) => decodeSomnioMessage(text));
    const press = (label: string): void => {
      const node = [...container.querySelectorAll('button')].find((candidate) => candidate.textContent === label);
      if (node === undefined) throw new Error(`no button "${label}"`);
      node.click();
    };
    const canvas = container.querySelector('canvas')!;
    const tags = (): string[] => sent().map((message) => message.tag);
    return { shell, deliver, sent, press, canvas, tags, swings: () => tags().filter((tag) => tag === 'swing').length };
  }

  it('swings on a left press on the play field, keeps swinging while it is held, and stops when the button comes up anywhere', () => {
    const p = playing();
    p.canvas.dispatchEvent(new PointerEvent('pointerdown', { button: 2 }));
    expect(p.swings()).toBe(0);

    const pressed = performance.now();
    p.canvas.dispatchEvent(new PointerEvent('pointerdown', { button: 0 }));
    expect(p.swings()).toBe(1);
    p.shell.session.runTick(pressed + 1100);
    expect(p.swings()).toBe(2);

    window.dispatchEvent(new PointerEvent('pointerup'));
    p.shell.session.runTick(pressed + 2200);
    expect(p.swings()).toBe(2);
  });

  /** A tap on a touch screen comes with no move before it, and nothing has turned the player toward it yet. */
  it('swings toward where a press lands with no move before it', () => {
    const p = playing();
    const pointer = { clientX: 0, clientY: -100 };
    const toward = headingRadians(mouseFacingHeading({ x: pointer.clientX, y: pointer.clientY }, { x: 0, y: 0 }));
    p.deliver(entityFrame({ id: 'monster:1', kind: 'monster', x: 10 + 0.7 * Math.sin(toward), z: 10 + 0.7 * Math.cos(toward) }));
    p.canvas.dispatchEvent(new PointerEvent('pointerdown', { button: 0, ...pointer }));
    expect(p.sent().flatMap((message) => (message.tag === 'swing' ? [message.payload] : []))).toEqual([{ targetId: 'monster:1' }]);
  });

  /** With another button still down, the left one coming up fires no `pointerup`, only a move, wherever the pointer is by then. */
  it('stops swinging when a move of that pointer shows the left button is up, over the play field or not', () => {
    const p = playing();
    const pressed = performance.now();
    p.canvas.dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerId: 1 }));
    p.canvas.dispatchEvent(new PointerEvent('pointermove', { buttons: 1, pointerId: 1, bubbles: true }));
    // Another device hovering by, or lifting, says nothing about this one's button.
    p.canvas.dispatchEvent(new PointerEvent('pointermove', { buttons: 0, pointerId: 2, bubbles: true }));
    window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 2 }));
    window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 2 }));
    p.shell.session.runTick(pressed + 1100);
    expect(p.swings()).toBe(2);

    document.body.dispatchEvent(new PointerEvent('pointermove', { buttons: 2, pointerId: 1, bubbles: true }));
    p.shell.session.runTick(pressed + 2200);
    expect(p.swings()).toBe(2);
  });

  it('lets go of the dreamer tended on Escape, and opens the menu only on the next', () => {
    const p = playing();
    p.deliver({ tag: 'lucidity', payload: { role: 'heiler', ranks: [{ teachingId: 'touch', rank: 1, practice: 0 }] } });
    p.shell.session.pressAt('bren', 0);
    expect(p.shell.session.tending).toBe('bren');

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    expect(p.shell.session.tending).toBeUndefined();
    expect(p.shell.controller.presentedOverlay).toBeUndefined();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    expect(p.shell.controller.presentedOverlay?.kind).toBe('gameMenu');
  });

  it("sends each of a master's buttons as the request it names, from the trial to a teaching", () => {
    const p = playing();
    const panel = container.querySelector('.service-panel')!;
    expect(panel.classList.contains('hidden')).toBe(true);
    p.shell.session.pressAt(PUGNAX, 0);
    expect(panel.classList.contains('hidden')).toBe(false);

    p.press('Ask for the trial');
    p.deliver({ tag: 'lucidity', payload: { ranks: [], task: { role: 'kaempfer', progress: 0 } } });
    p.press('Give up the trial');
    p.deliver({ tag: 'lucidity', payload: { ranks: [], task: { role: 'kaempfer', progress: 1 } } });
    p.press('Become a Kämpfer');
    p.deliver({ tag: 'lucidity', payload: { role: 'kaempfer', ranks: [{ teachingId: 'strike', rank: 1, practice: 0 }], study: 'strike' } });
    expect(container.querySelector('.hud-lucidity')?.textContent).toContain('Studying Strike');
    (panel.querySelector('[data-teaching="toughening"] button') as HTMLButtonElement).click();

    expect(p.sent()).toEqual([
      { tag: 'talk', payload: { npcId: PUGNAX } },
      { tag: 'askTask', payload: { npcId: PUGNAX } },
      { tag: 'abandonTask', payload: {} },
      { tag: 'completeTask', payload: { npcId: PUGNAX } },
      { tag: 'study', payload: { npcId: PUGNAX, teachingId: 'toughening' } },
    ]);
    p.press('Close');
    expect(panel.classList.contains('hidden')).toBe(true);
  });

  it('shows a fallen player the notice, and wakes them once they confirm giving up', () => {
    const p = playing();
    const notice = container.querySelector('.fallen-notice')!;
    expect(notice.classList.contains('hidden')).toBe(true);

    p.deliver({ tag: 'condition', payload: { entityId: 'self', condition: 'fallen' } });
    expect(notice.classList.contains('hidden')).toBe(false);
    p.press('Give up');
    expect(p.tags()).toEqual([]);
    p.press('Wake there');
    expect(p.sent()).toEqual([{ tag: 'wake', payload: {} }]);
  });
});
