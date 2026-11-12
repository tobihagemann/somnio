import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { WEB_ROOT } from './helpers/paths';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { AppShell, FallenNotice, Overlays, ServicePanel, UPRIGHT_PHONE_QUERY, element, field } from '@/ui';
import { setLocale } from '@/i18n';
import { makeDebugAPI } from '@/debugApi';
import { PEOPLE_SIGILS } from '@/ui/hudIcons';
import { ITEM_ICONS } from '@/ui/itemIcons';
import { PRE_LOGIN_CARD, WORDMARK_BAND_INSET } from '@/splash/reel';
import type { RegistrationForm } from '@/client';
import { FINGER_HOLD_MS, TAP_SLOP_PX } from '@/client';
import { NO_QUESTS, NO_STATS, bountyIdOf, clamp, distance, fullPools, headingFromVector, quest as questOf } from '@somnio/core';
import { SOMNIO_PROTOCOL_CONSTANTS, decodeSomnioMessage, encodeSomnioMessage } from '@somnio/protocol';
import type { CharacterSummaryMessage, LucidityMessage, Service, SomnioMessage } from '@somnio/protocol';
import type { Bounty, Inventory, ItemInstance, QuestId, QuestLog, Sector } from '@somnio/core';
import { fakeSocketFactory } from './helpers/fakeSocket';
import type { FakeSocket } from './helpers/fakeSocket';
import { interiorSector, outdoorSector } from '../../core/test/support/worldFixture.ts';
import { carrying, inventoryFrame, item } from './helpers/inventory';
import { clientEntity, enterSpaceFrame, entityFrame, sectorFrame } from './helpers/worldFixture';
import type { ChatLine, ClientEntity, ServiceCarrier } from '@/client';

/**
 * The DOM layer, against `happy-dom`.
 *
 * WebGL is unavailable here, which is convenient rather than limiting: it exercises the same
 * no-WebGL path a real browser with a blocklisted driver takes, and everything the shell does that
 * is *not* rendering — the overlays, the panels, the host handlers, the notices — is fully driven.
 */

const chromePath = resolve(WEB_ROOT, 'src/ui/chrome.css');

function overlayCallbacks(): ConstructorParameters<typeof Overlays>[0] {
  return {
    onLogin: () => {},
    onRegister: () => {},
    onShowOverlay: () => {},
    onResume: () => {},
    onDismissOverlay: () => {},
    onCancelRegistration: () => {},
    onLeaveGame: () => {},
    onPlay: () => {},
    onCreateCharacter: () => {},
    onCancelNewCharacter: () => {},
    onDeleteCharacter: () => {},
    onLogOutOtherBrowsers: () => {},
    onRetryConnection: () => {},
    onToggleFullscreen: () => {},
    appVersion: '1.2.3',
  };
}

function joinedLines(count: number): ChatLine[] {
  return Array.from({ length: count }, (_, index) => ({ kind: 'joined', playerName: `Dreamer${index}` }));
}

/**
 * `happy-dom` lays nothing out, so the scrollback is given a browser's metrics. While a hidden
 * ancestor leaves it without a box, it measures nothing and takes no scroll, and once shown it is
 * back at its old offset.
 */
function laidOutScrollback(root: HTMLElement): HTMLElement {
  const scrollback = root.querySelector('.chat-scrollback') as HTMLElement;
  const boxHeight = 180;
  const rowHeight = 30;
  const boxed = () => scrollback.closest('.hidden') === null;
  const contentHeight = () => Math.max(boxHeight, scrollback.childElementCount * rowHeight);
  let offset = 0;
  Object.defineProperties(scrollback, {
    clientHeight: { get: () => (boxed() ? boxHeight : 0) },
    scrollHeight: { get: () => (boxed() ? contentHeight() : 0) },
    scrollTop: {
      get: () => (boxed() ? offset : 0),
      set: (value: number) => {
        if (boxed()) offset = clamp(value, 0, contentHeight() - boxHeight);
      },
    },
  });
  return scrollback;
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

  /** Phones play on a layout of their own, so a desktop's rules stay as they are. */
  it('gives a finger the play field, controls a finger can hit, and fields a phone does not zoom into', () => {
    const canvas = /\n#somnio-canvas\s*\{([^}]*)\}/.exec(css)?.[1];
    // Without it the browser takes a drag as a scroll and a pinch as a page zoom, and cancels the pointer.
    expect(canvas).toContain('touch-action: none');
    expect(canvas).toContain('-webkit-touch-callout: none');
    const coarse = /\n@media \(pointer: coarse\) \{([\s\S]*?)\n\}/.exec(css)?.[1];
    // Under 16px, iOS zooms the page into the chat field a tap focuses.
    expect(/\n {2}\.fantasy-field\s*\{([^}]*)\}/.exec(coarse ?? '')?.[1]).toContain('font-size: 16px');
    expect(/\n {2}\.fantasy-button--compact\s*\{([^}]*)\}/.exec(coarse ?? '')?.[1]).toContain('min-height: 44px');
  });

  /**
   * The wordmark band ends above the tallest card, so the wordmark keeps its place whichever card
   * shows. The reel frames its figures clear of the same card and band, so the stylesheet and the
   * reel must agree on its size.
   */
  it('veils the world at half black and holds the wordmark in a band above the tallest card', () => {
    expect(/\n\.splash-veil\s*\{([^}]*)\}/.exec(css)?.[1]).toContain('background: rgb(0 0 0 / 0.5)');
    expect(css).toContain(`--somnio-splash-card-half: ${PRE_LOGIN_CARD.height / 2}px`);
    expect(/\n\.overlay-card\s*\{([^}]*)\}/.exec(css)?.[1]).toContain(`width: min(${PRE_LOGIN_CARD.width}px,`);
    const band = /\n\.splash-wordmark\s*\{([^}]*)\}/.exec(css)?.[1];
    expect(band).toContain(`top: ${WORDMARK_BAND_INSET}px`);
    expect(band).toContain(`bottom: calc(50% + var(--somnio-splash-card-half) + ${WORDMARK_BAND_INSET}px)`);
    const wordmark = /\.splash-wordmark__image\s*\{([^}]*)\}/.exec(css)?.[1];
    expect(wordmark).toContain('width: min(440px, calc(100vw - 48px))');
    // The reel frames its figures clear of the card's column alone, which covers the wordmark only while it is no wider.
    expect(Number(/width: min\((\d+)px/.exec(wordmark ?? '')?.[1])).toBeLessThanOrEqual(PRE_LOGIN_CARD.width);
    // The in-game menus keep their own scrim.
    expect(/\n\.overlay-scrim\s*\{([^}]*)\}/.exec(css)?.[1]).toContain('background: rgb(0 0 0 / 0.55)');
  });

  it("narrows the fallen notice to keep clear of the player's own frame", () => {
    const hud = readFileSync(resolve(WEB_ROOT, 'src/ui/hud.css'), 'utf8');
    expect(/\n\.hud-unit--self\s*\{([^}]*)\}/.exec(hud)?.[1]).toContain('width: var(--somnio-self-frame-width)');
    const width = /\n\.fallen-notice\s*\{[^}]*\n\s*width: ([^;]*);/.exec(css)?.[1];
    expect(width).toMatch(/^min\(380px, calc\(100% - 2 \*/);
    expect(width).toContain('var(--somnio-self-frame-width)');
    // Without the floor the confirmation's buttons spill out of the plate in the narrowest windows.
    expect(/\n\.fallen-notice\s*\{([^}]*)\}/.exec(css)?.[1]).toContain('min-width: min-content');
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

describe('the page head', () => {
  it('links the cloud-S favicon, its dark-sky variant, and the home-screen icon', () => {
    const html = readFileSync(resolve(WEB_ROOT, 'index.html'), 'utf8');
    const links = [...html.matchAll(/<link [^>]*>/g)].map((match) => match[0]);
    expect(links.find((link) => link.includes('somnio-icon-64.png'))).toContain('rel="icon"');
    expect(links.find((link) => link.includes('somnio-icon-64.png'))).not.toContain('media=');
    expect(links.find((link) => link.includes('somnio-icon-dark-64.png'))).toContain('media="(prefers-color-scheme: dark)"');
    expect(links.find((link) => link.includes('rel="apple-touch-icon"'))).toContain('href="/assets/Branding/somnio-icon-180.png"');
    for (const link of links) expect(link).toContain('href="/assets/Branding/');
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
    expect(overlays.loginEmail.getAttribute('autocomplete')).toBe('username');
    expect(overlays.loginEmail.type).toBe('email');
  });

  /** Sign Up's email is the username its `new-password` fields pair with, as the login card's is for its password. */
  it('asks for the email as the username on both credential forms', () => {
    const overlays = new Overlays(overlayCallbacks());

    const emails = [...overlays.root.querySelectorAll<HTMLInputElement>('input[type="email"]')];
    expect(emails.map((input) => input.getAttribute('autocomplete'))).toEqual(['username', 'username']);
  });

  /** The browser's own check refuses a non-ASCII local part and blocks the submit, so the forms' own check and its line are the only gate. */
  it('leaves the email to its own check on both credential forms', () => {
    const overlays = new Overlays(overlayCallbacks());

    const emails = [...overlays.root.querySelectorAll<HTMLInputElement>('input[type="email"]')];
    expect(emails.map((input) => input.form?.noValidate)).toEqual([true, true]);
  });

  /**
   * The login form's validation branches, as a table, so a branch such as the empty password cannot
   * go untested.
   *
   * `onLogin` not firing is the assertion that matters; the visible error is what distinguishes a
   * refusal from a silent no-op.
   */
  it.each([
    ['an empty email', { email: '', password: 'hunter22' }],
    // 14 four-byte emoji and the domain are 68 UTF-8 bytes but only 40 UTF-16 code units, so a
    // `.length` check against the 64-byte identifier cap would wave it through and the server would refuse it.
    ['an email past the byte cap', { email: `${'\u{1F600}'.repeat(14)}@example.com`, password: 'hunter22' }],
    ['an email that is only whitespace', { email: '   ', password: 'hunter22' }],
    ['an email that is not an address', { email: 'Tester', password: 'hunter22' }],
    ['an empty password', { email: 'tester@example.com', password: '' }],
    ['a password past the byte cap', { email: 'tester@example.com', password: '\u{1F600}'.repeat(64) }],
  ])('refuses to open a connection with %s', (_label, { email, password }) => {
    let attempts = 0;
    const overlays = new Overlays({ ...overlayCallbacks(), onLogin: () => (attempts += 1) });
    overlays.present({ kind: 'login' });
    overlays.loginEmail.value = email;
    (overlays.root.querySelector('input[type="password"]') as HTMLInputElement).value = password;

    overlays.root.querySelector('form')?.dispatchEvent(new Event('submit', { cancelable: true }));

    expect(attempts).toBe(0);
    expect(overlays.root.querySelector('.form-error')?.classList.contains('hidden')).toBe(false);
  });

  it('passes a valid login through with the remember-me flag', () => {
    const logins: { email: string; rememberMe: boolean }[] = [];
    const overlays = new Overlays({
      ...overlayCallbacks(),
      onLogin: (credentials) => logins.push(credentials),
    });
    overlays.present({ kind: 'login' });
    overlays.loginEmail.value = 'tester@example.com';
    const password = overlays.root.querySelector('input[type="password"]') as HTMLInputElement;
    password.value = 'hunter22';
    const remember = overlays.root.querySelector('input[type="checkbox"]') as HTMLInputElement;
    remember.checked = true;

    overlays.root.querySelector('form')?.dispatchEvent(new Event('submit', { cancelable: true }));

    expect(logins).toEqual([{ email: 'tester@example.com', password: 'hunter22', rememberMe: true }]);
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
    const { row, input } = field('Email');

    const label = row.querySelector('label');
    expect(label?.getAttribute('for')).toBe(input.id);
    expect(input.id.length).toBeGreaterThan(0);
  });

  /**
   * Slugifying drops punctuation, so labels such as the login card's "Email" and Sign Up's
   * "Email:" collapse to the same slug. Sharing an id points both labels at the first input and
   * leaves the second field with no accessible name and no password-manager association at all.
   */
  it('gives labels that slugify identically their own ids', () => {
    const first = field('Email');
    const second = field('Email:');

    expect(first.input.id).not.toBe(second.input.id);
    expect(first.row.querySelector('label')?.getAttribute('for')).toBe(first.input.id);
    expect(second.row.querySelector('label')?.getAttribute('for')).toBe(second.input.id);
  });
});

/**
 * Lays the window out at `width` x `height` and tells the page, as turning a phone does. It goes
 * through happy-dom's own viewport, which its media queries read. Redefining `innerWidth` on the
 * global reaches none of them.
 */
function layOut(width: number, height: number): void {
  (window as unknown as { happyDOM: { setViewport: (viewport: { width: number; height: number }) => void } }).happyDOM.setViewport({ width, height });
}

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
    new AppShell({ container, capabilities: { hasWebGL: false } });

    const notice = container.querySelector('.blocking-notice:not(.hidden)');
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toContain('WebGL');
    expect(container.querySelector('.splash-wordmark')?.classList.contains('hidden')).toBe(false);
  });

  it('shows only the WebGL notice on an upright phone, which turning would not help', () => {
    Object.defineProperty(window.navigator, 'maxTouchPoints', { value: 1, configurable: true });
    const { innerWidth, innerHeight } = window;
    layOut(390, 844);
    try {
      expect(window.matchMedia(UPRIGHT_PHONE_QUERY).matches).toBe(true);
      new AppShell({ container, capabilities: { hasWebGL: false } });

      const visible = [...container.querySelectorAll('.blocking-notice:not(.hidden)')];
      expect(visible).toHaveLength(1);
      expect(visible[0]?.textContent).toContain('WebGL');
    } finally {
      Object.defineProperty(window.navigator, 'maxTouchPoints', { value: 0, configurable: true });
      layOut(innerWidth, innerHeight);
    }
  });

  it('builds no scene when the host cannot render one', () => {
    const shell = new AppShell({ container, capabilities: { hasWebGL: false } });

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
      capabilities: { hasWebGL: true },
      startRendering: false,
      socketFactory: factory,
    });
    const dialogVisible = () => {
      const scrim = container.querySelector('[aria-label="Somnio"]')?.closest('.overlay-scrim');
      return scrim !== null && scrim !== undefined && !scrim.classList.contains('hidden');
    };
    return { shell, socket: latest, dialogVisible };
  }

  /** Every line shown under the login form. */
  function loginErrors(): string[] {
    return [...container.querySelectorAll('[aria-label="Somnio"] .form-error')]
      .filter((node) => !node.classList.contains('hidden'))
      .map((node) => node.textContent ?? '');
  }

  function loginStatus(): string {
    return loginErrors().join(' / ');
  }

  function wordmarkStatus(): string {
    return container.querySelector('.splash-wordmark__status')?.textContent ?? '';
  }

  function submitLogin(shell: AppShell, container: HTMLElement): void {
    shell.overlays.loginEmail.value = 'tester@example.com';
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

  /** NPCs speak to the player in the language the login names, so it names the page's. */
  it('names the page language on the login it sends', () => {
    const languages = vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['de-DE']);
    try {
      const { shell, socket } = loginShell();
      submitLogin(shell, container);
      socket().open();
      socket().deliverText(encodeSomnioMessage({ tag: 'hello', payload: { protocolVersion: SOMNIO_PROTOCOL_CONSTANTS.helloVersion } }));
      expect(JSON.parse(socket().sent.at(-1)!)).toMatchObject({ tag: 'login', payload: { locale: 'de' } });
    } finally {
      languages.mockRestore();
      setLocale('en');
    }
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
    // The panels stay hidden until the player is in the world, so the reason is said on the card.
    expect(loginStatus()).toBe('Bad credentials.');
    expect(shell.hud.root.classList.contains('hidden')).toBe(true);
  });

  /** A status left standing while the next attempt is under way reads as that attempt's answer. */
  it('clears the reason from the card as soon as the next login is submitted', () => {
    const { shell, socket } = loginShell();
    submitLogin(shell, container);
    socket().open();
    socket().deliverText(encodeSomnioMessage({ tag: 'hello', payload: { protocolVersion: SOMNIO_PROTOCOL_CONSTANTS.helloVersion } }));
    socket().deliverText(encodeSomnioMessage({ tag: 'loginResult', payload: { result: 'badCredentials' } }));
    expect(loginStatus()).toBe('Bad credentials.');

    submitLogin(shell, container);

    expect(loginStatus()).toBe('');
  });

  /** The form's own check is the newer word, so it stands in for the server's last one rather than beside it. */
  it("shows the form's own check in place of the server's reason, never both", () => {
    const { shell, socket } = loginShell();
    submitLogin(shell, container);
    socket().open();
    socket().deliverText(encodeSomnioMessage({ tag: 'hello', payload: { protocolVersion: SOMNIO_PROTOCOL_CONSTANTS.helloVersion } }));
    socket().deliverText(encodeSomnioMessage({ tag: 'loginResult', payload: { result: 'badCredentials' } }));
    expect(loginErrors()).toEqual(['Bad credentials.']);

    (container.querySelector('input[type="password"]') as HTMLInputElement).value = '';
    container.querySelector('form')?.dispatchEvent(new Event('submit', { cancelable: true }));
    shell.render();
    expect(loginErrors()).toEqual(['Bad credentials.']);

    shell.overlays.loginEmail.value = '';
    container.querySelector('form')?.dispatchEvent(new Event('submit', { cancelable: true }));
    shell.render();
    expect(loginErrors()).toEqual(['Enter a valid email address.']);
  });

  it("shows the server's reason for a corrected login, not the form's earlier check", () => {
    const { shell, socket } = loginShell();
    shell.overlays.loginEmail.value = '';
    container.querySelector('form')?.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(loginErrors()).toEqual(['Enter a valid email address.']);

    submitLogin(shell, container);
    socket().open();
    socket().deliverText(encodeSomnioMessage({ tag: 'hello', payload: { protocolVersion: SOMNIO_PROTOCOL_CONSTANTS.helloVersion } }));
    socket().deliverText(encodeSomnioMessage({ tag: 'loginResult', payload: { result: 'badCredentials' } }));

    expect(loginErrors()).toEqual(['Bad credentials.']);
  });

  /** A refused login never attached, so nothing restarts the reel; it must not have stopped. */
  it('keeps the reel playing while a login is under way and after the server refuses it', () => {
    const { shell, socket } = loginShell();
    const splash = shell.splash!;
    splash.update(0.05);
    submitLogin(shell, container);
    socket().open();
    socket().deliverText(encodeSomnioMessage({ tag: 'hello', payload: { protocolVersion: SOMNIO_PROTOCOL_CONSTANTS.helloVersion } }));
    expect(shell.controller.connectionState).toBe('awaitingLoginResult');
    splash.update(0.05);
    expect(splash.currentShotId).toBe('town');

    socket().deliverText(encodeSomnioMessage({ tag: 'loginResult', payload: { result: 'badCredentials' } }));
    splash.update(0.05);
    expect(splash.currentShotId).toBe('town');
  });

  /** The world being joined arrives while the card is still up; the reel must not frame or light it meanwhile. */
  it('stops the reel at the join, before the player is placed', () => {
    const { shell, socket } = loginShell();
    const splash = shell.splash!;
    const deliver = (message: SomnioMessage): void => socket().deliverText(encodeSomnioMessage(message));
    splash.update(0.05);
    expect(splash.currentShotId).toBe('town');
    submitLogin(shell, container);
    socket().open();
    deliver({ tag: 'hello', payload: { protocolVersion: SOMNIO_PROTOCOL_CONSTANTS.helloVersion } });
    deliver({ tag: 'loginResult', payload: { result: 'ok' } });
    deliver(enterSpaceFrame());
    deliver(sectorFrame(outdoorSector('Meadow', { x: 0, z: 0 })));
    expect(shell.controller.inWorld).toBe(false);

    splash.update(0.05);

    expect(splash.currentShotId).toBeUndefined();
  });

  it('says nothing under the wordmark while another card than the login is up', () => {
    const { shell, socket } = loginShell();
    submitLogin(shell, container);
    socket().deliverError();
    expect(loginStatus()).toBe('The server is currently not reachable. Try again later.');

    shell.controller.presentedOverlay = { kind: 'registration' };

    expect(wordmarkStatus()).toBe('');
    expect(loginStatus()).toBe('');
  });

  /**
   * The splash gives way when the player's own body is in the world, not at `enterSpace`, and a later
   * join, which clears the entities before the body returns, never brings it back.
   */
  it('shows the panels in place of the splash once the player stands in the world, and keeps them through a door', () => {
    const { shell, socket } = loginShell();
    const deliver = (message: SomnioMessage): void => socket().deliverText(encodeSomnioMessage(message));
    const shown = () => ({
      panels: !shell.hud.root.classList.contains('hidden'),
      veil: !container.querySelector('.splash-veil')!.classList.contains('hidden'),
      wordmark: !container.querySelector('.splash-wordmark')!.classList.contains('hidden'),
      // Takes the in-game menus' own scrim away only while the veil darkens instead.
      prelogin: container.classList.contains('somnio-prelogin'),
    });
    submitLogin(shell, container);
    socket().open();
    deliver({ tag: 'hello', payload: { protocolVersion: SOMNIO_PROTOCOL_CONSTANTS.helloVersion } });
    deliver({ tag: 'loginResult', payload: { result: 'ok' } });
    expect(shown()).toEqual({ panels: false, veil: true, wordmark: true, prelogin: true });

    deliver(enterSpaceFrame());
    expect(shown()).toEqual({ panels: false, veil: true, wordmark: true, prelogin: true });

    deliver(sectorFrame(outdoorSector('Meadow', { x: 0, z: 0 })));
    deliver(entityFrame());
    expect(shown()).toEqual({ panels: true, veil: false, wordmark: false, prelogin: false });

    deliver(enterSpaceFrame('EdariaInn'));
    expect(shown()).toEqual({ panels: true, veil: false, wordmark: false, prelogin: false });
  });

  /**
   * A hidden tab draws no frames, so a login can complete there with nothing to halt the reel; the
   * tab coming back must not frame or light the game as the shot it left.
   */
  it('plays the reel only until a session attaches, and from its first shot again once the login card returns', () => {
    const { shell, socket } = loginShell();
    const splash = shell.splash!;
    const deliver = (message: SomnioMessage): void => socket().deliverText(encodeSomnioMessage(message));
    const tabTo = (state: 'hidden' | 'visible'): void => {
      Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    };
    splash.update(0.05);
    expect(splash.currentShotId).toBe('town');
    tabTo('hidden');
    tabTo('visible');
    expect(splash.dipOpacity).toBe(1);

    tabTo('hidden');
    submitLogin(shell, container);
    socket().open();
    deliver({ tag: 'hello', payload: { protocolVersion: SOMNIO_PROTOCOL_CONSTANTS.helloVersion } });
    deliver({ tag: 'loginResult', payload: { result: 'ok' } });
    deliver(enterSpaceFrame());
    deliver(sectorFrame(outdoorSector('Meadow', { x: 0, z: 0 })));
    deliver(entityFrame());
    const gameScale = shell.scene!._cameraScale();
    tabTo('visible');
    expect(shell.scene!._cameraScale()).toBe(gameScale);
    expect(splash.dipOpacity).toBe(0);
    splash.update(0.05);
    expect(splash.currentShotId).toBeUndefined();

    shell.controller.leaveGame();
    splash.update(0.05);
    expect(splash.currentShotId).toBe('town');
  });

  it('shows the newest chat line once the panels appear, though the lines came while they were hidden', () => {
    const { shell, socket } = loginShell();
    const scrollback = laidOutScrollback(shell.hud.root);
    const deliver = (message: SomnioMessage): void => socket().deliverText(encodeSomnioMessage(message));
    submitLogin(shell, container);
    socket().open();
    deliver({ tag: 'hello', payload: { protocolVersion: SOMNIO_PROTOCOL_CONSTANTS.helloVersion } });
    deliver({ tag: 'loginResult', payload: { result: 'ok' } });
    for (const line of joinedLines(20)) shell.controller.appendChat(line);

    deliver(enterSpaceFrame());
    deliver(sectorFrame(outdoorSector('Meadow', { x: 0, z: 0 })));
    deliver(entityFrame());

    expect(scrollback.scrollTop).toBe(scrollback.scrollHeight - scrollback.clientHeight);
  });

  /** A resume skips the card, so the join itself names the people the own frame draws, whatever this browser stored. */
  it("draws the player's people sigil on their own frame after a resume in a browser that never listed the dreamer", () => {
    localStorage.clear();
    localStorage.setItem('somnio.sessionToken', JSON.stringify({ token: 'tok', expiresAt: Date.now() + 60_000 }));
    try {
      const { socket } = loginShell();
      const deliver = (message: SomnioMessage): void => socket().deliverText(encodeSomnioMessage(message));
      socket().open();
      deliver({ tag: 'hello', payload: { protocolVersion: SOMNIO_PROTOCOL_CONSTANTS.helloVersion } });
      deliver({ tag: 'loginResult', payload: { result: 'ok' } });
      deliver(enterSpaceFrame('outdoors', 0, 'umbrae'));
      deliver(sectorFrame(outdoorSector('Meadow', { x: 0, z: 0 })));
      deliver(entityFrame());

      expect(container.querySelector<HTMLElement>('.hud-unit--self .hud-sigil .hud-glyph')?.style.getPropertyValue('--hud-glyph')).toBe(
        PEOPLE_SIGILS.umbrae.image,
      );
    } finally {
      localStorage.removeItem('somnio.sessionToken');
    }
  });

  /** A remembered session resumes with no card up, so its retry is said under the wordmark. */
  it('says a silent resume is reconnecting under the wordmark', () => {
    localStorage.setItem('somnio.sessionToken', JSON.stringify({ token: 'tok', expiresAt: Date.now() + 60_000 }));
    try {
      const { shell, socket } = loginShell();
      shell.controller.scheduleResume = () => {};
      expect(shell.controller.presentedOverlay).toBeUndefined();
      socket().open();
      socket().deliverText(encodeSomnioMessage({ tag: 'hello', payload: { protocolVersion: SOMNIO_PROTOCOL_CONSTANTS.helloVersion } }));

      socket().deliverText(encodeSomnioMessage({ tag: 'loginResult', payload: { result: 'alreadyLoggedIn' } }));

      expect(wordmarkStatus()).toBe('Reconnecting...');
    } finally {
      localStorage.removeItem('somnio.sessionToken');
    }
  });

  it('names the login dialog without a visible title, and shows the wordmark over it', () => {
    loginShell();
    const login = container.querySelector('[aria-label="Somnio"]')!;
    expect(login.querySelector('.overlay-title')).toBeNull();
    const wordmark = container.querySelector<HTMLImageElement>('.splash-wordmark__image')!;
    expect(wordmark.getAttribute('alt')).toBe('Somnio');
    expect(wordmark.getAttribute('src')).toBe('/assets/Branding/somnio-wordmark.png');
    expect(wordmark.closest('.hidden')).toBeNull();
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
    expect(container.querySelector('.splash-wordmark')?.classList.contains('hidden')).toBe(false);
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

    socket().deliverText(encodeSomnioMessage(enterSpaceFrame('EdariaLibrary')));

    expect(dialogVisible()).toBe(false);
    expect(shell.controller.presentedOverlay).toBeUndefined();
  });
});

describe('a phone held upright', () => {
  const { innerWidth, innerHeight } = window;
  let container: HTMLElement;

  beforeEach(() => {
    container = element('div');
    document.body.append(container);
  });

  afterEach(() => {
    container.remove();
    // happy-dom's navigator and window are shared across tests in the file, so the stubs have to be
    // undone or every later `matchMedia` keeps answering for an upright phone.
    Object.defineProperty(window.navigator, 'maxTouchPoints', { value: 0, configurable: true });
    layOut(innerWidth, innerHeight);
  });

  const turnCard = (): Element | undefined =>
    [...container.querySelectorAll('.blocking-notice:not(.hidden)')].find((notice) => notice.textContent?.includes('Turn your phone sideways.'));

  /**
   * The stub is what makes a coarse pointer here: happy-dom derives `(pointer: coarse)` from
   * `navigator.maxTouchPoints`, which defaults to 0.
   */
  function phone(width: number, height: number): AppShell {
    Object.defineProperty(window.navigator, 'maxTouchPoints', { value: 1, configurable: true });
    layOut(width, height);
    return new AppShell({ container, capabilities: { hasWebGL: true }, startRendering: false });
  }

  it('is asked to turn, and plays once it is on its side', () => {
    const shell = phone(390, 844);
    expect(turnCard()?.textContent).toContain('tap');
    expect(shell.scene).toBeDefined();

    layOut(844, 390);
    expect(turnCard()).toBeUndefined();

    layOut(390, 844);
    expect(turnCard()).toBeDefined();
  });

  it('plays straight away on its side', () => {
    phone(844, 390);
    expect(turnCard()).toBeUndefined();
  });

  it.each([
    ['a tablet held upright', 768, 1024, 1],
    ['a narrow desktop window', 390, 844, 0],
  ])('leaves %s to play', (_label, width, height, touchPoints) => {
    Object.defineProperty(window.navigator, 'maxTouchPoints', { value: touchPoints, configurable: true });
    layOut(width, height);
    new AppShell({ container, capabilities: { hasWebGL: true }, startRendering: false });
    expect(container.querySelector('.blocking-notice:not(.hidden)')).toBeNull();
  });
});

describe("a mouse's HUD as the window is resized", () => {
  const { innerWidth, innerHeight } = window;
  let container: HTMLElement;

  beforeEach(() => {
    container = element('div');
    document.body.append(container);
  });

  afterEach(() => {
    container.remove();
    layOut(innerWidth, innerHeight);
  });

  it('shrinks to fit a small window and grows back to its size in a large one', () => {
    const shell = new AppShell({ container, capabilities: { hasWebGL: true }, startRendering: false });
    const scale = (): string => shell.hud.root.style.getPropertyValue('--hud-scale');

    layOut(560, 360);
    expect(scale()).toBe('0.742');

    layOut(1280, 720);
    expect(scale()).toBe('1');
  });
});

describe("the world's flames", () => {
  const native = window.matchMedia.bind(window);
  let container: HTMLElement;

  beforeEach(() => {
    container = element('div');
    document.body.append(container);
  });

  afterEach(() => {
    container.remove();
    vi.restoreAllMocks();
  });

  /** How bright a candle in a room burns over three ticks of the shell's scene, for a player who does or does not ask for reduced motion. */
  function candle(reduceMotion: boolean): number[] {
    vi.spyOn(window, 'matchMedia').mockImplementation((query) => {
      const list = native(query);
      if (query === '(prefers-reduced-motion: reduce)') Object.defineProperty(list, 'matches', { value: reduceMotion });
      return list;
    });
    const scene = new AppShell({ container, capabilities: { hasWebGL: true }, startRendering: false }).scene!;
    scene.addSector(interiorSector('EdariaInn', { placements: [{ id: 'candle-1', modelId: 'candle', x: 2, z: 2, yaw: 0, elevation: 0 }] }));
    return [0.2, 0.2, 0.2].map((dt) => {
      scene.tick(dt);
      return scene.scene.children.find((child): child is THREE.PointLight => child instanceof THREE.PointLight && child.intensity > 0)!.intensity;
    });
  }

  it('flicker, and hold steady for a player who asks for reduced motion', () => {
    expect(new Set(candle(false)).size).toBe(3);
    expect(new Set(candle(true)).size).toBe(1);
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
    fields: Record<'email' | 'password' | 'repeat', HTMLInputElement>;
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
      capabilities: { hasWebGL: true },
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

    // The registration card is the second dialog; its form asks for the password twice where login asks once.
    const forms = [...container.querySelectorAll('form')];
    const form = forms.find((each) => each.querySelectorAll('input[type="password"]').length === 2);
    if (form === undefined) throw new Error('registration form not found');
    const inputs = [...form.querySelectorAll('input')];
    const passwords = inputs.filter((each) => each.type === 'password');
    const email = inputs.find((each) => each.type === 'email');
    const password = passwords[0];
    const repeat = passwords[1];
    if (email === undefined || password === undefined || repeat === undefined) {
      throw new Error('registration fields not found');
    }

    shell.controller.register = (form) => {
      submissions += 1;
      lastForm = form;
    };

    return Object.assign(rig, {
      fields: { email, password, repeat },
      lastForm: () => lastForm,
      submit: () => form.dispatchEvent(new Event('submit', { cancelable: true })),
      error: () => form.parentElement?.querySelector('.form-error')?.textContent ?? '',
    });
  }

  function fill(rig: RegistrationRig, overrides: Partial<Record<string, string>> = {}): void {
    rig.fields.email.value = overrides['email'] ?? 'tester@example.com';
    rig.fields.password.value = overrides['password'] ?? 'hunter22';
    rig.fields.repeat.value = overrides['repeat'] ?? 'hunter22';
  }

  it('sends when every field is valid', () => {
    const rig = registrationRig(container);
    fill(rig);
    rig.submit();
    expect(rig.forms).toBe(1);
  });

  /** Asserting the call happened is not enough: it fires whatever the form carries. */
  it('carries the typed fields through to the register call', () => {
    const rig = registrationRig(container);
    fill(rig);
    rig.submit();

    expect(rig.lastForm()).toEqual({ email: 'tester@example.com', password: 'hunter22', passwordRepeat: 'hunter22' });
  });

  /**
   * Three validation branches share two messages, so any one of them can be lost without changing
   * what the other tests observe. `onRegister` *not* firing is the assertion that matters: a form
   * that validated nothing would send and let the server answer `.failure`, which renders as an
   * unexplained "Registration failed." the player cannot act on.
   */
  it.each([
    ['an empty email', { email: '' }],
    ['an email that is not an address', { email: 'tester@example' }],
    ['an over-cap email', { email: `${'a'.repeat(60)}@example.com` }],
    ['a short password', { password: 'short', repeat: 'short' }],
    ['mismatched passwords', { repeat: 'different' }],
  ])('refuses to send with %s', (_label, overrides) => {
    const rig = registrationRig(container);
    fill(rig, overrides);
    rig.submit();
    expect(rig.forms).toBe(0);
    expect(rig.error()).not.toBe('');
  });

  /** The reason has to reach the form the player is looking at, each result with its own sentence. */
  it.each([
    ['emailExists', 'Another account already uses that email.'],
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
    expect(rig.shell.overlays.loginEmail.value).toBe('tester@example.com');
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
      credentials: { email: 'ida@example.com', password: 'hunter2-long', rememberMe: false },
    });
    rig.socket().open();
    // A peer close with nothing user-initiated behind it — a server restart is enough.
    rig.socket().deliverClose();
    expectCleared(rig);
  });
});

describe("the game menu's Log Out Other Browsers", () => {
  let container: HTMLElement;

  beforeEach(() => {
    setLocale('en');
    container = element('div');
    document.body.append(container);
  });

  afterEach(() => {
    container.remove();
  });

  /** A login answered up to the join, with the player's own body placed only when `placed`, and `others` other browsers remembered. */
  function joined(placed: boolean, others = 1) {
    const { factory, latest } = fakeSocketFactory();
    const shell = new AppShell({ container, capabilities: { hasWebGL: true }, startRendering: false, socketFactory: factory });
    shell.controller.beginSession({ kind: 'login', credentials: { email: 'ida@example.com', password: 'hunter2-long', rememberMe: false } });
    const socket = latest();
    const deliver = (message: SomnioMessage): void => socket.deliverText(encodeSomnioMessage(message));
    socket.open();
    deliver({ tag: 'hello', payload: { protocolVersion: SOMNIO_PROTOCOL_CONSTANTS.helloVersion } });
    deliver({ tag: 'loginResult', payload: { result: 'ok' } });
    deliver(enterSpaceFrame());
    if (placed) deliver(entityFrame());
    deliver({ tag: 'otherSessions', payload: { count: others } });
    const escape = (): void => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    const presented = (): Element => container.querySelector('.overlay-scrim:not(.hidden)')!;
    const visible = (): string[] =>
      [...presented().querySelectorAll('button')].filter((node) => node.closest('.hidden') === null).map((node) => node.textContent ?? '');
    const press = (label: string): void => [...presented().querySelectorAll('button')].find((node) => node.textContent === label)!.click();
    return { shell, socket, deliver, escape, visible, press, presented };
  }

  it('is not offered while the player is not yet in the world', () => {
    const g = joined(false);
    g.escape();
    expect(g.shell.controller.presentedOverlay?.kind).toBe('gameMenu');
    expect(g.visible()).toEqual(['Resume', 'Options', 'Leave Game', 'About Somnio']);
  });

  it('is not offered when no other browser remembers the account', () => {
    const g = joined(true, 0);
    g.escape();
    expect(g.visible()).toEqual(['Resume', 'Options', 'Leave Game', 'About Somnio']);
  });

  /** The count is the join's last frame, so a menu opened as the world arrives is up before it lands. */
  it('appears in a menu already open when the count arrives', () => {
    const g = joined(false, 0);
    g.escape();
    g.deliver(entityFrame());
    expect(g.visible()).not.toContain('Log Out Other Browsers');
    g.deliver({ tag: 'otherSessions', payload: { count: 1 } });
    expect(g.visible()).toContain('Log Out Other Browsers');
  });

  it('is withdrawn once the other browsers are logged out', () => {
    const g = joined(true);
    g.deliver({ tag: 'otherSessionsRevoked', payload: { revoked: true, count: 1 } });
    g.escape();
    expect(g.visible()).toEqual(['Resume', 'Options', 'Leave Game', 'About Somnio']);
  });

  it('asks in a dialog of its own, and Cancel goes back to the menu', () => {
    const g = joined(true);
    g.escape();
    expect(g.visible()).toEqual(['Resume', 'Options', 'Leave Game', 'Log Out Other Browsers', 'About Somnio']);
    g.press('Log Out Other Browsers');
    expect(g.shell.controller.presentedOverlay?.kind).toBe('logOutOtherBrowsers');
    expect(g.visible()).toEqual(['Log Them Out', 'Cancel']);
    expect(g.presented().textContent).toContain('Every other browser that remembers your password will have to log in again.');
    g.press('Cancel');
    expect(g.shell.controller.presentedOverlay?.kind).toBe('gameMenu');
  });

  it('goes back to the menu on Escape', () => {
    const g = joined(true);
    g.escape();
    g.press('Log Out Other Browsers');
    g.escape();
    expect(g.shell.controller.presentedOverlay?.kind).toBe('gameMenu');
  });

  it('sends revokeOtherSessions and closes the menu on confirm', () => {
    const g = joined(true);
    g.escape();
    g.socket.sent.length = 0;
    g.press('Log Out Other Browsers');
    g.press('Log Them Out');
    expect(g.socket.sent.map((text) => decodeSomnioMessage(text))).toEqual([{ tag: 'revokeOtherSessions', payload: {} }]);
    expect(g.shell.controller.presentedOverlay).toBeUndefined();
  });
});

describe('the character card', () => {
  let container: HTMLElement;

  beforeEach(() => {
    setLocale('en');
    container = element('div');
    document.body.append(container);
  });

  afterEach(() => {
    container.remove();
  });

  const saibot = { id: 'saibot', name: 'Saibot', people: 'vigils', role: 'fighter' } as const;
  const ida = { id: 'ida', name: 'Ida', people: 'umbrae' };

  /** A login answered up to the card, listing `characters`. */
  function onCard(characters: CharacterSummaryMessage[]) {
    const { factory, latest } = fakeSocketFactory();
    const shell = new AppShell({ container, capabilities: { hasWebGL: true }, startRendering: false, socketFactory: factory });
    shell.controller.beginSession({ kind: 'login', credentials: { email: 'saibot@example.com', password: 'hunter2-long', rememberMe: false } });
    const socket = latest();
    const deliver = (message: SomnioMessage): void => socket.deliverText(encodeSomnioMessage(message));
    socket.open();
    deliver({ tag: 'hello', payload: { protocolVersion: SOMNIO_PROTOCOL_CONSTANTS.helloVersion } });
    deliver({ tag: 'loginResult', payload: { result: 'ok' } });
    deliver({ tag: 'characters', payload: { characters } });
    socket.sent.length = 0;
    const presented = (): Element => container.querySelector('.overlay-scrim:not(.hidden)')!;
    const visible = (): string[] =>
      [...presented().querySelectorAll('button')].filter((node) => node.closest('.hidden') === null).map((node) => node.textContent ?? '');
    const press = (label: string, index = 0): void => [...presented().querySelectorAll('button')].filter((node) => node.textContent === label)[index]!.click();
    const rows = (): string[] =>
      [...presented().querySelectorAll('.character-row__who')].map((node) =>
        [...node.querySelectorAll('strong, span span')].map((part) => part.textContent).join(' | '),
      );
    const sent = (): SomnioMessage[] => socket.sent.map((text) => decodeSomnioMessage(text));
    const error = (): string => [...presented().querySelectorAll('.form-error')].find((node) => !node.classList.contains('hidden'))?.textContent ?? '';
    const escape = (): void => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    return { shell, deliver, presented, visible, press, rows, sent, error, escape };
  }

  it('lists each dreamer by name, people, and role, with Play and Delete', () => {
    const card = onCard([saibot, ida, { id: 'odd', name: 'Odd', people: 'somnambuli' }]);

    expect(card.shell.controller.presentedOverlay?.kind).toBe('characters');
    expect(card.rows()).toEqual(['Saibot | Vigils | Fighter', 'Ida | Umbrae | No role yet', 'Odd | somnambuli | No role yet']);
    expect(card.visible()).toEqual(['Play', 'Delete', 'Play', 'Delete', 'Play', 'Delete', 'Log Out', 'New Dreamer']);

    card.press('Play', 1);
    expect(card.sent()).toEqual([{ tag: 'selectCharacter', payload: { characterId: 'ida' } }]);
  });

  /** Until the answer, a second press would reach a player already in the world, which the server closes on. */
  it('holds its buttons still while the server answers, and keeps its rows across a repaint', () => {
    const card = onCard([saibot]);
    const play = card.presented().querySelector('.character-row button')!;
    card.shell.render();
    expect(card.presented().querySelector('.character-row button')).toBe(play);

    const locked = (): boolean[] => [...card.presented().querySelectorAll('button')].map((node) => node.disabled);
    card.press('Play');

    // Play, Delete, and New Dreamer wait; Log Out never has to.
    expect(locked()).toEqual([true, true, false, true]);
    card.deliver({ tag: 'characterResult', payload: { result: 'failure' } });
    expect(card.error()).toBe('Could not enter the world. Try again.');
    expect(locked()).toEqual([false, false, false, false]);
  });

  it('says on the card why a dreamer could not be played or deleted, until the next request', () => {
    const card = onCard([saibot, ida]);
    card.press('Play');
    card.deliver({ tag: 'characterResult', payload: { result: 'failure' } });
    expect(card.error()).toBe('Could not enter the world. Try again.');

    card.press('Delete', 1);
    card.press('Delete');
    expect(card.error()).toBe('');
    card.deliver({ tag: 'characterResult', payload: { result: 'failure' } });
    expect(card.error()).toBe('Could not delete the dreamer. Try again.');

    card.press('Play');
    expect(card.error()).toBe('');
  });

  it('says what to do with no dreamer yet, and offers no new one once the account holds its most', () => {
    expect(onCard([]).presented().textContent).toContain('No dreamers yet. Create one to enter the world.');
    container.replaceChildren();

    const full = onCard(Array.from({ length: SOMNIO_PROTOCOL_CONSTANTS.maxCharactersPerAccount }, (_, index) => ({ ...ida, id: `ida-${index}` })));
    expect(full.visible()).not.toContain('New Dreamer');
    expect(full.presented().textContent).toContain('Delete a dreamer to make room for a new one.');
  });

  it('creates a dreamer of the chosen people, and comes back to the card with the form emptied', () => {
    const card = onCard([]);
    card.press('New Dreamer');
    expect(card.shell.controller.presentedOverlay?.kind).toBe('newCharacter');
    const name = card.presented().querySelector('input')!;
    const people = card.presented().querySelector('select')!;
    expect([...people.options].map((option) => option.textContent)).toEqual(['Vigils', 'Sopors', 'Umbrae', 'Lumina']);
    name.value = 'Ida';
    people.value = 'umbrae';
    card
      .presented()
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { cancelable: true }));
    expect(card.sent()).toEqual([{ tag: 'createCharacter', payload: { name: 'Ida', people: 'umbrae' } }]);

    card.deliver({ tag: 'characters', payload: { characters: [ida] } });
    card.deliver({ tag: 'characterResult', payload: { result: 'ok' } });

    expect(card.shell.controller.presentedOverlay?.kind).toBe('characters');
    expect(card.rows()).toEqual(['Ida | Umbrae | No role yet']);
    expect(name.value).toBe('');
  });

  it("says on the form why the server refused the dreamer's name", () => {
    const card = onCard([]);
    card.press('New Dreamer');
    card.presented().querySelector('input')!.value = 'Saibot';
    card
      .presented()
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { cancelable: true }));

    card.deliver({ tag: 'characterResult', payload: { result: 'nameExists' } });

    expect(card.shell.controller.presentedOverlay?.kind).toBe('newCharacter');
    expect(card.error()).toBe('Another dreamer already has that name.');
    card.escape();
    expect(card.shell.controller.presentedOverlay?.kind).toBe('characters');
  });

  it('asks before deleting, naming the dreamer, in a dialog of its own', () => {
    const card = onCard([saibot, ida]);
    card.press('Delete', 1);
    expect(card.shell.controller.presentedOverlay?.kind).toBe('deleteCharacter');
    expect(card.presented().textContent).toContain('Ida will be gone for good, with every rank and everything they carry.');
    expect(card.visible()).toEqual(['Delete', 'Cancel']);
    card.press('Cancel');
    expect(card.shell.controller.presentedOverlay?.kind).toBe('characters');
    card.press('Delete', 1);
    card.escape();
    expect(card.shell.controller.presentedOverlay?.kind).toBe('characters');
    expect(card.sent()).toEqual([]);

    card.press('Delete', 1);
    card.press('Delete');

    expect(card.sent()).toEqual([{ tag: 'deleteCharacter', payload: { characterId: 'ida' } }]);
    expect(card.shell.controller.presentedOverlay?.kind).toBe('characters');
  });

  it('logs out to the login card', () => {
    const card = onCard([saibot]);
    card.press('Log Out');
    expect(card.shell.controller.presentedOverlay?.kind).toBe('login');
    expect(card.shell.controller.connectionState).toBe('disconnected');
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
   * password being typed lands in the plaintext email box and Return submits it as the email.
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
    expect(document.activeElement).toBe(shell.overlays.loginEmail);

    shell.overlays.present({ kind: 'registration' });
    expect(document.activeElement).not.toBe(shell.overlays.loginEmail);
    expect((document.activeElement as HTMLInputElement | null)?.tagName).toBe('INPUT');
  });
});

describe('the service panel', () => {
  const NOTHING: Inventory = carrying();

  function mount() {
    const calls: string[] = [];
    const panel = new ServicePanel({
      onAcceptQuest: (questId) => calls.push(`accept:${questId}`),
      onTurnInQuest: (questId) => calls.push(`turnIn:${questId}`),
      onAbandonQuest: (questId) => calls.push(`abandon:${questId}`),
      onStudy: (teachingId) => calls.push(`study:${teachingId}`),
      onBuy: (baseId) => calls.push(`buy:${baseId}`),
      onSell: (itemId) => calls.push(`sell:${itemId}`),
      onClose: () => calls.push('close'),
    });
    const render = (npc: ServiceCarrier | undefined, lucidity: LucidityMessage, inventory = NOTHING, tradeLocked = false): void =>
      panel.render(npc, lucidity, NO_QUESTS, [], inventory, tradeLocked);
    /** Renders for a dreamer holding the quest, with that much done toward each of its objectives. */
    const holding = (npc: ClientEntity, lucidity: LucidityMessage, questId: QuestId, progress: number[], inventory = NOTHING): void =>
      panel.render(npc, lucidity, { active: [{ questId, progress }], done: [] }, [], inventory, false);
    const npc = (service: Service, id = 'npc:EdariaFighterHall/pugnax', name = 'Pugnax') => clientEntity({ id, kind: 'npc', name, service });
    const buttons = (): string[] => [...panel.root.querySelectorAll('button')].map((node) => `${node.textContent}${node.disabled ? ' (disabled)' : ''}`);
    const press = (label: string): void => {
      const node = [...panel.root.querySelectorAll('button')].find((candidate) => candidate.textContent === label);
      if (node === undefined) throw new Error(`no button "${label}"`);
      node.click();
    };
    const text = (): string => panel.root.textContent ?? '';
    const row = (id: string): string => panel.root.querySelector(`[data-teaching="${id}"]`)?.textContent ?? '';
    const quest = (id: string): string => panel.root.querySelector(`[data-quest="${id}"]`)?.textContent ?? '';
    return { panel, render, holding, calls, npc, buttons, press, text, row, quest };
  }

  beforeEach(() => setLocale('en'));

  it('is hidden with no carrier, and for an NPC with neither a service nor a quest to give or take', () => {
    const p = mount();
    p.render(undefined, { ranks: [] });
    expect(p.panel.root.classList.contains('hidden')).toBe(true);
    p.render(clientEntity({ id: 'npc:EdariaInn/keeper', kind: 'npc' }), { ranks: [] });
    expect(p.panel.root.classList.contains('hidden')).toBe(true);
  });

  it('offers a dreamer with no role the trial, with what it asks and the condition it is held under', () => {
    const p = mount();
    p.render(p.npc('healerMaster', 'npc:EdariaHealerHall/sana', 'Sana'), { ranks: [] });
    expect(p.panel.root.classList.contains('hidden')).toBe(false);
    expect(p.panel.root.querySelector('h1')?.textContent).toBe('Sana');
    expect(p.text()).toContain('Master of the Healers');
    expect(p.text()).toContain('Passing it commits you to nothing');
    expect(p.text()).toContain('Walk to the North Wood and come back.');
    expect(p.text()).toContain('You cannot strike while you hold this quest.');
    // At the row's trailing edge, as every quest's button is.
    expect(p.panel.root.querySelector('.service-body button')?.parentElement?.className).toBe('teaching-action');
    p.press('Ask for the trial');
    p.press('Close');
    expect(p.calls).toEqual(['accept:healer-trial', 'close']);
  });

  /** The shell renders on every `energy` frame, and a button replaced under a held pointer never gets its click. */
  it('keeps its controls across a render that changed nothing, and replaces them when the quests or the NPC did', () => {
    const p = mount();
    const lucidity = { ranks: [] };
    const control = (): Element | null => p.panel.root.querySelector('.service-body button');

    p.render(p.npc('fighterMaster'), lucidity);
    const first = control();
    p.render(p.npc('fighterMaster'), lucidity);
    expect(control()).toBe(first);
    // A master reads only whether a trial's reward has a place to go, so a bounty landing in the purse leaves the panel standing.
    p.render(p.npc('fighterMaster'), lucidity, carrying({ coins: 5 }));
    expect(control()).toBe(first);

    p.holding(p.npc('fighterMaster'), lucidity, 'fighter-trial', [0]);
    expect(control()?.textContent).toBe('Give up the trial');

    p.render(p.npc('healerMaster', 'npc:EdariaHealerHall/sana', 'Sana'), lucidity);
    const asked = control();
    expect(asked?.textContent).toBe('Ask for the trial');
    // Another master, with nothing else changed.
    p.render(p.npc('fighterMaster'), lucidity);
    expect(p.panel.root.querySelector('h1')?.textContent).toBe('Pugnax');
    expect(p.text()).toContain('Master of the Fighters');
    p.render(p.npc('healerMaster', 'npc:EdariaHealerHall/sana', 'Sana'), lucidity);
    p.render(undefined, lucidity);
    p.render(p.npc('healerMaster', 'npc:EdariaHealerHall/sana', 'Sana'), lucidity);
    expect(control()).not.toBe(asked);
    expect(p.buttons()).toEqual(['Ask for the trial', 'Close']);
  });

  it('shows a trial under way with its progress and a way to give it up', () => {
    const p = mount();
    p.holding(p.npc('fighterMaster'), { ranks: [] }, 'fighter-trial', [0]);
    expect(p.text()).toContain('Your trial');
    expect(p.text()).toContain('Drive off a nightmare. 0 of 1');
    expect(p.buttons()).toEqual(['Give up the trial', 'Close']);
    expect(p.panel.root.querySelector('.service-body button')?.parentElement?.className).toBe('teaching-action');
    p.press('Give up the trial');
    expect(p.calls).toEqual(['abandon:fighter-trial']);
  });

  it("offers the Mystic's trial and counts the places found without naming one", () => {
    const p = mount();
    const tacita = p.npc('mysticMaster', 'npc:EdariaMysticTower/tacita', 'Tacita');
    p.render(tacita, { ranks: [] });
    expect(p.text()).toContain('Master of the Mystics');
    expect(p.panel.root.querySelectorAll('.service-body p.form-note')).toHaveLength(1);
    expect(p.text()).toContain('Find the hidden places Tacita speaks of.');
    expect(p.buttons()).toEqual(['Ask for the trial', 'Close']);

    p.holding(tacita, { ranks: [] }, 'mystic-trial', [1, 0, 1]);
    expect(p.text()).toContain('Find the hidden places Tacita speaks of. 2 of 3');
    expect(p.text()).not.toMatch(/Meadow|Wood/);
    expect(p.buttons()).toEqual(['Give up the trial', 'Close']);

    p.holding(tacita, { ranks: [] }, 'mystic-trial', [1, 1, 1]);
    expect(p.buttons()).toEqual(['Not yet', 'Become a Mystic', 'Close']);
  });

  it("holds back the role while the trial's reward has nowhere to go, as the master does", () => {
    const p = mount();
    const sana = p.npc('healerMaster', 'npc:EdariaHealerHall/sana', 'Sana');
    const fullBag = Array.from({ length: SOMNIO_PROTOCOL_CONSTANTS.maxBagItems }, (_, index) => item('cap', `cap-${index}`));
    p.holding(sana, { ranks: [] }, 'healer-trial', [1], carrying({ worn: [item('buckler')], bag: fullBag }));
    expect(p.text()).toContain('Your bag is full. Make room in it before you accept.');
    expect(p.buttons()).toEqual(['Not yet', 'Become a Healer (disabled)', 'Close']);
    p.holding(sana, { ranks: [] }, 'healer-trial', [1], carrying({ bag: fullBag }));
    expect(p.text()).not.toContain('Your bag is full.');
    expect(p.buttons()).toEqual(['Not yet', 'Become a Healer', 'Close']);
    p.holding(p.npc('fighterMaster'), { ranks: [] }, 'fighter-trial', [1], carrying({ worn: [item('buckler')], bag: fullBag }));
    expect(p.buttons()).toEqual(['Not yet', 'Become a Fighter', 'Close']);
  });

  it('asks a dreamer who passed the trial before making them the role for good', () => {
    const p = mount();
    p.holding(p.npc('fighterMaster'), { ranks: [] }, 'fighter-trial', [1]);
    expect(p.text()).toContain('Become a Fighter?');
    expect(p.text()).toContain('for good');
    expect(p.buttons()).toEqual(['Not yet', 'Become a Fighter', 'Close']);
    p.press('Not yet');
    p.press('Become a Fighter');
    expect(p.calls).toEqual(['close', 'turnIn:fighter-trial']);
  });

  it('greys out taking a quest on while the quest log is full, and says why', () => {
    const p = mount();
    const full = {
      active: Array.from({ length: SOMNIO_PROTOCOL_CONSTANTS.maxActiveQuests }, () => ({ questId: 'drawing-back-task' as const, progress: [0] })),
      done: [],
    };
    p.panel.render(p.npc('fighterMaster'), { ranks: [] }, full, [], NOTHING, false);
    expect(p.text()).toContain('Your quest log is full. Give up a quest to take this one.');
    expect(p.buttons()).toEqual(['Ask for the trial (disabled)', 'Close']);
    p.panel.render(p.npc('fighterMaster'), { role: 'fighter', ranks: [{ teachingId: 'strike', rank: 2, practice: 0 }] }, full, [], NOTHING, false);
    expect(p.row('follow-through')).toContain('Your quest log is full.');
    expect(p.buttons()).toContain('Take the task (disabled)');
  });

  it("tells a dreamer on the other master's trial that they hold one", () => {
    const p = mount();
    p.holding(p.npc('fighterMaster'), { ranks: [] }, 'healer-trial', [1]);
    expect(p.text()).toContain("You hold another master's trial.");
    expect(p.buttons()).toEqual(['Give up that trial', 'Close']);
    p.press('Give up that trial');
    expect(p.calls).toEqual(['abandon:healer-trial']);
  });

  it('offers a trial and a task only at the carrier that gives it, and takes them in only at the one that takes them, as the server judges both', () => {
    const p = mount();
    // A second master of the Fighters: the trial and the task are Pugnax's, by his id.
    const other = p.npc('fighterMaster', 'npc:Meadow/drillmaster', 'Drillmaster');
    p.render(other, { ranks: [] });
    expect(p.text()).toContain('Drive off a nightmare.');
    expect(p.buttons()).toEqual(['Close']);
    p.holding(other, { ranks: [] }, 'fighter-trial', [1]);
    expect(p.buttons()).toEqual(['Give up the trial', 'Close']);
    const ready: LucidityMessage = { role: 'fighter', ranks: [{ teachingId: 'strike', rank: 2, practice: 0 }] };
    p.render(other, ready);
    expect(p.row('follow-through')).toContain('Drive off 3 nightmares.');
    expect(p.buttons()).not.toContain('Take the task');
    p.holding(other, ready, 'follow-through-task', [3]);
    expect(p.buttons()).not.toContain('Learn Follow-through');
  });

  it('refuses a dreamer of the other role', () => {
    const p = mount();
    p.render(p.npc('fighterMaster'), { role: 'healer', ranks: [{ teachingId: 'touch', rank: 1, practice: 0 }] });
    expect(p.text()).toContain('You are a Healer. Pugnax has nothing to teach you.');
    expect(p.buttons()).toEqual(['Close']);
  });

  const headings = (panel: ServicePanel): string[] => [...panel.root.querySelectorAll('h2')].map((node) => node.textContent ?? '');

  it("sorts a Fighter's teachings by what can be done with each: studied, open to study, not yet, mastered", () => {
    const p = mount();
    const lucidity: LucidityMessage = {
      role: 'fighter',
      ranks: [
        { teachingId: 'strike', rank: 1, practice: 12.5 },
        { teachingId: 'toughening', rank: 5, practice: 0 },
      ],
      study: 'strike',
    };
    p.render(p.npc('fighterMaster'), lucidity);
    expect(p.text()).toContain('You study one teaching at a time.');
    expect(headings(p.panel)).toEqual(['You are studying', 'You can study', 'Not yet', 'Mastered']);
    expect([...p.panel.root.querySelectorAll('[data-teaching]')].map((node) => node.getAttribute('data-teaching'))).toEqual([
      'strike',
      'guard',
      'balance-recovery',
      'cleave',
      'follow-through',
      'challenge',
      'brace',
      'lunge',
      'rally',
      'toughening',
    ]);
    expect(p.row('strike')).toContain('Rank 1 of 5');
    expect(p.row('strike')).toContain('12 of 35 practice toward rank 2');
    expect(p.row('guard')).toContain('Study this');
    expect(p.row('follow-through')).toContain('Needs Strike at rank 2');
    expect(p.row('toughening')).toContain('Rank 5 of 5');
    // One control per teaching that has something to do, and none for the rest.
    expect(p.buttons()).toEqual(['Study this', 'Study this', 'Study this', 'Close']);
    p.press('Study this');
    expect(p.calls).toEqual(['study:guard']);
  });

  it('walks a teaching earned by a task from taking the task to learning it, saying what the task is before it is taken', () => {
    const p = mount();
    const ready: LucidityMessage = { role: 'fighter', ranks: [{ teachingId: 'strike', rank: 2, practice: 0 }] };
    p.render(p.npc('fighterMaster'), ready);
    expect(p.text()).toContain('You study nothing. Choose a teaching below.');
    expect(headings(p.panel)).toEqual(['You can study', 'Earned by a task', 'Not yet']);
    expect(p.row('follow-through')).toContain('Pugnax teaches its first rank for a task.');
    expect(p.row('follow-through')).toContain('Drive off 3 nightmares.');
    expect(p.row('follow-through')).toContain('Falling starts the count over.');
    p.press('Take the task');

    p.holding(p.npc('fighterMaster'), ready, 'follow-through-task', [2]);
    expect(p.row('follow-through')).toContain('Drive off 3 nightmares. 2 of 3');
    p.press('Give up the task');

    p.holding(p.npc('fighterMaster'), ready, 'follow-through-task', [3]);
    expect(p.row('follow-through')).toContain('You did what Pugnax asked.');
    p.press('Learn Follow-through');
    expect(p.calls).toEqual(['accept:follow-through-task', 'abandon:follow-through-task', 'turnIn:follow-through-task']);
  });

  it('renders in German', () => {
    setLocale('de');
    const p = mount();
    p.render(p.npc('fighterMaster'), { role: 'fighter', ranks: [{ teachingId: 'strike', rank: 1, practice: 0 }], study: 'strike' });
    expect(headings(p.panel)).toEqual(['Das lernst du', 'Das kannst du lernen', 'Noch nicht']);
    expect(p.row('follow-through')).toContain('Braucht Schlag auf Rang 2');
  });

  describe('of a carrier of quests alone', () => {
    const LIBUS = 'npc:EdariaLibrary/libus';
    const MEMOR = 'npc:Graveyard/memor';
    const libus = () => clientEntity({ id: LIBUS, kind: 'npc', name: 'Libus' });
    const memor = () => clientEntity({ id: MEMOR, kind: 'npc', name: 'Memor' });

    it("offers Libus's errand under his name alone, with what it asks and pays, and takes it on", () => {
      const p = mount();
      p.render(libus(), { ranks: [] });
      expect(p.panel.root.classList.contains('hidden')).toBe(false);
      expect(p.panel.root.querySelector('h1')?.textContent).toBe('Libus');
      expect((p.panel.root.querySelector('.service-subtitle') as HTMLElement).classList.contains('hidden')).toBe(true);
      expect(p.quest('newcomer-errand')).toContain("A newcomer's errand");
      expect(p.quest('newcomer-errand')).toContain('Visit Mercus in his shop.');
      expect(p.quest('newcomer-errand')).toContain('Read the bounty board on the square.');
      expect(p.quest('newcomer-errand')).toContain('Reward: 15c');
      p.press('Take the quest');
      expect(p.calls).toEqual(['accept:newcomer-errand']);
    });

    it('shows the errand under way with its progress, then turns it in once done, and has nothing more after', () => {
      const p = mount();
      p.holding(libus(), { ranks: [] }, 'newcomer-errand', [1, 0]);
      expect(p.quest('newcomer-errand')).toContain('Visit Mercus in his shop. 1 of 1');
      expect(p.quest('newcomer-errand')).toContain('Read the bounty board on the square. 0 of 1');
      expect(p.buttons()).toEqual(['Close']);
      p.holding(libus(), { ranks: [] }, 'newcomer-errand', [1, 1]);
      expect(p.quest('newcomer-errand')).toContain('You did what Libus asked.');
      p.press('Turn in');
      expect(p.calls).toEqual(['turnIn:newcomer-errand']);
      p.panel.render(libus(), { ranks: [] }, { active: [], done: ['newcomer-errand'] }, [], NOTHING, false);
      expect(p.text()).toContain('Libus has nothing for you now.');
      expect(p.buttons()).toEqual(['Close']);
    });

    it('takes in a quest held at every carrier of the service its turn-in names', () => {
      const p = mount();
      const graves = questOf('restless-graves');
      const turnIn = graves.turnIn;
      graves.turnIn = 'shopkeeper';
      try {
        const mercus = clientEntity({ id: 'npc:EdariaShop/mercus', kind: 'npc', name: 'Mercus', service: 'shopkeeper' });
        p.holding(mercus, { ranks: [] }, 'restless-graves', [4]);
        expect(p.quest('restless-graves')).toContain('You did what Mercus asked.');
        expect(p.buttons()).toContain('Turn in');
        p.holding(memor(), { ranks: [] }, 'restless-graves', [4]);
        expect(p.buttons()).toEqual(['Close']);
      } finally {
        graves.turnIn = turnIn;
      }
    });

    it("offers Memor's chain one quest at a time, and greys out turning in one that pays gear while the bag is full", () => {
      const p = mount();
      p.render(memor(), { ranks: [] });
      expect(p.panel.root.querySelectorAll('[data-quest]')).toHaveLength(1);
      expect(p.quest('restless-graves')).toContain('Reward: 60c, 30 practiceTake the quest');
      // The practice goes toward the teaching the dreamer studies, which the reward names.
      p.render(memor(), { role: 'fighter', ranks: [{ teachingId: 'toughening', rank: 1, practice: 0 }], study: 'toughening' });
      expect(p.quest('restless-graves')).toContain('Reward: 60c, 30 practice toward Toughening');
      const done = ['restless-graves', 'cracked-skulls'] as QuestId[];
      const fullBag = Array.from({ length: SOMNIO_PROTOCOL_CONSTANTS.maxBagItems }, (_, index) => item('cap', `cap-${index}`));
      p.panel.render(memor(), { ranks: [] }, { active: [{ questId: 'into-the-crypt', progress: [1] }], done }, [], carrying({ bag: fullBag }), false);
      expect(p.quest('into-the-crypt')).toContain('Reward: 250c, 60 practice, a piece of gear');
      expect(p.text()).toContain('Your bag is full. Make room in it before you turn this in.');
      expect(p.buttons()).toEqual(['Turn in (disabled)', 'Close']);
      p.panel.render(memor(), { ranks: [] }, { active: [{ questId: 'into-the-crypt', progress: [1] }], done }, [], NOTHING, false);
      expect(p.buttons()).toEqual(['Turn in', 'Close']);
    });
  });

  describe('of the bounty board', () => {
    const board = (): ServiceCarrier => ({ id: 'fixture:EdariaSquare/fixture-1', name: undefined, position: { x: 18.15, z: 18.1 }, service: 'bountyBoard' });
    const ARENA: Bounty = { day: 3, land: 'EdariaArena', monsterKind: 'ghost', objective: 'driveOff', count: 6, reward: { coins: 72, gear: 1 } };
    const GRAVES: Bounty = { day: 3, land: 'Graveyard', monsterKind: 'skeleton-warrior', objective: 'collect', count: 4, reward: { coins: 120, gear: 3 } };
    const show = (p: ReturnType<typeof mount>, quests: QuestLog, bounties: readonly Bounty[] = [ARENA, GRAVES], inventory = NOTHING): void =>
      p.panel.render(board(), { ranks: [] }, quests, bounties, inventory, false);
    const held = (bounty: Bounty, count: number) => ({ questId: bountyIdOf(bounty), progress: [count], definition: bounty });

    it('opens under its service as its title, and says so when it has no bounties', () => {
      const p = mount();
      p.render(board(), { ranks: [] });
      expect(p.panel.root.classList.contains('hidden')).toBe(false);
      expect(p.panel.root.querySelector('h1')?.textContent).toBe('Bounty board');
      expect(p.panel.root.getAttribute('aria-label')).toBe('Bounty board');
      expect((p.panel.root.querySelector('.service-subtitle') as HTMLElement).classList.contains('hidden')).toBe(true);
      expect(p.text()).toContain('No bounties today.');
    });

    it("lists the day's bounties by their land with what each asks and pays, and takes one", () => {
      const p = mount();
      show(p, NO_QUESTS);
      expect(p.quest(bountyIdOf(ARENA))).toBe('Bounty: ArenaDrive off 6 Ghosts there.Reward: 72c, a piece of gearTake the bounty');
      expect(p.quest(bountyIdOf(GRAVES))).toContain('Gather 4 cracked skulls from Skeleton Warriors.');
      // With none taken on an earlier day, the day's stand under no heading.
      expect(p.panel.root.querySelector('.service-heading')).toBeNull();
      expect(p.panel.root.querySelector('button[aria-label="Take Bounty: Graveyard. Gather 4 cracked skulls from Skeleton Warriors."]')).not.toBeNull();
      p.press('Take the bounty');
      expect(p.calls).toEqual([`accept:${bountyIdOf(ARENA)}`]);
    });

    it('shows one taken with how far it has come, one done with its turn-in, greyed out while the bag is full, and one turned in as such', () => {
      const p = mount();
      show(p, { active: [held(ARENA, 2)], done: [bountyIdOf(GRAVES)] });
      expect(p.quest(bountyIdOf(ARENA))).toBe('Bounty: ArenaTakenDrive off 6 Ghosts there. 2 of 6Reward: 72c, a piece of gear');
      expect(p.quest(bountyIdOf(GRAVES))).toBe('Bounty: GraveyardTurned in');
      expect(p.buttons()).toEqual(['Close']);

      const fullBag = Array.from({ length: SOMNIO_PROTOCOL_CONSTANTS.maxBagItems }, (_, index) => item('cap', `cap-${index}`));
      show(p, { active: [held(ARENA, 6)], done: [] }, [ARENA, GRAVES], carrying({ bag: fullBag }));
      expect(p.quest(bountyIdOf(ARENA))).toContain('Your bag is full. Make room in it before you turn this in.');
      expect(p.buttons()).toEqual(['Turn in (disabled)', 'Take the bounty', 'Close']);
      show(p, { active: [held(ARENA, 6)], done: [] });
      expect(p.panel.root.querySelector('button[aria-label="Turn in Bounty: Arena. Drive off 6 Ghosts there."]')).not.toBeNull();
      p.press('Turn in');
      expect(p.calls).toEqual([`turnIn:${bountyIdOf(ARENA)}`]);
    });

    it("still pays for a bounty taken on an earlier day, listed under a heading of its own before the day's, each button named apart", () => {
      const p = mount();
      const earlier = { ...GRAVES, day: 2 };
      show(p, { active: [held(earlier, 4), held(GRAVES, 4)], done: [] });
      expect([...p.panel.root.querySelectorAll('.service-heading, [data-quest]')].map((node) => node.getAttribute('data-quest') ?? node.textContent)).toEqual([
        'Taken on an earlier day',
        bountyIdOf(earlier),
        "Today's bounties",
        bountyIdOf(ARENA),
        bountyIdOf(GRAVES),
      ]);
      expect(p.buttons()).toEqual(['Turn in', 'Take the bounty', 'Turn in', 'Close']);
      // The two Graveyard bounties share their title and what they ask, so the day sets their names apart.
      const names = [...p.panel.root.querySelectorAll('.service-body button')].map((node) => node.getAttribute('aria-label'));
      expect(names).toEqual([
        'Turn in Bounty: Graveyard from an earlier day. Gather 4 cracked skulls from Skeleton Warriors.',
        'Take Bounty: Arena. Drive off 6 Ghosts there.',
        'Turn in Bounty: Graveyard. Gather 4 cracked skulls from Skeleton Warriors.',
      ]);
    });

    it("says a bounty held as it was taken on, though the day's offer of it asks and pays otherwise since", () => {
      const p = mount();
      // The spawns changed since it was taken on: the same id, a different count and reward.
      const taken: Bounty = { ...ARENA, count: 4, reward: { coins: 48, gear: 1 } };
      expect(bountyIdOf(taken)).toBe(bountyIdOf(ARENA));
      show(p, { active: [held(taken, 2)], done: [] });
      expect(p.quest(bountyIdOf(ARENA))).toBe('Bounty: ArenaTakenDrive off 4 Ghosts there. 2 of 4Reward: 48c, a piece of gear');
      show(p, { active: [held(taken, 4)], done: [] });
      expect(p.panel.root.querySelector('button[aria-label="Turn in Bounty: Arena. Drive off 4 Ghosts there."]')).not.toBeNull();
    });

    it('keeps its elements while the bounties and the log are unchanged', () => {
      const p = mount();
      const quests: QuestLog = { active: [held(ARENA, 1)], done: [] };
      const bounties = [ARENA, GRAVES];
      show(p, quests, bounties);
      const before = [...p.panel.root.querySelectorAll('*')];
      show(p, quests, bounties);
      expect([...p.panel.root.querySelectorAll('*')]).toEqual(before);
    });
  });

  describe('of the shopkeeper', () => {
    const mercus = () => clientEntity({ id: 'npc:EdariaShop/mercus', kind: 'npc', name: 'Mercus', service: 'shopkeeper' });
    const wares = (panel: ServicePanel): (string | null)[] => [...panel.root.querySelectorAll('[data-ware]')].map((node) => node.getAttribute('data-ware'));
    const ware = (panel: ServicePanel, id: string): string => panel.root.querySelector(`[data-ware="${id}"]`)?.textContent ?? '';
    const sold = (panel: ServicePanel): (string | null)[] => [...panel.root.querySelectorAll('[data-item]')].map((node) => node.getAttribute('data-item'));
    const sale = (panel: ServicePanel, id: string): string => panel.root.querySelector(`[data-item="${id}"]`)?.textContent ?? '';

    it('offers every ware, says what each costs and does, and buys what the bag holds for what its rarity fetches', () => {
      const p = mount();
      const rare: ItemInstance = { ...item('amulet', 'amulet-rare'), rarity: 'rare', affixes: [{ affixId: 'spirit', value: 6 }] };
      p.render(mercus(), { ranks: [] }, carrying({ coins: 100, worn: [item('dagger')], bag: [item('cudgel'), rare, item('moonstone')] }));
      expect(p.text()).toContain('Shopkeeper');
      expect(p.panel.root.querySelector('.shop-purse')?.textContent).toBe('Your purse100c');
      expect(p.panel.root.querySelector('.service-body .shop-purse')).toBeNull();
      expect(headings(p.panel)).toEqual(['For sale', 'Sell']);
      expect(wares(p.panel)).toEqual([
        'dagger',
        'cudgel',
        'sword',
        'mace',
        'buckler',
        'shield',
        'wand',
        'cap',
        'tunic',
        'gloves',
        'trousers',
        'boots',
        'amulet',
        'ring',
      ]);
      expect(ware(p.panel, 'dagger')).toContain('6 damage, 10 balance a swing');
      expect(ware(p.panel, 'dagger')).not.toContain('more.');
      expect(ware(p.panel, 'shield')).toContain('+4 Guard');
      expect(ware(p.panel, 'wand')).toContain('In the off hand, it lets a Mystic use their abilities.');
      expect(ware(p.panel, 'sword')).toContain('You need 50c more.');
      expect(ware(p.panel, 'mace')).toContain('You need 140c more.');
      // The Moonstone is never bought, so it has no row to sell it from.
      expect(sold(p.panel)).toEqual(['cudgel-1', 'amulet-rare']);
      expect(sale(p.panel, 'amulet-rare')).toBe('AmuletRare+5 Health+6 SpiritSell for 75c');
      expect(p.panel.root.querySelector('[data-item="amulet-rare"] .ware-name')?.classList.contains('hud-rarity--rare')).toBe(true);
      expect(sale(p.panel, 'cudgel-1')).toBe('Cudgel8 damage, 18 balance a swingSell for 10c');
      expect(p.buttons().filter((label) => !label.startsWith('Buy'))).toEqual(['Sell for 10c', 'Sell for 75c', 'Close']);
      // Two wares can share a price, so each trade button's accessible name says which item it trades.
      expect(p.panel.root.querySelector('[data-item="amulet-rare"] button')?.getAttribute('aria-label')).toBe('Sell Amulet for 75c');
      expect(p.panel.root.querySelector('[data-ware="gloves"] button')?.getAttribute('aria-label')).toBe('Buy Leather gloves for 25c');
      p.press('Sell for 75c');
      expect(p.calls).toEqual(['sell:amulet-rare']);
    });

    it("draws each ware's and each sale's item as its icon, edged in its rarity's colour", () => {
      const p = mount();
      const rare: ItemInstance = { ...item('amulet', 'amulet-rare'), rarity: 'rare', affixes: [{ affixId: 'spirit', value: 6 }] };
      p.render(mercus(), { ranks: [] }, carrying({ coins: 100, bag: [rare] }));
      const icon = (row: string) => {
        const node = p.panel.root.querySelector<HTMLImageElement>(`${row} .ware-head > img`);
        return [
          node?.getAttribute('src'),
          node?.getAttribute('alt'),
          node?.classList.contains('ware-icon'),
          [...(node?.classList ?? [])].find((name) => name.startsWith('hud-rarity--')),
        ];
      };
      expect(icon('[data-ware="sword"]')).toEqual([ITEM_ICONS.sword, '', true, 'hud-rarity--plain']);
      expect(icon('[data-item="amulet-rare"]')).toEqual([ITEM_ICONS.amulet, '', true, 'hud-rarity--rare']);
    });

    it('sells nothing into a full bag, and says so', () => {
      const p = mount();
      const fullBag = Array.from({ length: SOMNIO_PROTOCOL_CONSTANTS.maxBagItems }, (_, index) => item('cap', `cap-${index}`));
      p.render(mercus(), { ranks: [] }, carrying({ coins: 500, bag: fullBag }));
      expect(ware(p.panel, 'dagger')).toContain('Your bag is full.');
      expect(
        p
          .buttons()
          .filter((label) => label.startsWith('Buy'))
          .every((label) => label.endsWith('(disabled)')),
      ).toBe(true);
    });

    it('sells another of a ware the dreamer carries, and says when the bag holds nothing to sell', () => {
      const p = mount();
      p.render(mercus(), { ranks: [] }, carrying({ coins: 500, worn: [item('cudgel')], bag: [item('moonstone')] }));
      expect(p.buttons()).toContain('Buy for 30c');
      expect(headings(p.panel)).toEqual(['For sale', 'Sell']);
      expect(p.text()).toContain('Your bag holds nothing Mercus buys.');
    });

    it('keeps the purse current through a trade, and hides it at a master', () => {
      const p = mount();
      const purseLine = (): HTMLElement => p.panel.root.querySelector<HTMLElement>('.shop-purse')!;
      p.render(mercus(), { ranks: [] }, carrying({ coins: 100 }));
      p.render(mercus(), { ranks: [] }, carrying({ coins: 40, bag: [item('dagger')] }));
      expect(purseLine().textContent).toBe('Your purse40c');
      expect(purseLine().classList.contains('hidden')).toBe(false);
      p.render(p.npc('fighterMaster'), { ranks: [] }, carrying({ coins: 40 }));
      expect(purseLine().classList.contains('hidden')).toBe(true);
    });

    /** A recovering pool renders the shell several times a second, and a button replaced under a held pointer never gets its click. */
    it('keeps its buttons across a render that changed nothing, and locks every trade while one is under way', () => {
      const p = mount();
      const lucidity = { ranks: [] };
      const inventory = carrying({ coins: 100, bag: [item('cudgel')] });
      const sell = (): Element | null => p.panel.root.querySelector('[data-item="cudgel-1"] button');
      p.render(mercus(), lucidity, inventory);
      const first = sell();
      p.render(mercus(), lucidity, inventory);
      expect(sell()).toBe(first);
      // The shop reads no lucidity, so a frame of practice leaves its buttons standing.
      p.render(mercus(), { ranks: [{ teachingId: 'strike', rank: 1, practice: 1 }] }, inventory);
      expect(sell()).toBe(first);

      p.render(mercus(), lucidity, inventory, true);
      expect(
        p
          .buttons()
          .filter((label) => label !== 'Close')
          .every((label) => label.endsWith('(disabled)')),
      ).toBe(true);
      expect(p.buttons()).toContain('Sell for 10c (disabled)');
    });

    it('renders in German, naming each ware in the locale', () => {
      setLocale('de');
      const p = mount();
      p.render(mercus(), { ranks: [] }, carrying({ coins: 100, bag: [{ ...item('cap'), rarity: 'magic', affixes: [{ affixId: 'guard', value: 2 }] }] }));
      expect(headings(p.panel)).toEqual(['Im Angebot', 'Verkaufen']);
      expect(ware(p.panel, 'sword')).toContain('Kurzschwert');
      expect(sale(p.panel, 'cap-1')).toBe('LederkappeMagisch+1 Deckung+2 DeckungFür 30c verkaufen');
    });
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
    n.notice.render({ fallen: false, raise: undefined }, 0);
    expect(n.notice.root.classList.contains('hidden')).toBe(true);
    n.notice.render({ fallen: true, raise: undefined }, 0);
    expect(n.notice.root.classList.contains('hidden')).toBe(false);
    expect(n.notice.root.textContent).toContain('You cannot move, but you can still speak.');
  });

  it('gives up in two steps, naming where the dreamer will wake', () => {
    const n = mount();
    n.notice.render({ fallen: true, raise: undefined }, 0);
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
    n.notice.render({ fallen: true, raise: undefined }, 0);
    n.press('Give up');
    n.notice.render({ fallen: false, raise: undefined }, 0);
    n.notice.render({ fallen: true, raise: undefined }, 0);
    expect(n.visible()).toEqual(['Give up']);
  });

  it('counts a raise down by whole seconds while one runs, naming every Healer holding on', () => {
    const n = mount();
    n.notice.render({ fallen: true, raise: { progress: 0, seconds: 6, healerNames: ['Lumi'], atMs: 0, endsAtMs: 6000 } }, 2000);
    expect(n.notice.root.textContent).toContain('Lumi is drawing you back: 4 s');
    n.notice.tick(2500);
    expect(n.notice.root.textContent).toContain('Lumi is drawing you back: 4 s');
    n.notice.tick(3001);
    expect(n.notice.root.textContent).toContain('Lumi is drawing you back: 3 s');
    n.notice.render({ fallen: true, raise: { progress: 0.5, seconds: 2, healerNames: ['Lumi', 'Bren'], atMs: 3000, endsAtMs: 5000 } }, 3000);
    expect(n.notice.root.textContent).toContain('Lumi and Bren are drawing you back: 2 s');
    n.notice.render({ fallen: true, raise: undefined }, 0);
    expect(n.notice.root.querySelector('p.hidden')?.textContent).toContain('Lumi');
  });

  it('names the Healers drawing the player back as German lists them', () => {
    setLocale('de');
    const n = mount();
    n.notice.render({ fallen: true, raise: { progress: 0, seconds: 2, healerNames: ['Lumi', 'Bren'], atMs: 0, endsAtMs: 2000 } }, 0);
    expect(n.notice.root.textContent).toContain('Lumi und Bren holen dich zurück: 2 s');
  });
});

/**
 * The session, the two panels, and the play field each have a suite of their own. These drive the
 * whole composition over a socket, because only that shows a press reaches the session and a
 * button reaches the request it names.
 */
describe('the play field and the panels through the shell', () => {
  // His committed id, since the trial and the task he gives name him by it.
  const PUGNAX = 'npc:EdariaFighterHall/pugnax';
  const MERCUS = 'npc:Meadow/mercus';
  let container: HTMLElement;

  beforeEach(() => {
    setLocale('en');
    container = element('div');
    document.body.append(container);
  });

  afterEach(() => {
    container.remove();
    vi.restoreAllMocks();
  });

  /** A player in the world beside Pugnax, with another dreamer near, and every frame the client has sent since. */
  function playing(meadow: Sector = outdoorSector('Meadow', { x: 0, z: 0 })) {
    const { factory, latest } = fakeSocketFactory();
    const shell = new AppShell({ container, capabilities: { hasWebGL: true }, startRendering: false, socketFactory: factory });
    shell.overlays.loginEmail.value = 'tester@example.com';
    (container.querySelector('input[type="password"]') as HTMLInputElement).value = 'hunter22';
    container.querySelector('form')?.dispatchEvent(new Event('submit', { cancelable: true }));
    const socket = latest();
    const deliver = (message: SomnioMessage): void => socket.deliverText(encodeSomnioMessage(message));
    socket.open();
    deliver({ tag: 'hello', payload: { protocolVersion: SOMNIO_PROTOCOL_CONSTANTS.helloVersion } });
    deliver({ tag: 'loginResult', payload: { result: 'ok' } });
    deliver(enterSpaceFrame());
    deliver(sectorFrame(meadow));
    deliver(entityFrame());
    deliver(entityFrame({ id: PUGNAX, kind: 'npc', name: 'Pugnax', x: 10, z: 9, service: 'fighterMaster' }));
    deliver(entityFrame({ id: 'bren', name: 'Bren', x: 11, z: 10 }));
    deliver({ tag: 'energy', payload: fullPools(NO_STATS) });
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
    return { shell, deliver, sent, press, canvas, tags };
  }

  /** The canvas laid out at 200 x 100 px, and a pointer event at a page point on it. */
  function onCanvas(p: ReturnType<typeof playing>) {
    vi.spyOn(p.canvas, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 200, 100));
    return (type: string, at: { x: number; y: number }, init: PointerEventInit = {}): PointerEvent =>
      new PointerEvent(type, { button: 0, clientX: at.x, clientY: at.y, bubbles: true, ...init });
  }

  it("walks toward a nightmare a mouse's left button presses with slot 1 on, as it goes down, and does nothing on the middle button", () => {
    const p = playing();
    const pointer = onCanvas(p);
    p.deliver(entityFrame({ id: 'monster:1', kind: 'monster', x: 12, z: 10 }));
    const ghost = p.shell.pagePointOf('monster:1')!;
    p.canvas.dispatchEvent(pointer('pointerdown', ghost, { button: 1, pointerType: 'mouse' }));
    expect(p.shell.session.target).toBeUndefined();

    p.canvas.dispatchEvent(pointer('pointerdown', ghost, { pointerType: 'mouse' }));
    expect([p.shell.session.target, p.shell.session.engaged]).toEqual(['monster:1', true]);
    expect(p.shell.session.predictor.walk).toMatchObject({ kind: 'path', destination: { x: 12, z: 10 } });
    window.dispatchEvent(new PointerEvent('pointerup'));
    expect(p.tags()).toContain('engage');
  });

  it("acts on a finger's tap on a body as it lifts", () => {
    const p = playing();
    const pointer = onCanvas(p);
    p.deliver(entityFrame({ id: 'monster:1', kind: 'monster', x: 12, z: 10 }));
    const ghost = p.shell.pagePointOf('monster:1')!;

    p.canvas.dispatchEvent(pointer('pointerdown', ghost, { pointerType: 'touch', pointerId: 1, isPrimary: true }));
    expect(p.shell.session.target).toBeUndefined();
    window.dispatchEvent(pointer('pointerup', ghost, { pointerType: 'touch', pointerId: 1 }));
    expect([p.shell.session.target, p.shell.session.gazeLocked, p.shell.session.engaged]).toEqual(['monster:1', true, true]);
  });

  it('only targets the body a pen rests on, and the lift then does nothing', () => {
    const p = playing();
    const pointer = onCanvas(p);
    p.deliver(entityFrame({ id: 'monster:1', kind: 'monster', x: 12, z: 10 }));
    const ghost = p.shell.pagePointOf('monster:1')!;
    const pressed = performance.now();

    p.canvas.dispatchEvent(pointer('pointerdown', ghost, { pointerType: 'pen', pointerId: 2, isPrimary: true }));
    p.shell.session.runTick(pressed + FINGER_HOLD_MS + 50);
    expect([p.shell.session.target, p.shell.session.gazeLocked]).toEqual(['monster:1', false]);
    window.dispatchEvent(pointer('pointerup', ghost, { pointerType: 'pen', pointerId: 2 }));
    expect([p.shell.session.engaged, p.shell.session.predictor.walk]).toEqual([false, undefined]);
    expect(p.tags()).not.toContain('engage');
  });

  describe('the bounty board', () => {
    const BOARD = 'fixture:Meadow/fixture-1';
    const boardMeadow = outdoorSector(
      'Meadow',
      { x: 0, z: 0 },
      {
        placements: [{ id: 'notice-board-1', modelId: 'notice-board', x: 14, z: 10, yaw: 35, elevation: 0 }],
        fixtures: [{ id: 'fixture-1', placement: 'notice-board-1', service: 'bountyBoard' }],
      },
    );

    it('is walked to on a left press at its drawn model and opened in speaking distance, after the move that brought the player there', () => {
      const p = playing(boardMeadow);
      const pointer = onCanvas(p);
      const [board] = makeDebugAPI(p.shell).fixtures();
      expect(board).toMatchObject({ id: BOARD, service: 'bountyBoard', x: 14, z: 10 });
      p.canvas.dispatchEvent(pointer('pointerdown', board!.screen!));
      window.dispatchEvent(new PointerEvent('pointerup'));
      expect(p.shell.session.predictor.walk).toMatchObject({ kind: 'path', destination: { x: 14, z: 10 } });
      for (let time = 0; time <= 4000 && !p.tags().includes('interact'); time += 50) p.shell.session.runTick(time);

      expect(p.sent().slice(-2)).toEqual([
        { tag: 'move', payload: expect.anything() },
        { tag: 'interact', payload: { carrierId: BOARD } },
      ]);
      const panel = container.querySelector('.service-panel')!;
      expect(panel.classList.contains('hidden')).toBe(false);
      expect(panel.querySelector('h1')?.textContent).toBe('Bounty board');
      expect(p.shell.session.target).toBeUndefined();
    });

    it('shows the pointing hand over the board and none over the ground', () => {
      const p = playing(boardMeadow);
      const pointer = onCanvas(p);
      p.canvas.dispatchEvent(pointer('pointermove', p.shell.pagePointOfFixture(BOARD)!, { pointerType: 'mouse', buttons: 0 }));
      expect(p.canvas.style.cursor).toBe('pointer');
      p.canvas.dispatchEvent(pointer('pointermove', { x: 170, y: 60 }, { pointerType: 'mouse', buttons: 0 }));
      expect(p.canvas.style.cursor).toBe('');
    });

    it('does nothing on a right press', () => {
      const p = playing(boardMeadow);
      const pointer = onCanvas(p);
      const board = p.shell.pagePointOfFixture(BOARD)!;
      p.canvas.dispatchEvent(pointer('pointerdown', board, { button: 2, buttons: 2, pointerType: 'mouse' }));
      expect(p.shell.session.predictor.walk).toBeUndefined();
      expect([p.shell.session.target, p.shell.session.gazeLocked]).toEqual([undefined, false]);
      expect(p.sent()).toEqual([]);
    });
  });

  it("targets the body a mouse's right button presses without walking or locking the facing, and clears the target on the ground, under their own body too", () => {
    const p = playing();
    const pointer = onCanvas(p);
    p.deliver(entityFrame({ id: 'monster:1', kind: 'monster', x: 12, z: 10 }));
    const right = { button: 2, buttons: 2, pointerType: 'mouse' };
    const ghost = p.shell.pagePointOf('monster:1')!;

    p.canvas.dispatchEvent(pointer('pointerdown', ghost, right));
    expect([p.shell.session.target, p.shell.session.gazeLocked, p.shell.session.engaged]).toEqual(['monster:1', false, false]);
    expect(p.shell.session.predictor.walk).toBeUndefined();

    p.canvas.dispatchEvent(pointer('pointerdown', ghost, { pointerType: 'mouse' }));
    window.dispatchEvent(pointer('pointerup', ghost, { pointerType: 'mouse' }));
    expect([p.shell.session.gazeLocked, p.shell.session.engaged]).toEqual([true, true]);
    p.canvas.dispatchEvent(pointer('pointerdown', p.shell.pagePointOf('self')!, right));
    expect([p.shell.session.target, p.shell.session.gazeLocked, p.shell.session.engaged]).toEqual([undefined, false, false]);

    p.canvas.dispatchEvent(pointer('pointerdown', ghost, right));
    p.canvas.dispatchEvent(pointer('pointerdown', { x: 170, y: 60 }, right));
    expect(p.shell.session.target).toBeUndefined();
    expect(p.sent().filter((message) => message.tag === 'target')).toEqual([
      { tag: 'target', payload: { targetId: 'monster:1' } },
      { tag: 'target', payload: {} },
      { tag: 'target', payload: { targetId: 'monster:1' } },
      { tag: 'target', payload: {} },
    ]);
  });

  it("walks to the body a mouse's left button presses, locking the facing and switching slot 1 on there, which a right press at it leaves as they stand", () => {
    const p = playing();
    const pointer = onCanvas(p);
    p.deliver(entityFrame({ id: 'monster:1', kind: 'monster', x: 12, z: 10 }));
    p.deliver(entityFrame({ id: 'bren', kind: 'player', name: 'Bren', x: 8, z: 10 }));
    const right = { button: 2, buttons: 2, pointerType: 'mouse' };
    const selection = vi.spyOn(p.shell.scene!, 'showSelection');
    const press = (id: string, buttons: Partial<PointerEventInit> = {}): void => {
      const at = p.shell.pagePointOf(id)!;
      p.canvas.dispatchEvent(pointer('pointerdown', at, { pointerType: 'mouse', ...buttons }));
      window.dispatchEvent(pointer('pointerup', at, { pointerType: 'mouse' }));
    };

    press('monster:1');
    expect([p.shell.session.target, p.shell.session.gazeLocked]).toEqual(['monster:1', true]);
    expect(p.shell.session.predictor.walk).toMatchObject({ kind: 'path', destination: { x: 12, z: 10 } });
    expect(selection.mock.calls.at(-1)).toEqual(['monster:1', { locked: true, acting: true }]);
    press('monster:1', right);
    expect(selection.mock.calls.at(-1)).toEqual(['monster:1', { locked: true, acting: true }]);

    press('bren', right);
    expect([p.shell.session.target, p.shell.session.gazeLocked]).toEqual(['bren', false]);
    expect(selection.mock.calls.at(-1)).toEqual(['bren', { locked: false, acting: false }]);
    expect(p.sent().filter((message) => message.tag === 'target' || message.tag === 'engage')).toEqual([
      { tag: 'target', payload: { targetId: 'monster:1' } },
      { tag: 'engage', payload: { on: true } },
      { tag: 'target', payload: { targetId: 'bren' } },
    ]);
  });

  /** A button pressed while another is down fires no `pointerdown`, only a move naming it. */
  it('targets the body a right press made while the left button is down lands on', () => {
    const p = playing();
    const pointer = onCanvas(p);
    p.deliver(entityFrame({ id: 'monster:1', kind: 'monster', x: 12, z: 10 }));
    const mouse = { pointerType: 'mouse', pointerId: 1 };

    p.canvas.dispatchEvent(pointer('pointerdown', { x: 170, y: 60 }, { ...mouse, buttons: 1 }));
    p.canvas.dispatchEvent(pointer('pointermove', p.shell.pagePointOf('monster:1')!, { ...mouse, button: 2, buttons: 3 }));

    expect([p.shell.session.target, p.shell.session.gazeLocked]).toEqual(['monster:1', false]);
  });

  /** With another button still down, the left one coming up fires no `pointerup`, only a move naming it. */
  it('walks on a left press made while the right button is down', () => {
    const p = playing();
    const pointer = onCanvas(p);
    const mouse = { pointerType: 'mouse', pointerId: 1 };

    p.canvas.dispatchEvent(pointer('pointerdown', { x: 170, y: 60 }, { ...mouse, button: 2, buttons: 2 }));
    p.canvas.dispatchEvent(pointer('pointermove', { x: 170, y: 60 }, { ...mouse, button: 0, buttons: 3 }));
    expect(p.shell.session.predictor.walk).toBeUndefined();
    p.canvas.dispatchEvent(pointer('pointermove', { x: 170, y: 60 }, { ...mouse, button: 0, buttons: 2 }));

    expect(p.shell.session.predictor.walk).toBeDefined();
  });

  it("targets nothing on a pen's barrel button pressed while the pen is in contact", () => {
    const p = playing();
    const pointer = onCanvas(p);
    p.deliver(entityFrame({ id: 'monster:1', kind: 'monster', x: 12, z: 10 }));
    const pen = { pointerType: 'pen', pointerId: 1 };

    p.canvas.dispatchEvent(pointer('pointerdown', { x: 170, y: 60 }, { ...pen, buttons: 1 }));
    p.canvas.dispatchEvent(pointer('pointermove', p.shell.pagePointOf('monster:1')!, { ...pen, button: 2, buttons: 3 }));

    expect([p.shell.session.target, p.shell.session.gazeLocked]).toEqual([undefined, false]);
  });

  it('targets nothing on a right press from a pen or a finger', () => {
    const p = playing();
    const pointer = onCanvas(p);
    p.deliver(entityFrame({ id: 'monster:1', kind: 'monster', x: 12, z: 10 }));
    for (const pointerType of ['pen', 'touch']) p.canvas.dispatchEvent(pointer('pointerdown', p.shell.pagePointOf('monster:1')!, { button: 2, pointerType }));
    expect([p.shell.session.target, p.shell.session.gazeLocked]).toEqual([undefined, false]);
  });

  it('faces the point a press lands on, with no move before it', () => {
    const p = playing();
    const pointer = onCanvas(p);
    const at = p.shell.pagePointOfGround({ x: 10.45, z: 10.45 })!;
    p.canvas.dispatchEvent(pointer('pointerdown', at));
    p.shell.session.runTick(performance.now());

    const aim = p.shell.scene!.aimPointAt(at.x / 100 - 1, 1 - at.y / 50)!;
    expect(p.shell.controller.entities.get('self')!.facing).toBeCloseTo(headingFromVector(aim.x - 10, aim.z - 10), 6);
  });

  /** With another button still down, the left one coming up fires no `pointerup`, only a move, wherever the pointer is by then. */
  it('ends a held press when a move of that pointer shows the left button is up, over the play field or not', () => {
    let clock = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const p = playing();
    const pointer = onCanvas(p);
    p.canvas.dispatchEvent(pointer('pointerdown', { x: 170, y: 60 }, { pointerId: 1 }));
    p.canvas.dispatchEvent(pointer('pointermove', { x: 170, y: 60 }, { buttons: 1, pointerId: 1 }));
    // Another device hovering by, or lifting, says nothing about this one's button.
    p.canvas.dispatchEvent(new PointerEvent('pointermove', { buttons: 0, pointerId: 2, bubbles: true }));
    window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 2 }));
    window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 2 }));
    clock += 200;
    p.shell.session.runTick(clock);
    expect(p.shell.session.predictor.walk?.kind).toBe('steer');

    document.body.dispatchEvent(pointer('pointermove', { x: 170, y: 60 }, { buttons: 2, pointerId: 1 }));
    expect(p.shell.session.predictor.walk?.kind).toBe('path');
  });

  it('walks along a path to the ground a quick press lets go on', () => {
    const p = playing();
    const pointer = onCanvas(p);
    const ground = { x: 170, y: 60 };
    const point = p.shell.scene!.groundPointAt(0.7, -0.2)!;

    p.canvas.dispatchEvent(pointer('pointerdown', ground));
    window.dispatchEvent(pointer('pointerup', ground));

    expect(p.shell.session.predictor.walk).toMatchObject({ kind: 'path', destination: { x: point.x, z: point.z } });
  });

  it('drops the press ring on the ground a press lands on and keeps it there while the walk goes on, and on a body a press walks the player to', () => {
    const p = playing();
    const pointer = onCanvas(p);
    const show = vi.spyOn(p.shell.scene!, 'showPressMarker');
    const lift = vi.spyOn(p.shell.scene!, 'liftPressMarker');
    const ground = { x: 170, y: 60 };
    const point = p.shell.scene!.groundPointAt(0.7, -0.2)!;

    p.canvas.dispatchEvent(pointer('pointerdown', ground));
    window.dispatchEvent(pointer('pointerup', ground));
    expect(show.mock.calls).toEqual([[{ x: point.x, z: point.z }]]);
    expect(lift).not.toHaveBeenCalled();

    p.canvas.dispatchEvent(pointer('pointerdown', p.shell.pagePointOf('self')!));
    window.dispatchEvent(pointer('pointerup', p.shell.pagePointOf('self')!));
    p.shell.session.runTick(performance.now());
    expect(lift.mock.calls).toEqual([[]]);

    show.mockClear();
    lift.mockClear();
    p.deliver(entityFrame({ id: 'monster:1', kind: 'monster', x: 12, z: 10 }));
    const ghost = p.shell.pagePointOf('monster:1')!;
    p.canvas.dispatchEvent(pointer('pointerdown', ghost));
    window.dispatchEvent(pointer('pointerup', ghost));
    expect(p.shell.session.target).toBe('monster:1');
    expect(show.mock.calls).toEqual([[{ x: 12, z: 10 }]]);
    expect(lift.mock.calls).toEqual([[]]);
  });

  it('lifts the press ring when a second finger lands', () => {
    const p = playing();
    const pointer = onCanvas(p);
    const lift = vi.spyOn(p.shell.scene!, 'liftPressMarker');
    const finger = (pointerId: number) => ({ pointerType: 'touch', pointerId, isPrimary: pointerId === 1 });

    p.canvas.dispatchEvent(pointer('pointerdown', { x: 170, y: 60 }, finger(1)));
    expect(lift).not.toHaveBeenCalled();
    p.canvas.dispatchEvent(pointer('pointerdown', { x: 190, y: 90 }, finger(2)));

    expect(lift.mock.calls).toEqual([[]]);
  });

  it('steers toward the ground under a press held past the hold', () => {
    let clock = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const p = playing();
    const pointer = onCanvas(p);
    const point = p.shell.scene!.groundPointAt(0.7, -0.2)!;

    p.canvas.dispatchEvent(pointer('pointerdown', { x: 170, y: 60 }));
    p.shell.session.runTick(clock + 100);
    expect(p.shell.session.predictor.walk).toBeUndefined();
    clock += 200;
    p.shell.session.runTick(clock);

    expect(p.shell.session.predictor.walk).toEqual({ kind: 'steer', toward: { x: point.x, z: point.z } });
  });

  it.each(['mouse', 'touch', 'pen'])('taps to walk and holds to steer with a %s alike', (pointerType) => {
    let clock = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const p = playing();
    const pointer = onCanvas(p);
    const ground = { x: 170, y: 60 };
    const point = p.shell.scene!.groundPointAt(0.7, -0.2)!;

    p.canvas.dispatchEvent(pointer('pointerdown', ground, { pointerType, pointerId: 1, isPrimary: true }));
    window.dispatchEvent(pointer('pointerup', ground, { pointerType, pointerId: 1, isPrimary: true }));
    expect(p.shell.session.predictor.walk).toMatchObject({ kind: 'path', destination: { x: point.x, z: point.z } });

    p.canvas.dispatchEvent(pointer('pointerdown', ground, { pointerType, pointerId: 2, isPrimary: true }));
    clock += 200;
    p.shell.session.runTick(clock);
    expect(p.shell.session.predictor.walk).toEqual({ kind: 'steer', toward: { x: point.x, z: point.z } });
  });

  it("walks a tap to where it landed, and steers at once a press that wanders past a tap's slop", () => {
    let clock = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const p = playing();
    const pointer = onCanvas(p);
    const landed = p.shell.scene!.groundPointAt(0.7, -0.2)!;
    const touch = { pointerType: 'touch', pointerId: 1, isPrimary: true };

    p.canvas.dispatchEvent(pointer('pointerdown', { x: 170, y: 60 }, touch));
    window.dispatchEvent(pointer('pointermove', { x: 170 + TAP_SLOP_PX - 1, y: 60 }, { ...touch, buttons: 1 }));
    window.dispatchEvent(pointer('pointerup', { x: 170 + TAP_SLOP_PX - 1, y: 60 }, touch));
    expect(p.shell.session.predictor.walk).toMatchObject({ kind: 'path', destination: { x: landed.x, z: landed.z } });

    p.canvas.dispatchEvent(pointer('pointerdown', { x: 170, y: 60 }, touch));
    window.dispatchEvent(pointer('pointermove', { x: 170 + TAP_SLOP_PX + 1, y: 60 }, { ...touch, buttons: 1 }));
    clock += 50;
    p.shell.session.runTick(clock);
    expect(p.shell.session.predictor.walk?.kind).toBe('steer');
    const letGo = p.shell.scene!.groundPointAt((170 + TAP_SLOP_PX + 1) / 100 - 1, -0.2)!;
    window.dispatchEvent(pointer('pointerup', { x: 170 + TAP_SLOP_PX + 1, y: 60 }, touch));
    expect(p.shell.session.predictor.walk).toMatchObject({ kind: 'path', destination: { x: letGo.x, z: letGo.z } });
  });

  it('zooms with a pinch of two fingers and walks with neither', () => {
    let clock = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const p = playing();
    const pointer = onCanvas(p);
    const finger = (pointerId: number) => ({ pointerType: 'touch', pointerId, isPrimary: pointerId === 1 });

    p.canvas.dispatchEvent(pointer('pointerdown', { x: 170, y: 60 }, finger(1)));
    p.canvas.dispatchEvent(pointer('pointerdown', { x: 180, y: 60 }, finger(2)));
    window.dispatchEvent(pointer('pointermove', { x: 182, y: 60 }, { ...finger(2), buttons: 1 }));
    expect(p.shell.session.zoom.factor).toBeCloseTo(1.2, 9);
    clock += 400;
    p.shell.session.runTick(clock);
    window.dispatchEvent(pointer('pointermove', { x: 175, y: 60 }, { ...finger(2), buttons: 1 }));
    expect(p.shell.session.zoom.factor).toBeLessThan(1);
    window.dispatchEvent(pointer('pointerup', { x: 175, y: 60 }, finger(2)));
    window.dispatchEvent(pointer('pointermove', { x: 150, y: 60 }, { ...finger(1), buttons: 1 }));
    clock += 400;
    p.shell.session.runTick(clock);
    window.dispatchEvent(pointer('pointerup', { x: 150, y: 60 }, finger(1)));

    expect(p.shell.session.predictor.walk).toBeUndefined();
    expect(p.shell.controller.entities.get('self')!.position).toEqual({ x: 10, z: 10 });
  });

  /** The finger left steering would otherwise drag the player after a point it no longer means. */
  it('stops a steer where the player stands when a second finger lands', () => {
    let clock = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const p = playing();
    const pointer = onCanvas(p);
    const finger = (pointerId: number) => ({ pointerType: 'touch', pointerId, isPrimary: pointerId === 1 });
    p.canvas.dispatchEvent(pointer('pointerdown', { x: 170, y: 60 }, finger(1)));
    clock += 200;
    p.shell.session.runTick(clock);
    expect(p.shell.session.predictor.walk?.kind).toBe('steer');

    p.canvas.dispatchEvent(pointer('pointerdown', { x: 190, y: 90 }, finger(2)));
    expect(p.shell.session.predictor.walk).toBeUndefined();
    window.dispatchEvent(pointer('pointerup', { x: 190, y: 90 }, finger(2)));
    window.dispatchEvent(pointer('pointermove', { x: 30, y: 20 }, { ...finger(1), buttons: 1 }));
    clock += 400;
    p.shell.session.runTick(clock);
    window.dispatchEvent(pointer('pointerup', { x: 30, y: 20 }, finger(1)));

    expect(p.shell.session.predictor.walk).toBeUndefined();
  });

  it('walks to the ground under their own body on a tap there, and targets nothing', () => {
    const p = playing();
    const pointer = onCanvas(p);
    p.shell.session.predictor.walkTo({ x: 14, z: 10 });
    const own = p.shell.pagePointOf('self')!;

    p.canvas.dispatchEvent(pointer('pointerdown', own));
    window.dispatchEvent(pointer('pointerup', own));

    const rect = p.canvas.getBoundingClientRect();
    const under = p.shell.scene!.groundPointAt(((own.x - rect.left) / rect.width) * 2 - 1, 1 - ((own.y - rect.top) / rect.height) * 2)!;
    expect(p.shell.session.predictor.walk).toMatchObject({ kind: 'path', destination: { x: expect.closeTo(under.x, 6), z: expect.closeTo(under.z, 6) } });
    expect(p.shell.session.target).toBeUndefined();
  });

  it('aims the player at the point under the cursor at body height', () => {
    const p = playing();
    const pointer = onCanvas(p);
    const at = { x: 30, y: 20 };

    p.canvas.dispatchEvent(pointer('pointermove', at));
    p.shell.session.runTick(performance.now());

    const aim = p.shell.scene!.aimPointAt(-0.7, 0.6)!;
    const ground = p.shell.scene!.groundPointAt(-0.7, 0.6)!;
    const self = p.shell.controller.entities.get('self')!;
    expect(distance(aim, ground)).toBeGreaterThan(0.5);
    expect(self.facing).toBeCloseTo(headingFromVector(aim.x - 10, aim.z - 10), 6);
  });

  it('clears the target on Escape, and opens the menu only on the next', () => {
    const p = playing();
    p.deliver({ tag: 'lucidity', payload: { role: 'healer', ranks: [{ teachingId: 'touch', rank: 1, practice: 0 }] } });
    p.shell.session.selectEntity('bren');
    const escape = (): boolean => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));

    escape();
    expect(p.shell.session.target).toBeUndefined();
    expect(p.shell.controller.presentedOverlay).toBeUndefined();
    escape();
    expect(p.shell.controller.presentedOverlay?.kind).toBe('gameMenu');
  });

  it('stops a walk under way on Escape before it closes a window', () => {
    const p = playing();
    const escape = (): boolean => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    container.querySelector<HTMLButtonElement>('button[aria-label="Players"]')!.click();
    p.shell.session.pressGround({ x: 10, z: 4 }, 0);
    p.shell.session.release({ x: 10, z: 4 });
    expect(p.shell.session.predictor.walk).toMatchObject({ kind: 'path' });

    escape();
    expect([p.shell.session.predictor.walk, p.shell.hud.isWindowOpen('players')]).toEqual([undefined, true]);
    escape();
    expect(p.shell.hud.isWindowOpen('players')).toBe(false);
  });

  it('closes an open chat on Escape before it stops a walk, though its field has lost the keyboard', () => {
    const p = playing();
    const escape = (): boolean => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
    (document.activeElement as HTMLElement).blur();
    p.shell.session.pressGround({ x: 10, z: 4 }, 0);
    p.shell.session.release({ x: 10, z: 4 });
    expect([p.shell.hud.chatOpen, p.shell.controller.isChatInputFocused, p.shell.session.predictor.walk?.kind]).toEqual([true, false, 'path']);

    escape();
    expect([p.shell.hud.chatOpen, p.shell.session.predictor.walk?.kind]).toEqual([false, 'path']);
    escape();
    expect(p.shell.session.predictor.walk).toBeUndefined();
  });

  it("closes a carrier's panel on Escape after the windows and before the target", () => {
    const p = playing();
    const escape = (): boolean => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    p.shell.session.pressEntity(PUGNAX);
    // The walk runs out first, since Escape would stop a walk under way before closing anything.
    for (let time = 0; time <= 4000 && p.shell.session.predictor.walk !== undefined; time += 50) p.shell.session.runTick(time);
    container.querySelector<HTMLButtonElement>('button[aria-label="Players"]')!.click();
    const state = () => [p.shell.hud.isWindowOpen('players'), p.shell.session.servicePanel?.id, p.shell.session.target];
    expect(state()).toEqual([true, PUGNAX, PUGNAX]);

    escape();
    expect(state()).toEqual([false, PUGNAX, PUGNAX]);
    escape();
    expect(state()).toEqual([false, undefined, PUGNAX]);
    expect(container.querySelector('.service-panel')!.classList.contains('hidden')).toBe(true);
    escape();
    expect(state()).toEqual([false, undefined, undefined]);
  });

  it('closes the chat, then the newest window, then clears the target, and only then opens the menu on Escape', () => {
    const p = playing();
    const escape = (): boolean => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    const label = (name: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!;
    p.shell.session.selectEntity('bren');
    label('Players').click();
    label('Character').click();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
    const state = () => [
      p.shell.hud.chatOpen,
      p.shell.hud.isWindowOpen('players'),
      p.shell.hud.isWindowOpen('character'),
      p.shell.session.target,
      p.shell.controller.presentedOverlay?.kind,
    ];
    expect(state()).toEqual([true, true, true, 'bren', undefined]);
    expect(p.shell.controller.isChatInputFocused).toBe(true);

    escape();
    expect(state()).toEqual([false, true, true, 'bren', undefined]);
    expect(p.shell.controller.isChatInputFocused).toBe(false);
    escape();
    expect(state()).toEqual([false, true, false, 'bren', undefined]);
    escape();
    expect(state()).toEqual([false, false, false, 'bren', undefined]);
    escape();
    expect(state()).toEqual([false, false, false, undefined, undefined]);
    escape();
    expect(state()).toEqual([false, false, false, undefined, 'gameMenu']);
  });

  it('opens and closes the Character window on C and on I while the world has the keyboard, and not while the chat has it or with a modifier', () => {
    const p = playing();
    const press = (key: string, init: KeyboardEventInit = {}): boolean =>
      window.dispatchEvent(new KeyboardEvent('keydown', { key, cancelable: true, ...init }));
    press('c');
    expect(p.shell.hud.isWindowOpen('character')).toBe(true);
    press('I');
    expect(p.shell.hud.isWindowOpen('character')).toBe(false);
    press('i', { metaKey: true });
    press('c', { ctrlKey: true });
    expect(p.shell.hud.isWindowOpen('character')).toBe(false);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
    expect(p.shell.controller.isChatInputFocused).toBe(true);
    press('c');
    expect(p.shell.hud.isWindowOpen('character')).toBe(false);
  });

  it('opens and closes the Players window on O while the world has the keyboard, and not while the chat has it or with a modifier', () => {
    const p = playing();
    const press = (key: string, init: KeyboardEventInit = {}): boolean =>
      window.dispatchEvent(new KeyboardEvent('keydown', { key, cancelable: true, ...init }));
    press('o');
    expect([p.shell.hud.isWindowOpen('players'), p.shell.hud.isWindowOpen('character')]).toEqual([true, false]);
    press('O');
    expect(p.shell.hud.isWindowOpen('players')).toBe(false);
    press('o', { metaKey: true });
    press('o', { ctrlKey: true });
    press('o', { altKey: true });
    expect(p.shell.hud.isWindowOpen('players')).toBe(false);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
    expect(p.shell.controller.isChatInputFocused).toBe(true);
    press('o');
    expect(p.shell.hud.isWindowOpen('players')).toBe(false);
  });

  it('opens the chat on Enter while the world has the keyboard, and not while a control or an overlay has it', () => {
    const p = playing();
    const enter = (target: EventTarget = window): boolean =>
      target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    const run = container.querySelector<HTMLButtonElement>('button[aria-label="Run"]')!;

    enter(run);
    expect(p.shell.hud.chatOpen).toBe(false);
    p.shell.controller.presentedOverlay = { kind: 'gameMenu' };
    enter();
    expect(p.shell.hud.chatOpen).toBe(false);
    p.shell.controller.presentedOverlay = undefined;
    enter();
    expect(p.shell.hud.chatOpen).toBe(true);
    expect(document.activeElement).toBe(p.shell.hud.chatInput);

    // Shift types into the open field rather than toggling Run.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', code: 'ShiftLeft', cancelable: true }));
    expect(p.shell.session.running).toBe(false);
    p.shell.hud.chatInput.value = 'hallo';
    p.shell.hud.chatInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(p.sent()).toContainEqual({ tag: 'clientSay', payload: { text: 'hallo', kind: 'say' } });
    expect([p.shell.hud.chatOpen, p.shell.controller.isChatInputFocused]).toEqual([false, false]);
  });

  it('opens the game menu from Settings, and shows the world clock and where the player stands', () => {
    const p = playing();
    const clock = container.querySelector('.hud-clock')!;
    expect(clock.querySelector('.hud-clock__place')?.textContent).toBe('Meadow');
    // `enterSpaceFrame` starts the world at 00:00 on its first day.
    expect(clock.querySelector('.hud-clock__time')?.textContent).toBe('☾00:00');
    container.querySelector<HTMLButtonElement>('button[aria-label="Settings"]')!.click();
    expect(p.shell.controller.presentedOverlay?.kind).toBe('gameMenu');
  });

  describe('the slot 1 toggle', () => {
    const GHOST = 'monster:1';
    const engageButton = (): HTMLButtonElement => container.querySelector<HTMLButtonElement>('.hud-slot--act')!;
    const named = (node: HTMLElement): string | null => node.getAttribute('aria-label');
    const pressOne = (init: KeyboardEventInit = {}): boolean =>
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '1', code: 'Digit1', cancelable: true, ...init }));
    const engages = (p: ReturnType<typeof playing>) => p.sent().flatMap((message) => (message.tag === 'engage' ? [message.payload] : []));

    function withGhost() {
      const p = playing();
      p.deliver(entityFrame({ id: GHOST, kind: 'monster', name: 'Ghost', x: 12, z: 10 }));
      return p;
    }

    /** A Healer with the Moonstone in the off hand and the main hand empty, beside Bren and a Ghost. */
    function healing() {
      const p = withGhost();
      p.deliver({ tag: 'lucidity', payload: { role: 'healer', ranks: [{ teachingId: 'touch', rank: 1, practice: 0 }] } });
      p.deliver(inventoryFrame(carrying({ worn: [item('moonstone')] })));
      return p;
    }

    it('leads the belt as Attack, the gaze lock and Run at its end, greyed out until it can act on the target', () => {
      const p = withGhost();
      expect([...container.querySelectorAll<HTMLElement>('.hud-slots button')].map(named)).toEqual(['Attack', 'Lock facing', 'Run']);
      expect(engageButton().disabled).toBe(true);
      expect(engageButton().getAttribute('aria-pressed')).toBe('false');
      p.shell.session.selectEntity(PUGNAX);
      expect(engageButton().disabled).toBe(true);
      p.shell.session.selectEntity('bren');
      expect(engageButton().disabled).toBe(true);
      p.shell.session.selectEntity(GHOST);
      expect(engageButton().disabled).toBe(false);
    });

    it('leaves the gaze lock to its own button and the F key, under the same gates as the 1 key, greyed out with nothing to lock on', () => {
      const p = withGhost();
      const lock = container.querySelector<HTMLButtonElement>('.hud-slot--lock')!;
      const pressF = (init: KeyboardEventInit = {}): boolean =>
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', code: 'KeyF', cancelable: true, ...init }));
      expect(lock.disabled).toBe(true);
      pressF();
      expect(p.shell.session.gazeLocked).toBe(false);

      p.shell.session.selectEntity(GHOST);
      expect(lock.disabled).toBe(false);
      pressF();
      expect([p.shell.session.gazeLocked, p.shell.session.engaged, lock.getAttribute('aria-pressed')]).toEqual([true, false, 'true']);
      pressF({ ctrlKey: true });
      expect(p.shell.session.gazeLocked).toBe(true);
      lock.click();
      expect([p.shell.session.gazeLocked, lock.getAttribute('aria-pressed')]).toEqual([false, 'false']);
      p.shell.controller.setChatInputFocused(true);
      pressF();
      expect(p.shell.session.gazeLocked).toBe(false);
      expect(engages(p)).toEqual([]);
    });

    it('is named for what it does at the target, Mend at a dreamer and Attack at a nightmare for a Healer with the Moonstone, keeping its look greyed out and its element', () => {
      const p = healing();
      const before = engageButton();
      p.shell.session.selectEntity('bren');
      expect([named(engageButton()), engageButton().disabled]).toEqual(['Mend', false]);
      p.shell.session.selectEntity(GHOST);
      expect([named(engageButton()), engageButton().disabled]).toEqual(['Attack', false]);
      p.shell.session.pressOwnFrame();
      expect(named(engageButton())).toBe('Mend');
      p.deliver({ tag: 'condition', payload: { entityId: 'bren', condition: 'fallen' } });
      p.shell.session.selectEntity('bren');
      expect([named(engageButton()), engageButton().dataset['look']]).toEqual(['Raise', 'raise']);
      p.shell.session.select(undefined);
      expect([named(engageButton()), engageButton().disabled]).toEqual(['Raise', true]);
      expect(engageButton()).toBe(before);
    });

    it('toggles on key 1, with Shift held too but never with Alt, Ctrl, or Cmd, and on a click, lit while on', () => {
      const p = withGhost();
      p.shell.session.selectEntity(GHOST);
      pressOne();
      expect(engageButton().getAttribute('aria-pressed')).toBe('true');
      pressOne({ repeat: true });
      for (const modifier of ['altKey', 'ctrlKey', 'metaKey']) pressOne({ [modifier]: true });
      expect(p.shell.session.engaged).toBe(true);
      pressOne({ key: '!', shiftKey: true });
      expect(engageButton().getAttribute('aria-pressed')).toBe('false');
      engageButton().click();
      expect(engageButton().getAttribute('aria-pressed')).toBe('true');
      engageButton().click();
      expect(engages(p)).toEqual([{ on: true }, { on: false }, { on: true }, { on: false }]);
    });

    it('switches Run on Shift, but not on Shift with Alt, Ctrl, or Cmd held, a chord of the system', () => {
      const p = playing();
      const shift = (init: KeyboardEventInit = {}): boolean =>
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', code: 'ShiftLeft', cancelable: true, ...init }));
      for (const modifier of ['altKey', 'ctrlKey', 'metaKey']) shift({ [modifier]: true, shiftKey: true });
      expect(p.shell.session.running).toBe(false);
      shift({ shiftKey: true });
      expect(p.shell.session.running).toBe(true);
    });

    it('stays on from a dreamer to a nightmare for a Healer with the Moonstone, turning from Mend to Attack and keeping its element', () => {
      const p = healing();
      const before = engageButton();
      p.shell.session.selectEntity('bren');
      pressOne();
      p.shell.session.selectEntity(GHOST);
      p.shell.session.runTick(performance.now());
      expect([named(engageButton()), engageButton().getAttribute('aria-pressed'), engageButton().disabled]).toEqual(['Attack', 'true', false]);
      pressOne();
      expect(engageButton()).toBe(before);
      expect(engages(p)).toEqual([{ on: true }, { on: false }]);
    });

    it.each<[string, (p: ReturnType<typeof playing>) => void]>([
      ['an overlay is up', (p) => (p.shell.controller.presentedOverlay = { kind: 'gameMenu' })],
      ['the chat input has focus', (p) => p.shell.hud.chatInput.dispatchEvent(new FocusEvent('focus'))],
    ])('leaves slot 1 alone on key 1 while %s', (_label, arrange) => {
      const p = withGhost();
      p.shell.session.selectEntity(GHOST);
      arrange(p);
      pressOne();
      expect(p.shell.session.engaged).toBe(false);
      expect(engages(p)).toEqual([]);
    });

    it('goes off and greys out with the target', () => {
      const p = withGhost();
      p.shell.session.selectEntity(GHOST);
      pressOne();
      p.deliver({ tag: 'leave', payload: { entityId: GHOST, leftGame: false } });
      p.shell.session.runTick(performance.now());
      expect(engageButton().getAttribute('aria-pressed')).toBe('false');
      expect(engageButton().disabled).toBe(true);
    });

    it('keeps its element across energy frames', () => {
      const p = withGhost();
      p.shell.session.selectEntity(GHOST);
      const before = engageButton();
      for (const balanceCurrent of [90, 91, 92]) p.deliver({ tag: 'energy', payload: { ...fullPools(NO_STATS), balanceCurrent } });
      pressOne();
      expect(engageButton()).toBe(before);
    });
  });

  describe('the ability slots', () => {
    const pressKey = (digit: number, init: KeyboardEventInit = {}): boolean =>
      window.dispatchEvent(new KeyboardEvent('keydown', { key: String(digit), code: `Digit${digit}`, cancelable: true, ...init }));
    const uses = (p: ReturnType<typeof playing>) => p.sent().flatMap((message) => (message.tag === 'useAbility' ? [message.payload.abilityId] : []));
    const brace = (): HTMLButtonElement => container.querySelector<HTMLButtonElement>('button[aria-label="Brace"]')!;

    /** A Fighter who has learned Brace. */
    function bracing() {
      const p = playing();
      p.deliver({
        tag: 'lucidity',
        payload: {
          role: 'fighter',
          ranks: [
            { teachingId: 'strike', rank: 1, practice: 0 },
            { teachingId: 'guard', rank: 1, practice: 0 },
            { teachingId: 'brace', rank: 1, practice: 0 },
          ],
        },
      });
      return p;
    }

    it('follows slot 1 on the belt and uses its ability on its key, ignoring a held key, one with Alt, Ctrl, or Cmd, and a key with no ability', () => {
      const p = bracing();
      expect([...container.querySelectorAll<HTMLElement>('.hud-slots button')].map((node) => node.getAttribute('aria-label'))).toEqual([
        'Attack',
        'Brace',
        'Lock facing',
        'Run',
      ]);
      for (const modifier of ['altKey', 'ctrlKey', 'metaKey']) pressKey(2, { [modifier]: true });
      expect(uses(p)).toEqual([]);
      pressKey(2);
      pressKey(2, { repeat: true });
      pressKey(3);
      expect(uses(p)).toEqual(['brace']);
      // Its answer frees the belt for a click.
      p.deliver({ tag: 'cooldowns', payload: { globalSeconds: 0, cooldowns: [] } });
      brace().click();
      expect(uses(p)).toEqual(['brace', 'brace']);
    });

    it.each<[string, (p: ReturnType<typeof playing>) => void]>([
      ['an overlay is up', (p) => (p.shell.controller.presentedOverlay = { kind: 'gameMenu' })],
      ['the chat input has focus', (p) => p.shell.hud.chatInput.dispatchEvent(new FocusEvent('focus'))],
    ])('uses nothing on its key while %s', (_label, arrange) => {
      const p = bracing();
      arrange(p);
      pressKey(2);
      expect(uses(p)).toEqual([]);
    });

    it('sweeps while the cooldown the server sent runs, keeping its element across energy frames', () => {
      const p = bracing();
      const before = brace();
      p.deliver({ tag: 'cooldowns', payload: { globalSeconds: 0.75, cooldowns: [{ abilityId: 'brace', seconds: 15 }] } });
      const sweep = before.querySelector('.hud-sweep');
      expect([before.disabled, sweep?.classList.contains('hidden')]).toEqual([true, false]);
      for (const balanceCurrent of [90, 91, 92]) p.deliver({ tag: 'energy', payload: { ...fullPools(NO_STATS), balanceCurrent } });
      pressKey(2);
      expect(uses(p)).toEqual([]);
      expect(brace()).toBe(before);
      expect(before.querySelector('.hud-sweep')).toBe(sweep);
    });
  });

  describe('the target frame', () => {
    const GHOST = 'monster:1';
    const frames = (): HTMLElement[] => [...container.querySelectorAll<HTMLElement>('.hud-unit--target')];
    const shown = (): { name: string | null | undefined; health: string | undefined }[] =>
      frames()
        .filter((frame) => !frame.classList.contains('hidden'))
        .map((frame) => ({
          name: frame.querySelector('.hud-unit__name')?.textContent,
          health: frame.querySelector<HTMLElement>('.hud-bar__fill')?.style.width,
        }));

    /** A Healer targeting a Ghost to the south-east. */
    function healing() {
      const p = playing();
      p.deliver({ tag: 'lucidity', payload: { role: 'healer', ranks: [{ teachingId: 'touch', rank: 1, practice: 0 }] } });
      p.deliver(entityFrame({ id: GHOST, kind: 'monster', name: 'Ghost', x: 12, z: 11 }));
      return p;
    }

    it('selects the body a press lands on and shows its frame, from its condition until the server sends its health', () => {
      const p = healing();
      const pointer = onCanvas(p);
      expect(shown()).toEqual([]);

      p.canvas.dispatchEvent(pointer('pointerdown', p.shell.pagePointOf(GHOST)!));
      window.dispatchEvent(pointer('pointerup', p.shell.pagePointOf(GHOST)!));
      expect(p.sent()).toContainEqual({ tag: 'target', payload: { targetId: GHOST } });
      expect(shown()).toEqual([{ name: 'Ghost', health: '100.00%' }]);

      p.deliver({ tag: 'condition', payload: { entityId: GHOST, condition: 'wounded' } });
      p.deliver({ tag: 'vitals', payload: { entityId: GHOST, health: 0.42 } });
      expect(shown()).toEqual([{ name: 'Ghost', health: '42.00%' }]);
    });

    it('frames the dreamer a press on the name in the Players list targets, in place of the target before', () => {
      const p = healing();
      p.shell.session.selectEntity(GHOST);
      p.press('Bren');
      expect(p.shell.session.target).toBe('bren');

      p.deliver({ tag: 'vitals', payload: { entityId: GHOST, health: 0.9 } });
      p.deliver({ tag: 'vitals', payload: { entityId: 'bren', health: 0.35 } });
      expect(shown()).toEqual([{ name: 'Bren', health: '35.00%' }]);
      expect(frames().map((frame) => frame.querySelector('.hud-unit__caption')?.textContent)).toEqual(['Target']);
    });

    it("clears the target on a press at its frame's ✕", () => {
      const p = healing();
      p.shell.session.selectEntity(GHOST);
      frames()[0]!.querySelector<HTMLButtonElement>('button[aria-label="Clear target"]')!.click();
      expect(p.shell.session.target).toBeUndefined();
      expect(p.sent().at(-1)).toEqual({ tag: 'target', payload: {} });
      expect(shown()).toEqual([]);
    });

    it('keeps its elements and the names in the Players list across energy and vitals frames that change nothing they show', () => {
      const p = healing();
      p.shell.session.selectEntity(GHOST);
      p.deliver({ tag: 'vitals', payload: { entityId: GHOST, health: 0.5 } });
      const elements = (): Element[] => [
        ...frames().flatMap((frame) => [frame, ...frame.querySelectorAll('*')]),
        ...container.querySelectorAll('.hud-list--players button'),
      ];
      const before = elements();

      for (const balanceCurrent of [90, 91, 92]) p.deliver({ tag: 'energy', payload: { ...fullPools(NO_STATS), balanceCurrent } });
      p.deliver({ tag: 'vitals', payload: { entityId: GHOST, health: 0.5 } });
      p.deliver({ tag: 'vitals', payload: { entityId: GHOST, health: 0.4 } });

      expect(elements()).toHaveLength(before.length);
      elements().forEach((node, index) => expect(node).toBe(before[index]));
      expect(shown()[0]?.health).toBe('40.00%');
    });

    it("names the target's condition and the lock in the frame's accessible name alone, keeping its elements through the lock and its end", () => {
      const p = healing();
      const label = (): string | null => frames()[0]!.getAttribute('aria-label');
      const elements = (): Element[] => frames().flatMap((frame) => [frame, ...frame.querySelectorAll('*')]);
      p.shell.session.selectEntity(GHOST);
      const before = elements();
      const text = frames()[0]!.textContent;
      expect(label()).toBe('Target, hale');

      p.shell.session.pressEntity(GHOST);
      expect(label()).toBe('Target, hale, facing locked');
      expect(frames()[0]!.textContent).toBe(text);
      for (const balanceCurrent of [90, 91]) p.deliver({ tag: 'energy', payload: { ...fullPools(NO_STATS), balanceCurrent } });
      p.deliver({ tag: 'condition', payload: { entityId: GHOST, condition: 'failing' } });
      p.deliver({ tag: 'vitals', payload: { entityId: GHOST, health: 0.2 } });
      expect(label()).toBe('Target, failing, facing locked');
      p.shell.session.toggleGazeLock();
      expect(label()).toBe('Target, failing');
      elements().forEach((node, index) => expect(node).toBe(before[index]));
      expect(elements()).toHaveLength(before.length);
    });

    it('targets the player on a press at their own frame, or their own name in Players, framed from their own energy, Healer or not', () => {
      const p = playing();
      const own = container.querySelector<HTMLButtonElement>('.hud-unit--self')!;
      p.deliver({ tag: 'energy', payload: { ...fullPools(NO_STATS), healthCurrent: 30 } });
      own.querySelector<HTMLElement>('.hud-unit__name')!.click();
      expect(p.shell.session.target).toBe('self');
      expect(own.getAttribute('aria-pressed')).toBe('true');
      expect(own.querySelector('.hud-unit__name')?.textContent).toBe('Tester');
      expect(shown()).toEqual([{ name: 'Tester', health: '30.00%' }]);
      expect(p.sent()).toEqual([{ tag: 'target', payload: { targetId: 'self' } }]);

      container.querySelector<HTMLButtonElement>('button[aria-label="Run"]')!.click();
      expect(p.sent()).toHaveLength(1);

      p.shell.session.select(undefined);
      expect(own.getAttribute('aria-pressed')).toBe('false');
      p.deliver({ tag: 'lucidity', payload: { role: 'healer', ranks: [{ teachingId: 'touch', rank: 1, practice: 0 }] } });
      expect(own.querySelector('.hud-unit__traits')?.textContent).toBe('Vigils · Healer');
      p.press('Tester');
      expect(p.shell.session.target).toBe('self');
      expect(shown()).toEqual([{ name: 'Tester', health: '30.00%' }]);
      expect(frames().map((frame) => frame.querySelector('.hud-unit__caption')?.textContent)).toEqual(['Target']);
    });

    it('gives way to the fallen notice while the player lies fallen', () => {
      const p = healing();
      p.shell.session.selectEntity(GHOST);
      p.deliver({ tag: 'condition', payload: { entityId: 'self', condition: 'fallen' } });
      expect(shown()).toEqual([]);
      p.deliver({ tag: 'condition', payload: { entityId: 'self', condition: 'grazed' } });
      expect(shown().map((frame) => frame.name)).toEqual(['Ghost']);
    });
  });

  it("sends each of a master's buttons as the request it names, from taking the trial to turning it in and studying a teaching, as the quests frame feeds the panel", () => {
    const p = playing();
    const panel = container.querySelector('.service-panel')!;
    expect(panel.classList.contains('hidden')).toBe(true);
    p.shell.session.pressEntity(PUGNAX);
    expect(panel.classList.contains('hidden')).toBe(false);

    p.press('Ask for the trial');
    p.deliver({ tag: 'quests', payload: { active: [{ questId: 'fighter-trial', progress: [0] }], done: [], bounties: [] } });
    expect(panel.textContent).toContain('Drive off a nightmare. 0 of 1');
    p.deliver({ tag: 'quests', payload: { active: [{ questId: 'fighter-trial', progress: [1] }], done: [], bounties: [] } });
    p.press('Become a Fighter');
    p.deliver({ tag: 'quests', payload: { active: [], done: ['fighter-trial'], bounties: [] } });
    p.deliver({ tag: 'lucidity', payload: { role: 'fighter', ranks: [{ teachingId: 'strike', rank: 1, practice: 0 }], study: 'strike' } });
    expect(container.querySelector('.hud-study')?.textContent).toBe('Studying Strike · 0%');
    (panel.querySelector('[data-teaching="toughening"] button') as HTMLButtonElement).click();

    // The `interact` sends the player's position before it, which is no request to the master.
    expect(p.sent().filter((message) => message.tag !== 'move')).toEqual([
      { tag: 'target', payload: { targetId: PUGNAX } },
      { tag: 'interact', payload: { carrierId: PUGNAX } },
      { tag: 'acceptQuest', payload: { carrierId: PUGNAX, questId: 'fighter-trial' } },
      { tag: 'turnInQuest', payload: { carrierId: PUGNAX, questId: 'fighter-trial' } },
      { tag: 'study', payload: { carrierId: PUGNAX, teachingId: 'toughening' } },
    ]);
    p.press('Close');
    expect(panel.classList.contains('hidden')).toBe(true);
  });

  it('gives a quest up from the master who gave it and from the Quest log, which L opens and closes', () => {
    const p = playing();
    p.deliver({ tag: 'quests', payload: { active: [{ questId: 'fighter-trial', progress: [0] }], done: [], bounties: [] } });
    p.shell.session.pressEntity(PUGNAX);
    p.press('Give up the trial');
    const press = (key: string): boolean => window.dispatchEvent(new KeyboardEvent('keydown', { key, cancelable: true }));
    press('l');
    expect(p.shell.hud.isWindowOpen('quests')).toBe(true);
    container.querySelector<HTMLButtonElement>(`.hud-window--quests button[aria-label="Give up The Fighters' trial"]`)!.click();
    press('L');
    expect(p.shell.hud.isWindowOpen('quests')).toBe(false);
    expect(p.sent().filter((message) => message.tag === 'abandonQuest')).toEqual([
      { tag: 'abandonQuest', payload: { questId: 'fighter-trial' } },
      { tag: 'abandonQuest', payload: { questId: 'fighter-trial' } },
    ]);
  });

  it("sends the shopkeeper's buttons as the trades they name, and holds them from a trade until a moment after its answer", () => {
    let clock = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const p = playing();
    const cudgel = item('cudgel');
    const dagger = item('dagger');
    p.deliver(entityFrame({ id: MERCUS, kind: 'npc', name: 'Mercus', x: 9, z: 9, service: 'shopkeeper' }));
    p.deliver(inventoryFrame(carrying({ coins: 100, bag: [cudgel] })));
    p.shell.session.pressEntity(MERCUS);
    const panel = container.querySelector('.service-panel')!;
    const action = (ware: string): HTMLButtonElement => panel.querySelector(`[data-ware="${ware}"] button`)!;

    p.press('Buy for 60c');
    expect(action('cudgel').disabled).toBe(true);
    p.deliver(inventoryFrame(carrying({ coins: 40, bag: [cudgel, dagger] }), { trade: { kind: 'bought', baseId: 'dagger', rarity: 'plain', coins: 60 } }));
    clock += 600;
    p.shell.session.runTick(clock);
    expect(action('cudgel').disabled).toBe(false);
    p.press('Sell for 10c');

    // The tick reports the player's position too, which is no trade.
    expect(p.sent().filter((message) => message.tag !== 'move')).toEqual([
      { tag: 'target', payload: { targetId: MERCUS } },
      { tag: 'interact', payload: { carrierId: MERCUS } },
      { tag: 'buy', payload: { carrierId: MERCUS, baseId: 'dagger' } },
      { tag: 'sell', payload: { carrierId: MERCUS, itemId: cudgel.id } },
    ]);
  });

  it("counts a fallen player's raise down on the notice frame by frame, between the server's snapshots", () => {
    let clock = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const p = playing();
    const frame = (): void => (p.shell as unknown as { onFrame(timestamp: number): void }).onFrame(clock);
    const notice = container.querySelector('.fallen-notice')!;
    p.deliver({ tag: 'condition', payload: { entityId: 'self', condition: 'fallen' } });
    p.deliver({ tag: 'raising', payload: { targetId: 'self', healerIds: ['bren'], state: 'holding', progress: 0, seconds: 6 } });
    frame();
    expect(notice.textContent).toContain('Bren is drawing you back: 6 s');
    clock += 1001;
    frame();
    expect(notice.textContent).toContain('Bren is drawing you back: 5 s');
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
