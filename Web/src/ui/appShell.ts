import registryJSON from '@registry'
import { bundledModelRegistry, clamp } from '@/core'
import { ConnectionController, GameplaySession, KeyboardSampler } from '@/client'
import type { OverlayKind, RegistrationOutcome } from '@/client'
import { assertNever } from '@/protocol'
import { GameplayTransport, browserSocketFactory, resolveGameplayURL } from '@/transport'
import type { GameplaySocketFactory } from '@/transport'
import * as THREE from 'three'
import { MAX_TICK_DELTA } from '@/scene/animation'
import { WorldScene } from '@/scene/worldScene'
import { HttpModelAssets } from '@/scene/modelAssets'
import { catalogTables, currentLocale, resolveLocale, setLocale, t } from '@/i18n'
import { GamePanels } from './panels'
import { BlockingNotices, Overlays } from './overlays'
import { element } from './dom'

/**
 * Composition root: canvas, DOM overlays, controller, session, and every browser-only concern the
 * native client never faced.
 *
 * Those concerns are the reason this file exists as its own layer rather than being folded into the
 * controller: a hidden tab, a lost window focus, Esc colliding with fullscreen, and a resize that
 * must not change how much world is visible are all *host* problems, and none of them has a Swift
 * counterpart to mirror.
 */

export interface AppShellOptions {
  container: HTMLElement
  appVersion?: string
  /** Overridable so a test can force the no-WebGL and mobile paths. */
  capabilities?: { hasWebGL: boolean; isDesktop: boolean }
  /**
   * Skips creating the `WebGLRenderer` and starting the frame loop, while still installing the host
   * handlers. That split is what lets the browser-specific behaviour — Esc routing, visibility loss,
   * the resize invariant — be driven headlessly, where no WebGL context can be created at all.
   */
  startRendering?: boolean
  /**
   * Overridable so a test can drive real wire frames all the way into the DOM. The socket is the
   * right seam for that rather than the controller: an overlay the controller presents correctly but
   * never repaints is only observable in the DOM, so the DOM has to be downstream of the fake.
   */
  socketFactory?: GameplaySocketFactory
}

/**
 * A live WebGL2 context is the only honest test. Feature-detecting the constructor is not enough:
 * `WebGL2RenderingContext` exists in browsers that then refuse to create a context (blocklisted
 * driver, disabled in settings), and the failure mode without this check is a blank black canvas
 * with no explanation.
 *
 * **WebGL2 specifically**, with no WebGL1 fallback arm, because `WebGLRenderer` asks for exactly
 * `'webgl2'` and throws when it cannot get one — three.js dropped its WebGL1 path in r163. Accepting a
 * WebGL1-only host here would pass this gate and then throw out of the `WorldScene` constructor,
 * escaping before any notice could be presented: a blank page and one console line, which is the
 * outcome this function exists to replace.
 */
function detectWebGL(): boolean {
  try {
    return document.createElement('canvas').getContext('webgl2') !== null
  } catch {
    return false
  }
}

/**
 * Coarse pointer *or* a small viewport. Either alone gives false results — a touchscreen laptop has
 * a coarse pointer and a real keyboard, and a narrow desktop window is still a desktop — so the
 * notice shows only when both say handheld.
 */
export function detectDesktop(): boolean {
  const coarsePointer = window.matchMedia?.('(pointer: coarse)').matches ?? false
  const smallViewport = window.innerWidth < 900
  return !(coarsePointer && smallViewport)
}

/**
 * The three failing `RegisterResultCode`s, worded as `RegistrationOverlayView` words them. Thunks
 * rather than constants so `t` runs after the locale resolves, and so each key sits in a literal
 * `t('...')` the catalog test's source scan can find.
 */
const REGISTRATION_ERROR_TEXT: Record<Exclude<RegistrationOutcome, 'ok'>, () => string> = {
  nicknameExists: () => t('Nickname already exists.'),
  nameNotAllowed: () => t('That name uses characters Somnio does not allow.'),
  failure: () => t('Registration failed.'),
}

export class AppShell {
  readonly controller: ConnectionController
  readonly session: GameplaySession
  readonly scene: WorldScene | undefined
  readonly panels: GamePanels
  readonly overlays: Overlays
  readonly notices: BlockingNotices

  private readonly container: HTMLElement
  private readonly canvas: HTMLCanvasElement
  private readonly transport: GameplayTransport
  private readonly keyboard: KeyboardSampler
  private renderer: THREE.WebGLRenderer | undefined
  private hoveringPanel = false
  private lastFrameMs: number | undefined

  constructor(options: AppShellOptions) {
    setLocale(resolveLocale())
    this.container = options.container
    const capabilities = options.capabilities ?? {
      hasWebGL: detectWebGL(),
      isDesktop: detectDesktop(),
    }

    this.canvas = element('canvas', { attributes: { id: 'somnio-canvas' } })
    this.transport = new GameplayTransport(options.socketFactory ?? browserSocketFactory)
    this.keyboard = new KeyboardSampler()

    // The scene is built before the controller so it can be passed in as the render surface rather
    // than assigned afterwards. It is skipped entirely when the host cannot render it, and the
    // controller falls back to the no-op surface — so the blocking notice below is the only thing
    // the player sees, instead of a WebGL error thrown from a constructor.
    this.scene =
      capabilities.hasWebGL && capabilities.isDesktop
        ? new WorldScene(new HttpModelAssets(bundledModelRegistry(registryJSON)), this.aspect())
        : undefined

    this.controller = new ConnectionController({
      transport: this.transport,
      ...(this.scene === undefined ? {} : { renderSurface: this.scene }),
      resolveURL: () => resolveGameplayURL(window.location),
    })

    this.session = new GameplaySession({
      controller: this.controller,
      send: (message) => this.transport.send(message),
      input: this.keyboard,
    })

    this.panels = new GamePanels(
      {
        onSubmitChat: (text) => {
          this.session.submitChat(text)
          this.panels.clearChatInput()
          this.render()
        },
        onChatFocusChange: (focused) => this.controller.setChatInputFocused(focused),
        onActivateItem: (row) => {
          this.session.activateInventoryRow(row)
          this.render()
        },
        onFloatingHoverChange: (hovering) => {
          this.hoveringPanel = hovering
        },
      },
      catalogTables,
      currentLocale()
    )

    this.overlays = new Overlays({
      // The overlay stays up until the world actually arrives, as natively: `submitLogin` does not
      // touch `presentedOverlay` and `handleEnterSector` is what clears it. Dismissing on submit
      // instead leaves nothing on screen for a rejected password to return to.
      onLogin: (credentials) => this.controller.beginSession({ kind: 'login', credentials }),
      onRegister: (form) => {
        this.overlays.showRegistrationError(undefined)
        this.controller.register(form)
      },
      onShowOverlay: (overlay) => this.present(overlay),
      onResume: () => this.present(undefined),
      onDismissOverlay: () => this.dismissOverlay(),
      onCancelRegistration: () => this.cancelRegistration(),
      // `leaveGame` is a complete recovery path — it revokes, clears storage, tears down, shows the
      // splash, and presents login as its last statement. Presenting again here would fire
      // `onOverlayChanged` twice for one click, running `clearHeldKeys` and a full `render()` twice.
      onLeaveGame: () => this.controller.leaveGame(),
      onRetryConnection: () => {
        this.present(undefined)
        this.controller.beginSession()
      },
      onToggleFullscreen: () => this.toggleFullscreen(),
      appVersion: options.appVersion ?? '0.0.0',
    })

    this.notices = new BlockingNotices()

    this.container.append(this.canvas, this.panels.root, this.overlays.root, this.notices.root)
    this.controller.onChatLinesChanged = () => this.render()
    this.controller.onPlayersChanged = () => this.render()
    // The form is the one credential surface the controller cannot reach, so it clears through here.
    this.controller.onSessionIdentityEnded = () => this.overlays.clearCredentialForms()
    this.controller.onOverlayChanged = (overlay) => {
      // The gate reads `presentedOverlay`, so held keys have to drop the moment an overlay appears —
      // otherwise a movement key held when the menu opens resumes walking when it closes.
      if (overlay !== undefined) this.session.input.clearHeldKeys()
      this.render()
    }
    this.session.onStateChanged = () => this.render()
    // On success the controller has already switched the presented overlay back to login, which
    // `submitRegistration` pre-filled with the credentials just created. The three failures leave
    // the registration overlay up carrying the reason.
    this.controller.onRegistrationOutcome = (outcome) => {
      this.overlays.showRegistrationError(outcome === 'ok' ? undefined : REGISTRATION_ERROR_TEXT[outcome]())
      this.render()
    }

    if (!capabilities.isDesktop) {
      this.notices.showMobileNotice()
      return
    }
    if (!capabilities.hasWebGL) {
      this.notices.showWebGLUnavailable()
      return
    }

    this.installHostHandlers()
    if (options.startRendering ?? true) this.startRenderer()
    // A stored token resumes silently — that is the whole point of the feature, and it is what makes
    // a refresh mid-session survive. Only when there is nothing to resume from does the login form
    // appear. `resumeStoredSession` returns false when the store is empty or the token has locally
    // expired, so an aged-out token still lands on the form rather than a pointless round trip.
    //
    // The resume branch *clears* the overlay rather than merely not presenting one. The controller
    // starts at `{ kind: 'login' }`, and leaving that set makes "silent" mean "unpainted so far":
    // any repaint during the resume presents it, and the `alreadyLoggedIn` retry deliberately
    // appends a chat line, which is exactly such a repaint. The player would see a focused login
    // card flash over a session that is resuming fine.
    if (this.controller.resumeStoredSession()) {
      this.present(undefined)
    } else {
      this.present({ kind: 'login' })
    }
  }

  private aspect(): number {
    const width = this.container.clientWidth || window.innerWidth || 1
    const height = this.container.clientHeight || window.innerHeight || 1
    return width / height
  }

  // MARK: - Host handlers

  private installHostHandlers(): void {
    // Without this the sampler holds no listeners and every key is silently dropped, so the gate
    // works perfectly and the character never moves.
    this.keyboard.start()
    window.addEventListener('resize', () => this.handleResize())

    // Esc is bound to the game menu, as it is natively. Fullscreen is never entered automatically,
    // because the browser gives Esc to "exit fullscreen" first and the key would stop reaching the
    // menu at all — an explicit toggle in Options is the honest trade.
    window.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      this.handleEscape()
    })

    // `requestAnimationFrame` does not fire in a hidden tab, and the tick already clamps its
    // elapsed time, so the integrated delta is not the hazard. Stale input is: a `keyup` delivered
    // while hidden leaves the held set populated and the character walks on return.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.session.handleVisibilityLoss()
      else this.lastFrameMs = undefined
    })
    window.addEventListener('blur', () => this.session.handleVisibilityLoss())

    this.canvas.addEventListener('pointermove', (event) => {
      const rect = this.canvas.getBoundingClientRect()
      this.session.updateMouseFacing(
        { x: event.clientX - rect.left, y: event.clientY - rect.top },
        { x: rect.width / 2, y: rect.height / 2 }
      )
    })

    // A wheel event over a panel scrolls the panel; only the bare play field zooms.
    this.canvas.addEventListener(
      'wheel',
      (event) => {
        if (this.hoveringPanel) return
        event.preventDefault()
        if (this.session.applyScrollZoom(event.deltaY, event.deltaMode)) {
          this.scene?.applyZoomFactor(this.session.zoom.factor)
        }
      },
      { passive: false }
    )

    // Clicking the play field blurs the chat input, mirroring the native tap gesture — otherwise
    // WASD keeps going into the text box after the player looks back at the world.
    this.canvas.addEventListener('pointerdown', () => {
      this.panels.chatInput.blur()
    })
  }

  /**
   * `ClientViewModel.handleEscape`, case for case. Collapsing the overlay arm to "dismiss to
   * nothing" gets three of them wrong: backing out of registration or a version skew has to land on
   * the login form, and About and Options have to land on whatever they were opened from.
   */
  private handleEscape(): void {
    // Chat comes first and returns immediately, as natively: with the field focused, Esc hands the
    // keyboard back to the world rather than opening the game menu on top of it.
    if (this.controller.isChatInputFocused) {
      this.panels.chatInput.blur()
      return
    }
    const overlay = this.controller.presentedOverlay
    if (overlay === undefined) {
      // Nothing to resume to without a session, so Esc is inert rather than opening a menu whose
      // Resume would drop the player onto the splash.
      if (this.controller.connectionState === 'disconnected') return
      this.present({ kind: 'gameMenu' })
      return
    }
    switch (overlay.kind) {
      case 'login':
        return
      case 'registration':
        this.cancelRegistration()
        return
      case 'updateRequired':
        this.present({ kind: 'login' })
        return
      case 'about':
      case 'options':
        this.dismissOverlay()
        return
      case 'gameMenu':
        this.present(undefined)
        return
      default:
        assertNever(overlay, 'overlay kind')
    }
  }

  /** `cancelRegistration`: back out to login, dropping the inline error so a reopened form is clean. */
  private cancelRegistration(): void {
    this.overlays.showRegistrationError(undefined)
    this.present({ kind: 'login' })
  }

  /**
   * `dismissPresentedOverlay`: back out to whatever sits behind — the game menu while attached, else
   * the login overlay, which auto-presents whenever the player is not attached. Shared by the
   * About/Options close buttons and their Esc rows, so closing Options returns to the menu it was
   * opened from instead of dropping the player into the world.
   */
  private dismissOverlay(): void {
    this.present(this.controller.connectionState === 'attached' ? { kind: 'gameMenu' } : { kind: 'login' })
  }

  /**
   * Both calls return a Promise that *rejects* when the request is denied — a permissions policy, a
   * kiosk lockdown, an element detached between click and call. `void` discards the value but not
   * the rejection, so an unhandled one would surface as `unhandledrejection` noise on a button that
   * simply did nothing. A denied toggle is not an error worth reporting, so it is swallowed here.
   */
  private toggleFullscreen(): void {
    const request =
      document.fullscreenElement === null ? this.container.requestFullscreen?.() : document.exitFullscreen?.()
    request?.catch(() => {})
  }

  private handleResize(): void {
    const width = this.container.clientWidth || window.innerWidth
    const height = this.container.clientHeight || window.innerHeight
    this.renderer?.setSize(width, height, false)
    // Holds the vertical world extent constant and lets aspect drive width, so a bigger window
    // magnifies rather than reveals. This is the MMO-fairness contract, not a rendering detail.
    this.scene?.setViewportAspect(this.aspect())
  }

  // MARK: - Rendering

  private startRenderer(): void {
    const scene = this.scene
    if (scene === undefined) return
    const renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true })
    renderer.setPixelRatio(window.devicePixelRatio)
    // RealityKit shadows the sun by default; three.js does not shadow at all unless asked. Without
    // this every prop and character sits on the floor with nothing under it and reads as floating.
    // PCF-soft matches the native's soft edge — the hard default reads as a cut-out.
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.renderer = renderer
    this.handleResize()
    // First load has no bundled assets to fall back on, so the loading state is the difference
    // between "loading" and "apparently broken". The native client has no analogue.
    this.notices.setLoading(true)
    void scene
      .prewarm()
      .finally(() => this.notices.setLoading(false))
      .then(() => this.pumpFrames())
  }

  /**
   * The single frame loop for the whole client.
   *
   * It always runs, because the splash and the day/night tint have to draw before there is any
   * session at all; the prediction tick is gated separately, on the connection being up. One
   * timestamp feeds both the tick and the draw, so a frame can never draw a position the tick has
   * not computed.
   */
  private pumpFrames(): void {
    const step = (timestamp: number): void => {
      this.onFrame(timestamp)
      requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
  }

  private onFrame(timestamp: number): void {
    if (this.controller.connectionState !== 'disconnected') this.session.runTick(timestamp)
    const delta = this.lastFrameMs === undefined ? 0 : (timestamp - this.lastFrameMs) / 1000
    this.lastFrameMs = timestamp
    this.scene?.tick(clamp(delta, 0, MAX_TICK_DELTA))
    if (this.scene !== undefined && this.renderer !== undefined) {
      this.renderer.render(this.scene.scene, this.scene.camera)
    }
    // Deliberately not re-rendering the DOM here. The panels rebuild their subtrees wholesale, and
    // doing that 60 times a second would drop a text selection in the scrollback on every frame —
    // the state hooks below cover every path that actually changes what the panels show.
  }

  // MARK: - DOM state

  /**
   * Every overlay change goes through the controller's setter, whose `onOverlayChanged` hook owns
   * the key-clearing and the repaint — so a controller-initiated overlay gets exactly what a
   * DOM-initiated one does.
   */
  private present(overlay: OverlayKind | undefined): void {
    this.controller.presentedOverlay = overlay
  }

  /** Pushes controller and session state into the DOM. Cheap enough to run per frame. */
  render(): void {
    this.overlays.present(this.controller.presentedOverlay)
    // The panels are not gated on the connection: `MainWindowView` composes all four
    // unconditionally and lets the modal host sit over them, which is what makes the chat
    // scrollback readable behind the login overlay — where a rejected password reports itself.
    this.panels.renderEnergy(this.session.energy)
    this.panels.renderChat(this.controller.chatHistory)
    this.panels.renderPlayers(this.controller.players)
    this.panels.renderItems(this.session.inventory)
  }
}
