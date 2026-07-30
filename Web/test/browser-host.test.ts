import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GameplaySession, KeyboardSampler, PlayerZoom, mouseFacingHeading, noHeldKeys } from '@/client'
import { tempoFromHeld } from '@/client'
import { TEMPO, tempoPixelsPerSecond } from '@/core'
import {
  ORTHO_RIG,
  PLAYER_ZOOM,
  WHEEL_NOTCH,
  frustumBounds,
  wheelDeltaToNativeScale,
} from '@/scene/cameraRig'
import { WorldScene } from '@/scene/worldScene'
import { AppShell, element } from '@/ui'
import type { ModelAssets } from '@/scene/modelAssets'

/**
 * Browser-specific correctness: the problems the native client never faced.
 *
 * A hidden tab, a lost window focus, Esc colliding with the browser's fullscreen handling, and a
 * resize that must not change how much world is visible. None of these has a Swift counterpart to
 * mirror, so each one is asserted here rather than inferred from the port.
 */

function emptyAssets(): ModelAssets {
  return {
    prewarm: async () => {},
    entity: () => undefined,
    object: () => undefined,
    floorTexture: () => undefined,
    clipsFor: () => [],
  }
}

/**
 * Reads the presented overlay through a call so TypeScript does not narrow the field to `undefined`
 * after a test assigns it — the assignment is the arrangement, and the read is what is asserted.
 */
function currentOverlay(app: AppShell): string | undefined {
  return app.controller.presentedOverlay?.kind
}

describe('the keyboard sampler', () => {
  /** The sampler reaches these through its own listener, installed by `start()`. */
  function press(target: EventTarget, code: string, down: boolean): void {
    target.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code, cancelable: true }))
  }

  it('tracks WASD while gameplay is active', () => {
    const target = element('div')
    const sampler = new KeyboardSampler(target)
    sampler.start()
    sampler.setGameplayActive(true)

    press(target, 'KeyW', true)
    press(target, 'KeyD', true)

    expect(sampler.snapshot()).toEqual({ ...noHeldKeys(), w: true, d: true })
  })

  it('maps the arrow keys onto the same four direction bits', () => {
    const target = element('div')
    const sampler = new KeyboardSampler(target)
    sampler.start()
    sampler.setGameplayActive(true)

    press(target, 'ArrowUp', true)
    press(target, 'ArrowLeft', true)

    expect(sampler.snapshot().w).toBe(true)
    expect(sampler.snapshot().a).toBe(true)
  })

  it('distinguishes the left modifiers from the right ones', () => {
    const target = element('div')
    const sampler = new KeyboardSampler(target)
    sampler.start()
    sampler.setGameplayActive(true)

    press(target, 'ShiftRight', true)
    press(target, 'AltRight', true)

    // The legacy rule is left-side only: LShift runs, LOption walks. `KeyboardEvent.code` names the
    // physical key, so this comes for free in the browser where AppKit needed device bitmasks.
    expect(sampler.snapshot().leftShift).toBe(false)
    expect(sampler.snapshot().leftOption).toBe(false)

    press(target, 'ShiftLeft', true)
    expect(sampler.snapshot().leftShift).toBe(true)
  })

  /**
   * The positive direction matters on its own: asserting only that AltRight leaves `leftOption`
   * false would pass with a wrong code in `MODIFIER_CODES`, leaving the slow walk silently dead.
   */
  it('tracks LeftOption and maps it to the walk tempo at 50 px/s', () => {
    const target = element('div')
    const sampler = new KeyboardSampler(target)
    sampler.start()
    sampler.setGameplayActive(true)

    press(target, 'AltLeft', true)

    const held = sampler.snapshot()
    expect(held.leftOption).toBe(true)
    // The whole chain, not just the bit: key -> tempo -> speed. LShift outranks LOption, matching
    // `tempoFromHeld`'s order.
    expect(tempoFromHeld(held)).toBe(TEMPO.walk)
    expect(tempoPixelsPerSecond(tempoFromHeld(held))).toBe(50)

    press(target, 'ShiftLeft', true)
    expect(tempoFromHeld(sampler.snapshot())).toBe(TEMPO.run)
  })

  /**
   * A consumed direction key must not also scroll the page — otherwise holding ArrowDown to walk
   * south drifts the canvas out of view. Both directions are asserted: the negative case alone (a
   * Meta combo reaching the browser) passes even if nothing is ever consumed.
   */
  it('prevents the default for a direction key it consumes', () => {
    const target = element('div')
    const sampler = new KeyboardSampler(target)
    sampler.start()
    sampler.setGameplayActive(true)

    const event = new KeyboardEvent('keydown', { code: 'ArrowDown', cancelable: true, bubbles: true })
    target.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
    expect(sampler.snapshot().s).toBe(true)
  })

  it('ignores presses while gameplay is inactive', () => {
    const target = element('div')
    const sampler = new KeyboardSampler(target)
    sampler.start()

    press(target, 'KeyW', true)

    // Keys typed into a focused text field must not walk the character.
    expect(sampler.snapshot().w).toBe(false)
  })

  it('lets Meta and Control combos through to the browser', () => {
    const target = element('div')
    const sampler = new KeyboardSampler(target)
    sampler.start()
    sampler.setGameplayActive(true)

    const event = new KeyboardEvent('keydown', { code: 'KeyW', metaKey: true, cancelable: true })
    target.dispatchEvent(event)

    // Cmd-W has to reach the browser, or the player cannot close the tab.
    expect(sampler.snapshot().w).toBe(false)
    expect(event.defaultPrevented).toBe(false)
  })

  it('clears a bit whose key-up arrives under a modifier', () => {
    const target = element('div')
    const sampler = new KeyboardSampler(target)
    sampler.start()
    sampler.setGameplayActive(true)
    press(target, 'KeyW', true)

    target.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW', metaKey: true, cancelable: true }))

    // The press was consumed but the release was not; clearing has to be unconditional or the key
    // sticks on and the character walks forever.
    expect(sampler.snapshot().w).toBe(false)
  })

  it('drops held keys when the gate closes', () => {
    const target = element('div')
    const sampler = new KeyboardSampler(target)
    sampler.start()
    sampler.setGameplayActive(true)
    press(target, 'KeyW', true)

    sampler.setGameplayActive(false)

    // Releasing capture mid-hold means the matching key-up is never seen, so the bitset has to go.
    expect(sampler.snapshot().w).toBe(false)
  })

  it('drops held keys when the window loses focus', () => {
    const target = element('div')
    const sampler = new KeyboardSampler(target)
    sampler.start()
    sampler.setGameplayActive(true)
    press(target, 'KeyW', true)

    target.dispatchEvent(new Event('blur'))

    // Switching windows never delivers the key-up, so without this the character walks on return.
    expect(sampler.snapshot().w).toBe(false)
  })

  it('stops listening after stop()', () => {
    const target = element('div')
    const sampler = new KeyboardSampler(target)
    sampler.start()
    sampler.setGameplayActive(true)

    sampler.stop()
    press(target, 'KeyW', true)

    expect(sampler._isStarted).toBe(false)
    expect(sampler.snapshot().w).toBe(false)
  })
})

describe('mouse facing', () => {
  it('needs no Y flip, unlike the AppKit original', () => {
    // DOM pointer coordinates already grow downward, which is the direction `worldMovement` expects;
    // the AppKit sampler had to invert its Y-up view space first.
    const below = mouseFacingHeading({ x: 100, y: 200 }, { x: 100, y: 100 })
    const above = mouseFacingHeading({ x: 100, y: 0 }, { x: 100, y: 100 })

    // Opposite pointer offsets have to give opposite headings...
    expect(Math.abs(Math.abs(below - above) - 180)).toBeLessThan(0.01)
    // ...and each has to be the *right* one. The difference alone cannot say so: the two probes sit
    // symmetrically about the centre, so flipping Y merely swaps them and leaves `|below - above|`
    // untouched — a character facing 180 degrees away from the cursor passes. `worldMovement`
    // rotates a straight-down screen offset through the camera yaw, so a cursor below the player
    // faces exactly that yaw.
    expect(below).toBeCloseTo(ORTHO_RIG.yawDegrees, 4)
  })
})

describe('scroll zoom', () => {
  it('inverts the DOM wheel sign so scrolling up zooms in', () => {
    const zoom = new PlayerZoom()

    // The shell negates `deltaY` before this call, so a raw negative delta here means "scroll up"
    // in AppKit terms and has to magnify.
    zoom.applyScroll(10)

    expect(zoom.factor).toBeGreaterThan(1)
  })

  it('clamps at both ends and reports when nothing moved', () => {
    const zoom = new PlayerZoom()
    for (let index = 0; index < 200; index += 1) zoom.applyScroll(50)

    const moved = zoom.applyScroll(50)

    expect(zoom.factor).toBe(PLAYER_ZOOM.maxFactor)
    expect(moved).toBe(false)
  })

  /**
   * The gain mirrors `PlayerZoom.scrollGain`, which is fed `NSEvent.scrollingDeltaY` — a few units
   * per notch. Chrome and Safari on macOS report ~100 px for the same notch, and `exp(100 * 0.015)`
   * is 4.5x against a range of only 4x, so an unconverted delta pins the camera at a stop on the
   * first notch with nothing in between. Converting the scale is as load-bearing as the sign.
   */
  it('takes many notches to cross the zoom range rather than one', () => {
    const session = () =>
      new GameplaySession({
        controller: new AppShell({
          container: element('div'),
          capabilities: { hasWebGL: false, isDesktop: true },
        }).controller,
        send: () => {},
        input: { snapshot: () => noHeldKeys(), setGameplayActive: () => {}, clearHeldKeys: () => {} },
        measureText: (line) => line.length * 5,
      })

    const zoomIn = session()
    let notches = 0
    while (zoomIn.zoom.applyScroll(-wheelDeltaToNativeScale(-WHEEL_NOTCH.pixels, 0))) notches += 1
    expect(zoomIn.zoom.factor).toBe(PLAYER_ZOOM.maxFactor)
    // ~12 notches from the default factor to the stop, so ~24 across the full range. What matters is
    // that a player can stop part-way; one notch reaching a stop is the regression.
    expect(notches).toBeGreaterThan(8)

    const single = session()
    single.applyScrollZoom(-WHEEL_NOTCH.pixels, 0)
    expect(single.zoom.factor).toBeGreaterThan(1)
    expect(single.zoom.factor).toBeLessThan(PLAYER_ZOOM.maxFactor)
  })

  it('reads Firefox line deltas at the same scale as Chrome pixel deltas', () => {
    const controller = new AppShell({
      container: element('div'),
      capabilities: { hasWebGL: false, isDesktop: true },
    }).controller
    const make = () =>
      new GameplaySession({
        controller,
        send: () => {},
        input: { snapshot: () => noHeldKeys(), setGameplayActive: () => {}, clearHeldKeys: () => {} },
        measureText: (line) => line.length * 5,
      })

    const pixels = make()
    pixels.applyScrollZoom(-WHEEL_NOTCH.pixels, 0)
    const lines = make()
    // `deltaMode` 1 is DOM_DELTA_LINE. Ignoring it makes one Firefox notch a 3-unit delta and the
    // wheel barely responds at all — the opposite failure to Chrome's.
    lines.applyScrollZoom(-WHEEL_NOTCH.lines, 1)

    expect(lines.zoom.factor).toBeCloseTo(pixels.zoom.factor, 10)
  })
})

describe('the resize invariant', () => {
  it('holds the vertical world extent constant and lets aspect drive width', () => {
    const scene = new WorldScene(emptyAssets(), 1)
    const tallTop = scene.camera.top
    const tallHeight = scene.camera.top - scene.camera.bottom

    scene.setViewportAspect(2.5)

    // `WorldScene3D` records this as a deliberate gameplay contract: every window size shows the
    // same vertical world extent, so a bigger window magnifies rather than reveals. Tying the
    // frustum to pixel height would silently hand large-window players more visible world.
    expect(scene.camera.top).toBe(tallTop)
    expect(scene.camera.top - scene.camera.bottom).toBe(tallHeight)
    expect(scene.camera.right - scene.camera.left).toBeCloseTo(tallHeight * 2.5, 10)
  })

  it('keeps the camera scale untouched by a resize', () => {
    const scene = new WorldScene(emptyAssets(), 1)
    const before = scene._cameraScale()

    scene.setViewportAspect(0.4)

    expect(scene._cameraScale()).toBe(before)
  })

  it('maps scale as a half-height, not a full extent', () => {
    const bounds = frustumBounds(ORTHO_RIG.defaultScale, 1)

    // A 2x framing discrepancy against the native client means `scale` was treated as a full
    // height and halved again by the usual Three.js `frustumSize / 2` idiom.
    expect(bounds.top).toBe(ORTHO_RIG.defaultScale)
    expect(bounds.top - bounds.bottom).toBe(2 * ORTHO_RIG.defaultScale)
  })
})

describe('host handlers', () => {
  let container: HTMLElement

  beforeEach(() => {
    container = element('div')
    document.body.append(container)
  })

  afterEach(() => {
    container.remove()
  })

  function shell(): AppShell {
    return new AppShell({
      container,
      capabilities: { hasWebGL: true, isDesktop: true },
      startRendering: false,
    })
  }

  function pressEscape(): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
    window.dispatchEvent(event)
    return event
  }

  it('does not open the game menu from the login overlay', () => {
    const app = shell()

    pressEscape()

    // There is nothing behind the login overlay to resume to.
    expect(currentOverlay(app)).toBe('login')
  })

  it('opens the game menu during a live session', () => {
    const app = shell()
    app.controller.presentedOverlay = undefined
    app.controller.connectionState = 'attached'

    pressEscape()

    expect(currentOverlay(app)).toBe('gameMenu')
  })

  it('resumes the game from the game menu', () => {
    const app = shell()
    app.controller.connectionState = 'attached'
    app.controller.presentedOverlay = { kind: 'gameMenu' }

    pressEscape()

    expect(currentOverlay(app)).toBeUndefined()
  })

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
    const app = shell()
    app.controller.connectionState = attached ? 'attached' : 'disconnected'
    app.controller.presentedOverlay = overlay

    pressEscape()

    expect(currentOverlay(app)).toBe(expected)
  })

  it('blurs the chat input instead of opening the menu behind it', () => {
    const app = shell()
    app.controller.connectionState = 'attached'
    app.controller.presentedOverlay = undefined
    container.append(app.panels.root)
    app.panels.chatInput.focus()
    expect(app.controller.isChatInputFocused).toBe(true)

    pressEscape()

    // `handleEscape` returns right after the blur natively, so the menu must not appear — and the
    // gate has to reopen, or Esc would leave the player unable to walk *or* reach the menu.
    expect(app.controller.isChatInputFocused).toBe(false)
    expect(currentOverlay(app)).toBeUndefined()
  })

  it('consumes Esc so the browser does not act on it first', () => {
    const app = shell()
    app.controller.presentedOverlay = undefined
    app.controller.connectionState = 'attached'

    // Fullscreen is never entered automatically precisely because the browser would claim Esc for
    // "exit fullscreen" before the menu ever saw it.
    expect(pressEscape().defaultPrevented).toBe(true)
  })

  it('clears held keys when the tab is hidden', () => {
    const app = shell()
    app.controller.connectionState = 'attached'
    app.session.input.setGameplayActive(true)
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', cancelable: true }))
    expect(app.session.input.snapshot().w).toBe(true)

    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
    // Restored immediately: the property is redefined on the shared `document`, so leaving it
    // hidden makes every later test in this file read the wrong state and become order-dependent.
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })

    // The real hazard of a hidden tab is not the integrated delta — the tick already clamps that —
    // it is a `keyup` delivered while hidden leaving the held set populated.
    expect(app.session.input.snapshot().w).toBe(false)
  })

  it('clears held keys when the window blurs', () => {
    const app = shell()
    app.controller.connectionState = 'attached'
    app.session.input.setGameplayActive(true)
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyS', cancelable: true }))
    let visibilityLosses = 0
    const original = app.session.handleVisibilityLoss.bind(app.session)
    app.session.handleVisibilityLoss = (): void => {
      visibilityLosses += 1
      original()
    }

    window.dispatchEvent(new Event('blur'))

    expect(app.session.input.snapshot().s).toBe(false)
    // The half that pins the *shell's* handler rather than the sampler's. `KeyboardSampler`
    // installs its own `blur` listener on `window` and clears the held set itself, so the assertion
    // above passes with the shell's handler deleted — only the call it makes distinguishes them.
    expect(visibilityLosses).toBe(1)
  })

  it('clears held keys when an overlay is presented', () => {
    const app = shell()
    app.controller.presentedOverlay = undefined
    app.controller.connectionState = 'attached'
    app.session.input.setGameplayActive(true)
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyD', cancelable: true }))

    pressEscape()

    expect(app.session.input.snapshot().d).toBe(false)
  })

  it('clears held keys when the chat input takes focus', () => {
    const app = shell()
    app.controller.presentedOverlay = undefined
    app.controller.connectionState = 'attached'
    app.session.input.setGameplayActive(true)
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyA', cancelable: true }))

    app.panels.chatInput.dispatchEvent(new FocusEvent('focus'))

    // A movement key landing during the focus transition would otherwise survive into the next
    // tick, which is why focus *gain* clears rather than relying on the gate alone.
    expect(app.session.input.snapshot().a).toBe(false)
    expect(app.controller.isChatInputFocused).toBe(true)
  })
})
