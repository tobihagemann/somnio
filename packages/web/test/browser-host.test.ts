import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GameplaySession, PlayerZoom } from '@/client';
import { PLACEHOLDER_REGISTRY } from '@somnio/core';
import { ORTHO_RIG, PLAYER_ZOOM, WHEEL_NOTCH, frustumBounds, wheelDeltaToZoomDelta } from '@/scene/cameraRig';
import { WorldScene } from '@/scene/worldScene';
import { AppShell, element } from '@/ui';
import type { ModelAssets } from '@/scene/modelAssets';

/**
 * Browser-host correctness: a hidden tab, a lost window focus, Esc colliding with the browser's
 * fullscreen handling, and a resize that must not change how much world is visible.
 */

function emptyAssets(): ModelAssets {
  return {
    prewarm: async () => {},
    character: () => undefined,
    object: () => undefined,
    clipsFor: () => [],
    prototypeMeshes: () => undefined,
  };
}

/**
 * Reads the presented overlay through a call so TypeScript does not narrow the field to `undefined`
 * after a test assigns it — the assignment is the arrangement, and the read is what is asserted.
 */
function currentOverlay(app: AppShell): string | undefined {
  return app.controller.presentedOverlay?.kind;
}

describe('scroll zoom', () => {
  it('inverts the DOM wheel sign so scrolling up zooms in', () => {
    const zoom = new PlayerZoom();

    // The shell negates `deltaY` before this call, so a raw negative delta here means "scroll up"
    // and has to magnify.
    zoom.applyScroll(10);

    expect(zoom.factor).toBeGreaterThan(1);
  });

  it('clamps at both ends and reports when nothing moved', () => {
    const zoom = new PlayerZoom();
    for (let index = 0; index < 200; index += 1) zoom.applyScroll(50);

    const moved = zoom.applyScroll(50);

    expect(zoom.factor).toBe(PLAYER_ZOOM.maxFactor);
    expect(moved).toBe(false);
  });

  /**
   * `PLAYER_ZOOM.scrollGain` is sized for a few delta units per notch. Chrome and Safari on macOS
   * report ~100 px for the same notch, and `exp(100 * 0.015)`
   * is 4.5x against a range of only 1.8x, so an unconverted delta pins the camera at a stop on the
   * first notch with nothing in between. Converting the scale is as load-bearing as the sign.
   */
  it('takes many notches to cross the zoom range rather than one', () => {
    const session = () =>
      new GameplaySession({
        controller: new AppShell({
          container: element('div'),
          capabilities: { hasWebGL: false },
        }).controller,
        send: () => {},
        measureText: (line) => line.length * 5,
      });

    const zoomIn = session();
    let notches = 0;
    while (zoomIn.zoom.applyScroll(-wheelDeltaToZoomDelta(-WHEEL_NOTCH.pixels, 0))) notches += 1;
    expect(zoomIn.zoom.factor).toBe(PLAYER_ZOOM.maxFactor);
    // ~6 notches from the default factor to the stop, ~10 across the full range. What matters is
    // that a player can stop part-way; one notch reaching a stop is the regression.
    expect(notches).toBeGreaterThan(4);

    const single = session();
    single.applyScrollZoom(-WHEEL_NOTCH.pixels, 0);
    expect(single.zoom.factor).toBeGreaterThan(1);
    expect(single.zoom.factor).toBeLessThan(PLAYER_ZOOM.maxFactor);
  });

  it('reads Firefox line deltas at the same scale as Chrome pixel deltas', () => {
    const controller = new AppShell({
      container: element('div'),
      capabilities: { hasWebGL: false },
    }).controller;
    const make = () =>
      new GameplaySession({
        controller,
        send: () => {},
        measureText: (line) => line.length * 5,
      });

    const pixels = make();
    pixels.applyScrollZoom(-WHEEL_NOTCH.pixels, 0);
    const lines = make();
    // `deltaMode` 1 is DOM_DELTA_LINE. Ignoring it makes one Firefox notch a 3-unit delta and the
    // wheel barely responds at all — the opposite failure to Chrome's.
    lines.applyScrollZoom(-WHEEL_NOTCH.lines, 1);

    expect(lines.zoom.factor).toBeCloseTo(pixels.zoom.factor, 10);
  });
});

describe('the resize invariant', () => {
  it('holds the vertical world extent constant and lets aspect drive width', () => {
    const scene = new WorldScene(emptyAssets(), PLACEHOLDER_REGISTRY, 1, false);
    const tallTop = scene.camera.top;
    const tallHeight = scene.camera.top - scene.camera.bottom;

    scene.setViewportSize(2500, 1000);

    // A deliberate gameplay contract: every window size shows the
    // same vertical world extent, so a bigger window magnifies rather than reveals. Tying the
    // frustum to pixel height would silently hand large-window players more visible world.
    expect(scene.camera.top).toBe(tallTop);
    expect(scene.camera.top - scene.camera.bottom).toBe(tallHeight);
    expect(scene.camera.right - scene.camera.left).toBeCloseTo(tallHeight * 2.5, 10);
  });

  it('keeps the camera scale untouched by a resize', () => {
    const scene = new WorldScene(emptyAssets(), PLACEHOLDER_REGISTRY, 1, false);
    const before = scene._cameraScale();

    scene.setViewportSize(400, 1000);

    expect(scene._cameraScale()).toBe(before);
  });

  it('maps scale as a half-height, not a full extent', () => {
    const bounds = frustumBounds(ORTHO_RIG.defaultScale, 1);

    // A 2x framing discrepancy means `scale` was treated as a full
    // height and halved again by the usual Three.js `frustumSize / 2` idiom.
    expect(bounds.top).toBe(ORTHO_RIG.defaultScale);
    expect(bounds.top - bounds.bottom).toBe(2 * ORTHO_RIG.defaultScale);
  });
});

describe('host handlers', () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = element('div');
    document.body.append(container);
  });

  afterEach(() => {
    container.remove();
  });

  function shell(): AppShell {
    return new AppShell({
      container,
      capabilities: { hasWebGL: true },
      startRendering: false,
    });
  }

  function pressEscape(): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    window.dispatchEvent(event);
    return event;
  }

  it('does not open the game menu from the login overlay', () => {
    const app = shell();

    pressEscape();

    // There is nothing behind the login overlay to resume to.
    expect(currentOverlay(app)).toBe('login');
  });

  it('opens the game menu during a live session', () => {
    const app = shell();
    app.controller.presentedOverlay = undefined;
    app.controller.connectionState = 'attached';

    pressEscape();

    expect(currentOverlay(app)).toBe('gameMenu');
  });

  it('resumes the game from the game menu', () => {
    const app = shell();
    app.controller.connectionState = 'attached';
    app.controller.presentedOverlay = { kind: 'gameMenu' };

    pressEscape();

    expect(currentOverlay(app)).toBeUndefined();
  });

  /**
   * `handleEscape` routes each overlay to what sits behind it, not to nothing. Backing About or
   * Options out to the world skips the menu they were opened from, and backing registration or a
   * version skew out to nothing leaves a session-less client with no way back to the login form.
   */
  it.each([
    { overlay: { kind: 'about' } as const, attached: true, expected: 'gameMenu' },
    { overlay: { kind: 'options' } as const, attached: true, expected: 'gameMenu' },
    { overlay: { kind: 'about' } as const, attached: false, expected: 'login' },
    { overlay: { kind: 'registration' } as const, attached: false, expected: 'login' },
    {
      overlay: { kind: 'updateRequired', skew: 'clientOutdated' } as const,
      attached: false,
      expected: 'login',
    },
  ])('backs $overlay.kind out to $expected (attached: $attached)', ({ overlay, attached, expected }) => {
    const app = shell();
    app.controller.connectionState = attached ? 'attached' : 'disconnected';
    app.controller.presentedOverlay = overlay;

    pressEscape();

    expect(currentOverlay(app)).toBe(expected);
  });

  it('closes the chat instead of opening the menu behind it', () => {
    const app = shell();
    app.controller.connectionState = 'attached';
    app.controller.presentedOverlay = undefined;
    app.hud.openChat();
    expect(app.controller.isChatInputFocused).toBe(true);

    pressEscape();

    // `handleEscape` returns right after closing the chat, so the menu must not appear. The field
    // has to give up focus too, or Esc would leave the keyboard with the chat and the menu out of reach.
    expect(app.controller.isChatInputFocused).toBe(false);
    expect(app.hud.chatOpen).toBe(false);
    expect(currentOverlay(app)).toBeUndefined();
  });

  it('consumes Esc so the browser does not act on it first', () => {
    const app = shell();
    app.controller.presentedOverlay = undefined;
    app.controller.connectionState = 'attached';

    // Fullscreen is never entered automatically precisely because the browser would claim Esc for
    // "exit fullscreen" before the menu ever saw it.
    expect(pressEscape().defaultPrevented).toBe(true);
  });

  /** A long press on a touch screen opens the browser's menu with this, over a finger that is steering. */
  it('keeps the browser menu off the play field', () => {
    shell();
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });

    container.querySelector('canvas')!.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });

  /** A live session standing in the world, steering toward a held pointer. */
  function steering(): AppShell {
    const app = shell();
    app.controller.presentedOverlay = undefined;
    app.controller.connectionState = 'attached';
    app.session.predictor.steerToward({ x: 5, z: 5 });
    return app;
  }

  it('lets go of a held press when the tab is hidden', () => {
    const app = steering();

    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    // Restored immediately: the property is redefined on the shared `document`, so leaving it
    // hidden makes every later test in this file read the wrong state and become order-dependent.
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });

    // The tick already clamps the integrated delta, so the real hazard of a hidden tab is a
    // `pointerup` missed while hidden, which would leave the player steering on return.
    expect(app.session.predictor.walk).toBeUndefined();
  });

  it('lets go of a held press when the window blurs', () => {
    const app = steering();

    window.dispatchEvent(new Event('blur'));

    expect(app.session.predictor.walk).toBeUndefined();
  });

  it('lets go of a held press when an overlay is presented', () => {
    const app = steering();

    pressEscape();

    expect(app.session.predictor.walk).toBeUndefined();
  });

  it('lets go of a held press when the chat input takes focus', () => {
    const app = steering();

    app.hud.chatInput.dispatchEvent(new FocusEvent('focus'));

    expect(app.session.predictor.walk).toBeUndefined();
    expect(app.controller.isChatInputFocused).toBe(true);
  });
});

describe('the Run key', () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = element('div');
    document.body.append(container);
  });

  afterEach(() => {
    container.remove();
  });

  function inWorld(): AppShell {
    const app = new AppShell({ container, capabilities: { hasWebGL: true }, startRendering: false });
    app.controller.presentedOverlay = undefined;
    app.controller.connectionState = 'attached';
    return app;
  }

  function pressShift(init: KeyboardEventInit = {}): void {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', code: 'ShiftLeft', cancelable: true, ...init }));
  }

  it('toggles Run on each press of Shift, and lights the Run button while it is on', () => {
    const app = inWorld();
    const runButton = container.querySelector<HTMLButtonElement>('button[aria-label="Run"]')!;

    pressShift();
    expect(app.session.running).toBe(true);
    expect(runButton.getAttribute('aria-pressed')).toBe('true');

    pressShift({ code: 'ShiftRight' });
    expect(app.session.running).toBe(false);
    expect(runButton.getAttribute('aria-pressed')).toBe('false');
  });

  it('does not toggle again while Shift is held down and repeats', () => {
    const app = inWorld();

    pressShift();
    pressShift({ repeat: true });

    expect(app.session.running).toBe(true);
  });

  it.each<[string, (app: AppShell) => void]>([
    ['an overlay is up', (app) => (app.controller.presentedOverlay = { kind: 'gameMenu' })],
    ['the chat input has focus', (app) => app.hud.chatInput.dispatchEvent(new FocusEvent('focus'))],
  ])('leaves Run alone while %s, where Shift capitalizes', (_label, arrange) => {
    const app = inWorld();
    arrange(app);

    pressShift();

    expect(app.session.running).toBe(false);
  });

  it('toggles Run from the button on the HUD too', () => {
    const app = inWorld();
    const runButton = container.querySelector<HTMLButtonElement>('button[aria-label="Run"]')!;

    runButton.click();
    expect(app.session.running).toBe(true);
    runButton.click();
    expect(app.session.running).toBe(false);
  });
});
