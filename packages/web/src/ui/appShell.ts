import { bundledModelRegistry, clamp } from '@somnio/core';
import type { Point } from '@somnio/core';
import { ConnectionController, GameplaySession, TAP_SLOP_PX } from '@/client';
import type { CharacterRequest, OverlayKind } from '@/client';
import { assertNever } from '@somnio/protocol';
import type { CharacterResult, CharacterSummaryMessage, RegisterResult } from '@somnio/protocol';
import { GameplayTransport, browserSocketFactory, resolveGameplayURL } from '@/transport';
import type { GameplaySocketFactory } from '@/transport';
import type * as THREE from 'three';
import { MAX_TICK_DELTA } from '@/scene/animation';
import { WorldScene, createWorldRenderer, sizeWorldRenderer, watchViewport } from '@/scene/worldScene';
import { paintBubbles } from '@/scene/bubbleLayer';
import { PORTRAIT_SLOTS, portraitViewport } from '@/scene/portraits';
import { HttpModelAssets } from '@/scene/modelAssets';
import { canvasWidthMeasurer } from '@/scene/speechBubbleText';
import { SplashDirector } from '@/splash/director';
import { catalogTables, currentLocale, renderChatLine, resolveLocale, setLocale, t } from '@/i18n';
import { FallenNotice } from './fallenNotice';
import { SensedMarkers } from './sensedMarkers';
import { GameHUD } from './hud';
import type { HUDClock } from './hud';
import { BlockingNotices, Overlays } from './overlays';
import { ServicePanel } from './servicePanel';
import type { FramedEntity } from './unitFrames';
import { placeName } from './placeNames';
import { screenOccluders, viewportPoint } from './occluders';
import { element, prefersReducedMotion, setHidden } from './dom';

/**
 * Composition root: canvas, DOM overlays, controller, session, and every browser-host concern.
 *
 * Those concerns are the reason this file exists as its own layer rather than being folded into the
 * controller: a hidden tab, a lost window focus, Esc colliding with fullscreen, and a resize that
 * must not change how much world is visible are all *host* problems, not gameplay ones.
 */

export interface AppShellOptions {
  container: HTMLElement;
  appVersion?: string;
  /** Overridable so a test can force the no-WebGL path. */
  capabilities?: { hasWebGL: boolean };
  /**
   * Skips creating the `WebGLRenderer` and starting the frame loop, while still installing the host
   * handlers. That split is what lets the browser-specific behaviour — Esc routing, visibility loss,
   * the resize invariant — be driven headlessly, where no WebGL context can be created at all.
   */
  startRendering?: boolean;
  /**
   * Overridable so a test can drive real wire frames all the way into the DOM. The socket is the
   * right seam for that rather than the controller: an overlay the controller presents correctly but
   * never repaints is only observable in the DOM, so the DOM has to be downstream of the fake.
   */
  socketFactory?: GameplaySocketFactory;
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
    return document.createElement('canvas').getContext('webgl2') !== null;
  } catch {
    return false;
  }
}

/** A phone held upright, which is asked to turn: a tablet upright has room to play, and a phone on its side plays. */
export const UPRIGHT_PHONE_QUERY = '(pointer: coarse) and (orientation: portrait) and (max-width: 600px)';

/**
 * What the registration overlay says for each failing register result. Thunks rather than
 * constants so `t` runs after the locale resolves, and so each key sits in a literal `t('...')`
 * the catalog test's source scan can find.
 */
const REGISTRATION_ERROR_TEXT: Record<Exclude<RegisterResult, 'ok'>, () => string> = {
  emailExists: () => t('Another account already uses that email.'),
  failure: () => t('Registration failed.'),
  throttled: () => t('Too many attempts. Wait a little before trying again.'),
};

/** A pointer's place on the page, in CSS pixels. */
type PagePoint = Pick<PointerEvent, 'clientX' | 'clientY'>;

function pagePoint({ clientX, clientY }: PagePoint): PagePoint {
  return { clientX, clientY };
}

/** The card off screen, one array so a repaint finds it unchanged. */
const NO_CHARACTERS: readonly CharacterSummaryMessage[] = [];

/** What the New Dreamer form says for each failing result of a create. */
const NEW_CHARACTER_ERROR_TEXT: Record<Exclude<CharacterResult, 'ok'>, () => string> = {
  nameExists: () => t('Another dreamer already has that name.'),
  nameNotAllowed: () => t('That name uses characters Somnio does not allow.'),
  full: () => t('Delete a dreamer to make room for a new one.'),
  failure: () => t('Could not create the dreamer. Try again.'),
};

/** What the card says when a dreamer could not be played or deleted. */
const CHARACTER_ERROR_TEXT: Record<Exclude<CharacterRequest, 'create'>, () => string> = {
  select: () => t('Could not enter the world. Try again.'),
  delete: () => t('Could not delete the dreamer. Try again.'),
};

export class AppShell {
  readonly controller: ConnectionController;
  readonly session: GameplaySession;
  readonly scene: WorldScene | undefined;
  /** The reel behind the pre-login screens; there is none without a scene to play it on. */
  readonly splash: SplashDirector | undefined;
  readonly hud: GameHUD;
  readonly servicePanel: ServicePanel;
  readonly fallenNotice: FallenNotice;
  private readonly sensedMarkers = new SensedMarkers();
  readonly overlays: Overlays;
  readonly notices: BlockingNotices;

  private readonly container: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  /** The speech bubbles, painted over the world and under the panels. */
  private readonly bubbleCanvas: HTMLCanvasElement;
  private bubbleContext: CanvasRenderingContext2D | null = null;
  /** Where each bubble is painted opaque before it is laid on the bubble layer at its opacity. */
  private readonly bubbleScratch: HTMLCanvasElement;
  private bubbleScratchContext: CanvasRenderingContext2D | null = null;
  /** Dims the world under the pre-login screens and holds the dip between shots. */
  private readonly splashVeil: HTMLElement;
  private readonly splashDip: HTMLElement;
  private shownDipOpacity = 0;
  /** The wordmark over every pre-login screen, with the line a silent resume reports under it. */
  private readonly splashWordmark: HTMLElement;
  private readonly wordmarkImage: HTMLImageElement;
  private readonly wordmarkStatus: HTMLElement;
  private readonly transport: GameplayTransport;
  private renderer: THREE.WebGLRenderer | undefined;
  private hoveringHUD = false;
  private lastFrameMs: number | undefined;
  /** The pointer of the press in progress on the play field: a mouse's left button, a finger, or a pen. */
  private pressPointerId: number | undefined;
  /** Where on the page that pointer is while its button is down. */
  private pressPoint: PagePoint | undefined;
  /** Where that press landed, until it wanders past a tap's slop. */
  private pressLanded: PagePoint | undefined;
  /** Every pointer whose left button, finger, or pen is down on the play field, by id. */
  private readonly downPointers = new Map<number, PagePoint>();
  /** How far apart the two pinching pointers were at the last step, while a pinch lasts. */
  private pinchSpan: number | undefined;
  /** Where on the page the cursor was last over the play field. */
  private cursorPoint: PagePoint | undefined;

  constructor(options: AppShellOptions) {
    setLocale(resolveLocale());
    this.container = options.container;
    const capabilities = options.capabilities ?? { hasWebGL: detectWebGL() };

    this.canvas = element('canvas', { attributes: { id: 'somnio-canvas' } });
    this.bubbleCanvas = element('canvas', { attributes: { id: 'somnio-bubbles' } });
    this.bubbleScratch = element('canvas');
    this.transport = new GameplayTransport(options.socketFactory ?? browserSocketFactory);

    // The scene is built before the controller so it can be passed in as the render surface rather
    // than assigned afterwards. It is skipped entirely when the host cannot render it, and the
    // controller falls back to the no-op surface — so the blocking notice below is the only thing
    // the player sees, instead of a WebGL error thrown from a constructor.
    const registry = bundledModelRegistry();
    const reducedMotion = prefersReducedMotion();
    const coarsePointer = window.matchMedia?.('(pointer: coarse)').matches ?? false;
    this.scene = capabilities.hasWebGL ? new WorldScene(new HttpModelAssets(registry), registry, this.aspect(), reducedMotion) : undefined;
    if (this.scene !== undefined) this.scene.coarsePointer = coarsePointer;
    this.splash =
      this.scene === undefined
        ? undefined
        : new SplashDirector(this.scene, registry, canvasWidthMeasurer(), {
            reducedMotion,
            attached: () => this.controller.connectionState === 'attached',
          });

    this.controller = new ConnectionController({
      transport: this.transport,
      ...(this.scene === undefined ? {} : { renderSurface: this.scene }),
      registry,
      resolveURL: () => resolveGameplayURL(window.location),
      locale: currentLocale(),
    });

    this.session = new GameplaySession({
      controller: this.controller,
      send: (message) => this.transport.send(message),
      coarsePointer,
    });

    this.hud = new GameHUD(
      {
        onSubmitChat: (text) => {
          this.session.submitChat(text);
          this.render();
        },
        onChatFocusChange: (focused) => this.controller.setChatInputFocused(focused),
        onActivateItem: (row) => {
          this.session.activateInventoryRow(row);
          this.render();
        },
        onToggleRun: () => this.session.toggleRun(),
        onToggleEngage: () => this.session.toggleEngage(),
        onUseAbility: (abilityId) => this.session.useAbility(abilityId),
        onPressPlayer: (name) => this.session.pressPlayerName(name),
        onPressOwnFrame: () => this.session.pressOwnFrame(),
        onClearTarget: () => this.session.select(undefined),
        onOpenSettings: () => this.present({ kind: 'gameMenu' }),
        onHoverChange: (hovering) => {
          this.hoveringHUD = hovering;
        },
      },
      { tables: catalogTables, locale: currentLocale(), coarse: coarsePointer },
    );

    this.servicePanel = new ServicePanel({
      onAskTask: (teachingId) => this.session.askTask(teachingId),
      onCompleteTask: () => this.session.completeTask(),
      onAbandonTask: () => this.session.abandonTask(),
      onStudy: (teachingId) => this.session.study(teachingId),
      onBuy: (itemId) => this.session.buy(itemId),
      onSell: (itemId) => this.session.sell(itemId),
      onClose: () => this.session.closeServicePanel(),
    });
    this.fallenNotice = new FallenNotice(() => this.session.wake());

    this.overlays = new Overlays({
      // The overlay stays up until the world actually arrives: `submitLogin` does not touch
      // `presentedOverlay` and `handleEnterSpace` is what clears it. Dismissing on submit instead
      // leaves nothing on screen for a rejected password to return to.
      onLogin: (credentials) => {
        this.controller.beginSession({ kind: 'login', credentials });
        // Rendered at once, so the last failure leaves the card before any answer to this attempt arrives.
        this.render();
      },
      onRegister: (form) => {
        this.overlays.showRegistrationError(undefined);
        this.controller.register(form);
      },
      onShowOverlay: (overlay) => this.present(overlay),
      onResume: () => this.present(undefined),
      onDismissOverlay: () => this.dismissOverlay(),
      onCancelRegistration: () => this.cancelRegistration(),
      // `leaveGame` is a complete recovery path — it revokes, clears storage, tears down, shows the
      // splash, and presents login as its last statement. Presenting again here would fire
      // `onOverlayChanged` twice for one click, running `letGo` and a full `render()` twice.
      onLeaveGame: () => this.controller.leaveGame(),
      onPlay: (characterId) => {
        this.overlays.showCharacterError(undefined);
        this.controller.selectCharacter(characterId);
      },
      onCreateCharacter: (name, people) => this.controller.createCharacter(name, people),
      onCancelNewCharacter: () => this.cancelNewCharacter(),
      // Back on the card at once; the list without the dreamer, or the reason it stayed, follows.
      onDeleteCharacter: (characterId) => {
        this.overlays.showCharacterError(undefined);
        this.controller.deleteCharacter(characterId);
        this.present({ kind: 'characters' });
      },
      // Closes the menu, so the chat line that answers is in view.
      onLogOutOtherBrowsers: () => {
        this.controller.logOutOtherBrowsers();
        this.present(undefined);
      },
      onRetryConnection: () => {
        this.present(undefined);
        this.controller.beginSession();
      },
      onToggleFullscreen: () => this.toggleFullscreen(),
      appVersion: options.appVersion ?? '0.0.0',
    });

    this.notices = new BlockingNotices();

    this.splashDip = element('div', { className: 'splash-dip' });
    this.splashVeil = element('div', { className: 'splash-veil', children: [this.splashDip] });
    this.wordmarkImage = element('img', {
      className: 'splash-wordmark__image',
      attributes: { alt: t('Somnio'), src: '/assets/Branding/somnio-wordmark.png' },
    });
    this.wordmarkStatus = element('p', { className: 'splash-wordmark__status' });
    this.splashWordmark = element('div', { className: 'splash-wordmark', children: [this.wordmarkImage, this.wordmarkStatus] });
    this.container.classList.add('somnio-prelogin');
    this.hud.setShown(false);

    this.container.append(
      this.canvas,
      this.bubbleCanvas,
      this.sensedMarkers.root,
      this.splashVeil,
      this.hud.root,
      this.servicePanel.root,
      this.fallenNotice.root,
      this.overlays.root,
      this.notices.root,
      this.splashWordmark,
    );
    this.controller.onChatLinesChanged = () => this.render();
    this.controller.onPlayersChanged = () => this.render();
    this.controller.onOtherSessionsChanged = () => this.render();
    this.controller.onSessionStatusChanged = () => this.render();
    this.controller.onSplashShown = () => this.splash?.restart();
    // The form is the one credential surface the controller cannot reach, so it clears through here.
    this.controller.onSessionIdentityEnded = () => this.overlays.clearCredentialForms();
    this.controller.onOverlayChanged = (overlay) => {
      // The gate reads `presentedOverlay`, so a held press has to go the moment an overlay appears —
      // otherwise a press held when the menu opens resumes steering when it closes.
      if (overlay !== undefined) this.session.letGo();
      this.render();
    };
    this.session.onStateChanged = () => this.render();
    // On success the controller has already switched the presented overlay back to login, which
    // `submitRegistration` pre-filled with the credentials just created. The failures leave the
    // registration overlay up carrying the reason.
    this.controller.onRegistrationOutcome = (result) => {
      this.overlays.showRegistrationError(result === 'ok' ? undefined : REGISTRATION_ERROR_TEXT[result]());
      this.render();
    };
    this.controller.onCharacterRequestSent = () => this.render();
    // A created dreamer's list has already brought the card back, so the form only has to be emptied.
    this.controller.onCharacterOutcome = (request, result) => {
      if (request === 'create') {
        if (result === 'ok') this.overlays.clearNewCharacterForm();
        else this.overlays.showNewCharacterError(NEW_CHARACTER_ERROR_TEXT[result]());
      } else if (result !== 'ok') {
        this.overlays.showCharacterError(CHARACTER_ERROR_TEXT[request]());
      }
      this.render();
    };

    if (!capabilities.hasWebGL) {
      this.notices.showWebGLUnavailable();
      return;
    }

    this.installHostHandlers();
    if (options.startRendering ?? true) this.startRenderer();
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
      this.present(undefined);
    } else {
      this.present({ kind: 'login' });
    }
  }

  private aspect(): number {
    const width = this.container.clientWidth || window.innerWidth || 1;
    const height = this.container.clientHeight || window.innerHeight || 1;
    return width / height;
  }

  private installHostHandlers(): void {
    watchViewport(() => this.handleResize());
    this.askToTurnWhileUpright();

    // Esc is bound to the game menu. Fullscreen is never entered automatically,
    // because the browser gives Esc to "exit fullscreen" first and the key would stop reaching the
    // menu at all — an explicit toggle in Options is the honest trade.
    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        this.handleEscape();
        return;
      }
      // Only while the world has the keyboard: under an overlay or in the chat field, Shift capitalizes and 1 is typed.
      if (event.repeat || !this.session.predictor.gateIsOpen() || this.controller.isChatInputFocused) return;
      // Enter opens the chat, unless a control has the keyboard and takes Enter itself, as a focused button or an item row does.
      if (event.key === 'Enter') {
        const onControl = event.target instanceof Element && event.target.closest('button, input, select, textarea, [tabindex]') !== null;
        if (onControl || !this.controller.inWorld) return;
        event.preventDefault();
        this.hud.openChat();
        return;
      }
      if (event.key === 'Shift') this.session.toggleRun();
      else if (event.code === 'Digit1') this.session.toggleEngage();
      else this.useAbilityOnKey(event.code);
    });

    // `requestAnimationFrame` does not fire in a hidden tab, and the tick already clamps its
    // elapsed time, so the integrated delta is not the hazard. Stale input is: a `pointerup` missed
    // while hidden leaves a press held and the character steering on return.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        this.forgetDownPointers();
        this.session.handleVisibilityLoss();
      } else {
        this.lastFrameMs = undefined;
        this.splash?.replayShot();
      }
    });
    window.addEventListener('blur', () => {
      this.forgetDownPointers();
      this.session.handleVisibilityLoss();
    });

    this.canvas.addEventListener('pointermove', (event) => {
      this.aimAt(event);
      // The chat's faded lines let the pointer through to the world, so resting on them is seen here.
      this.hud.revealChatAt(event.clientX, event.clientY);
      // A pointer over a body, which a click selects or acts on.
      this.canvas.style.cursor = this.entityUnder(event) === undefined ? '' : 'pointer';
    });

    // A wheel event over the HUD scrolls it; only the bare play field zooms.
    this.canvas.addEventListener(
      'wheel',
      (event) => {
        if (this.hoveringHUD) return;
        event.preventDefault();
        if (this.session.applyScrollZoom(event.deltaY, event.deltaMode)) {
          this.scene?.applyZoomFactor(this.session.zoom.factor);
        }
      },
      { passive: false },
    );

    // A long press on a touch screen would open the browser's menu over the play field.
    this.canvas.addEventListener('contextmenu', (event) => event.preventDefault());

    // Pressing the play field blurs the chat input, or Shift keeps going into the text box after the
    // player looks back at the world.
    this.canvas.addEventListener('pointerdown', (event) => {
      this.hud.chatInput.blur();
      if (event.button === 2 && event.pointerType === 'mouse') this.pressGaze(event);
      else if (event.button === 0) this.pressPrimary(event);
    });
    // A mouse button pressed while another is down fires no `pointerdown`, only a move naming it.
    this.canvas.addEventListener('pointermove', (event) => {
      if (event.pointerType !== 'mouse') return;
      if (event.button === 2 && (event.buttons & 2) !== 0) this.pressGaze(event);
      else if (event.button === 0 && (event.buttons & 1) !== 0 && !this.downPointers.has(event.pointerId)) this.pressPrimary(event);
    });
    // A pointer is up when its left button is. On the window, because that can happen over a panel
    // or outside the page, and on a move as well: with another button still down, the left one
    // coming up fires no `pointerup`.
    const followDownPointer = (event: PointerEvent, leftIsUp: boolean): void => {
      if (!this.downPointers.has(event.pointerId)) return;
      if (leftIsUp) this.downPointers.delete(event.pointerId);
      else this.downPointers.set(event.pointerId, pagePoint(event));
      if (this.pinchSpan !== undefined) this.followPinch();
      if (event.pointerId !== this.pressPointerId) return;
      this.pressPoint = pagePoint(event);
      if (this.pressLanded !== undefined && Math.hypot(event.clientX - this.pressLanded.clientX, event.clientY - this.pressLanded.clientY) > TAP_SLOP_PX) {
        this.pressLanded = undefined;
        this.session.steer();
      }
      if (!leftIsUp) return;
      this.endPress();
      this.session.release(this.groundUnder(event));
    };
    window.addEventListener('pointerup', (event) => followDownPointer(event, true));
    window.addEventListener('pointermove', (event) => followDownPointer(event, (event.buttons & 1) === 0));
    window.addEventListener('pointercancel', (event) => {
      this.downPointers.delete(event.pointerId);
      if (this.pinchSpan !== undefined) this.followPinch();
      if (event.pointerId !== this.pressPointerId) return;
      this.endPress();
      this.session.letGo();
    });
  }

  /** A right press of a mouse: on a body it locks the gaze on it, or lets go of it; on the ground it lets go. */
  private pressGaze(event: PointerEvent): void {
    const entity = this.entityUnder(event);
    if (entity !== undefined) this.session.toggleGazeOn(entity);
    else if (!this.playerUnder(event)) this.session.unlockGaze();
  }

  /** A press of a mouse's left button, a finger, or a pen. */
  private pressPrimary(event: PointerEvent): void {
    // A primary pointer begins a new gesture, so any pointer still recorded as down lost its `pointerup`.
    if (event.isPrimary && this.downPointers.size > 0) {
      this.forgetDownPointers();
      this.session.letGo();
    }
    this.downPointers.set(event.pointerId, pagePoint(event));
    if (this.downPointers.size > 1) {
      this.beginPinch();
      return;
    }
    this.pressPointerId = event.pointerId;
    this.pressPoint = pagePoint(event);
    this.pressLanded = this.pressPoint;
    // A press with no move before it, such as a tap on a touch screen, still faces where it lands.
    this.aimAt(event);
    const entity = this.entityUnder(event);
    const ground = this.groundUnder(event);
    if (entity !== undefined) this.session.pressEntity(entity);
    else if (this.playerUnder(event)) this.session.pressSelf();
    else if (ground !== undefined) this.session.pressGround(ground, performance.now());
  }

  private endPress(): void {
    this.pressPointerId = undefined;
    this.pressPoint = undefined;
    this.pressLanded = undefined;
  }

  /**
   * A second pointer down. The press in progress lets go, so a tap walks nowhere and a steer stops
   * where the player stands rather than following a finger that is now pinching. Neither finger
   * walks again until both are up.
   */
  private beginPinch(): void {
    if (this.pressPointerId !== undefined) {
      this.endPress();
      this.session.letGo();
    }
    this.pinchSpan = this.spanOfDownPointers();
  }

  /** Zooms by how far the first two pointers down moved apart since the last step, and ends the pinch once none is down. */
  private followPinch(): void {
    if (this.downPointers.size === 0) {
      this.pinchSpan = undefined;
      return;
    }
    const span = this.spanOfDownPointers();
    if (span === undefined || this.pinchSpan === undefined) {
      this.pinchSpan = span ?? this.pinchSpan;
      return;
    }
    if (span > 0 && this.pinchSpan > 0 && this.session.applyPinchZoom(span / this.pinchSpan)) {
      this.scene?.applyZoomFactor(this.session.zoom.factor);
    }
    this.pinchSpan = span;
  }

  /** How far apart on the page the first two pointers down are, or `undefined` with fewer than two. */
  private spanOfDownPointers(): number | undefined {
    const [first, second] = this.downPointers.values();
    if (first === undefined || second === undefined) return undefined;
    return Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY);
  }

  /** Forgets every pointer down, whose `pointerup` a hidden page or a lost window never sees. */
  private forgetDownPointers(): void {
    this.downPointers.clear();
    this.pinchSpan = undefined;
    this.endPress();
  }

  /**
   * The camera moves under a pointer that rests, so what the cursor aims at and where a held press
   * points on the ground are taken again before each tick.
   */
  private followPointer(): void {
    if (this.cursorPoint !== undefined) this.aimAt(this.cursorPoint);
    const ground = this.pressPoint === undefined ? undefined : this.groundUnder(this.pressPoint);
    if (ground !== undefined) this.session.moveHold(ground);
  }

  /** Where on the page an entity's body is drawn, in CSS pixels: the inverse of `entityUnder`, for an agent that has to click one. */
  pagePointOf(entityId: string): { x: number; y: number } | undefined {
    return this.pagePointAt(this.scene?._viewportPointFor(entityId));
  }

  /** Where on the page a point of the space is drawn on the ground, in CSS pixels: the inverse of `groundUnder`, for an agent that has to tap there. */
  pagePointOfGround(position: Point): { x: number; y: number } | undefined {
    return this.pagePointAt(this.scene?._viewportPointOfGround(position));
  }

  /** A point in normalized device coordinates, on the page in CSS pixels. */
  private pagePointAt(point: { x: number; y: number } | undefined): { x: number; y: number } | undefined {
    if (point === undefined) return undefined;
    const rect = this.canvas.getBoundingClientRect();
    return { x: rect.left + ((point.x + 1) / 2) * rect.width, y: rect.top + ((1 - point.y) / 2) * rect.height };
  }

  /** Turns the player toward what the cursor points at. */
  private aimAt(pointer: PagePoint): void {
    this.cursorPoint = pagePoint(pointer);
    const point = this.viewportPointOf(pointer);
    this.session.aimAt(point === undefined ? undefined : this.scene?.aimPointAt(point.x, point.y));
  }

  /** Where the pointer is over the canvas, in normalized device coordinates. */
  private viewportPointOf(pointer: PagePoint): { x: number; y: number } | undefined {
    return viewportPoint(this.canvas.getBoundingClientRect(), pointer.clientX, pointer.clientY);
  }

  /** The entity drawn under the pointer, if any. */
  private entityUnder(pointer: PagePoint): string | undefined {
    const point = this.viewportPointOf(pointer);
    if (this.scene === undefined || point === undefined) return undefined;
    return this.scene.entityAt(point.x, point.y);
  }

  /** Whether the player's own body is drawn under the pointer. */
  private playerUnder(pointer: PagePoint): boolean {
    const point = this.viewportPointOf(pointer);
    return this.scene !== undefined && point !== undefined && this.scene.playerAt(point.x, point.y);
  }

  /** The ground drawn under the pointer, if any. */
  private groundUnder(pointer: PagePoint): Point | undefined {
    const point = this.viewportPointOf(pointer);
    const hit = point === undefined ? undefined : this.scene?.groundPointAt(point.x, point.y);
    return hit === undefined ? undefined : { x: hit.x, z: hit.z };
  }

  /**
   * Escape, case for case. Collapsing the overlay arm to "dismiss to
   * nothing" gets three of them wrong: backing out of registration or a version skew has to land on
   * the login form, and About and Options have to land on whatever they were opened from.
   */
  private handleEscape(): void {
    // Chat comes first and returns immediately: with the field focused, Esc closes it and hands the
    // keyboard back to the world rather than opening the game menu on top of it.
    if (this.controller.isChatInputFocused) {
      this.hud.closeChat();
      return;
    }
    const overlay = this.controller.presentedOverlay;
    if (overlay === undefined) {
      // Nothing to resume to without a session, so Esc is inert rather than opening a menu whose
      // Resume would drop the player onto the splash.
      if (this.controller.connectionState === 'disconnected') return;
      // What the HUD has open closes first, one thing at a time.
      if (this.hud.escape()) return;
      // Clearing the target comes before the menu.
      if (this.session.target !== undefined) {
        this.session.select(undefined);
        return;
      }
      this.present({ kind: 'gameMenu' });
      return;
    }
    switch (overlay.kind) {
      case 'login':
      case 'characters':
        return;
      case 'registration':
        this.cancelRegistration();
        return;
      case 'newCharacter':
        this.cancelNewCharacter();
        return;
      case 'deleteCharacter':
        this.present({ kind: 'characters' });
        return;
      case 'updateRequired':
        this.present({ kind: 'login' });
        return;
      case 'about':
      case 'options':
      case 'logOutOtherBrowsers':
        this.dismissOverlay();
        return;
      case 'gameMenu':
        this.present(undefined);
        return;
      default:
        assertNever(overlay, 'overlay kind');
    }
  }

  /** `cancelRegistration`: back out to login, dropping the inline error so a reopened form is clean. */
  private cancelRegistration(): void {
    this.overlays.showRegistrationError(undefined);
    this.present({ kind: 'login' });
  }

  /** Back out to the card, dropping the inline error so a reopened form is clean. */
  private cancelNewCharacter(): void {
    this.overlays.showNewCharacterError(undefined);
    this.present({ kind: 'characters' });
  }

  /**
   * `dismissPresentedOverlay`: back out to whatever sits behind — the game menu while attached, else
   * the login overlay, which auto-presents whenever the player is not attached. Shared by the
   * About/Options close buttons and their Esc rows, so closing Options returns to the menu it was
   * opened from instead of dropping the player into the world.
   */
  private dismissOverlay(): void {
    this.present(this.controller.connectionState === 'attached' ? { kind: 'gameMenu' } : { kind: 'login' });
  }

  /**
   * Both calls return a Promise that *rejects* when the request is denied — a permissions policy, a
   * kiosk lockdown, an element detached between click and call. `void` discards the value but not
   * the rejection, so an unhandled one would surface as `unhandledrejection` noise on a button that
   * simply did nothing. A denied toggle is not an error worth reporting, so it is swallowed here.
   */
  private toggleFullscreen(): void {
    const request = document.fullscreenElement === null ? this.container.requestFullscreen?.() : document.exitFullscreen?.();
    request?.catch(() => {});
  }

  /**
   * Shows the turn-sideways card while the phone is upright. Turning it resizes the page, which takes
   * the card away, and the game is there as it was left.
   */
  private askToTurnWhileUpright(): void {
    this.notices.setUpright(window.matchMedia?.(UPRIGHT_PHONE_QUERY).matches ?? false);
  }

  private handleResize(): void {
    this.askToTurnWhileUpright();
    const width = this.container.clientWidth || window.innerWidth;
    const height = this.container.clientHeight || window.innerHeight;
    if (this.renderer !== undefined) sizeWorldRenderer(this.renderer, width, height);
    this.bubbleCanvas.width = Math.round(width * window.devicePixelRatio);
    this.bubbleCanvas.height = Math.round(height * window.devicePixelRatio);
    this.splash?.setViewport(width, height);
    this.hud.setViewport(width, height);
    // Holds the vertical world extent constant and lets aspect drive width, so a bigger window
    // magnifies rather than reveals. This is the MMO-fairness contract, not a rendering detail.
    this.scene?.setViewportSize(width || 1, height || 1);
  }

  private startRenderer(): void {
    const scene = this.scene;
    if (scene === undefined) return;
    this.renderer = createWorldRenderer(this.canvas);
    this.bubbleContext = this.bubbleCanvas.getContext('2d');
    this.bubbleScratchContext = this.bubbleScratch.getContext('2d');
    this.handleResize();
    // First load has no bundled assets to fall back on, so the loading state is the difference
    // between "loading" and "apparently broken".
    this.notices.setLoading(true);
    void scene
      .prewarm(this.renderer)
      .finally(() => this.notices.setLoading(false))
      .then(() => this.pumpFrames());
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
      this.onFrame(timestamp);
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  private onFrame(timestamp: number): void {
    if (this.controller.connectionState !== 'disconnected') {
      this.followPointer();
      this.session.runTick(timestamp);
    }
    const delta = this.lastFrameMs === undefined ? 0 : (timestamp - this.lastFrameMs) / 1000;
    this.lastFrameMs = timestamp;
    // Before the world is on screen the card and the wordmark cover it, so the staged bubbles keep clear of them.
    const splashCovering = this.controller.inWorld ? [] : [this.overlays.presentedCard, this.wordmarkImage];
    const covering = [...this.hud.occluders, this.servicePanel.root, this.fallenNotice.root, ...splashCovering]
      .filter((node) => node !== undefined)
      .map((node) => node.getBoundingClientRect());
    const canvasRect = this.canvas.getBoundingClientRect();
    // Read with the panels', so a frame lays the page out once.
    const portraitRects = PORTRAIT_SLOTS.map((slot) => ({ slot, rect: this.hud.portraits[slot].getBoundingClientRect() }));
    this.scene?.setScreenOccluders(screenOccluders(canvasRect, covering));
    this.splash?.update(clamp(delta, 0, MAX_TICK_DELTA));
    const dipOpacity = this.splash?.dipOpacity ?? 0;
    if (dipOpacity !== this.shownDipOpacity) {
      this.shownDipOpacity = dipOpacity;
      this.splashDip.style.opacity = String(dipOpacity);
    }
    this.hud.tick(performance.now(), this.clock());
    this.fallenNotice.tick(performance.now());
    this.scene?.tick(clamp(delta, 0, MAX_TICK_DELTA));
    if (this.scene !== undefined && this.renderer !== undefined) {
      this.renderer.render(this.scene.scene, this.scene.camera);
      this.scene.setPortraitSubject('own', this.controller.selfId);
      this.scene.setPortraitSubject('target', this.session.target);
      const ratio = this.renderer.getPixelRatio();
      this.scene.drawPortraits(
        this.renderer,
        portraitRects.flatMap(({ slot, rect }) => {
          const viewport = portraitViewport(rect, canvasRect, ratio);
          return viewport === undefined ? [] : [{ slot, viewport }];
        }),
      );
      paintBubbles(this.bubbleContext, this.bubbleScratchContext, this.scene.placedBubbles(), this.bubbleCanvas);
      const self = this.controller.selfId === undefined ? undefined : this.controller.entities.get(this.controller.selfId);
      this.sensedMarkers.render(this.controller.inWorld ? this.scene.placedMarkers() : undefined, canvasRect, self?.position);
    }
    // Deliberately not re-rendering the DOM here beyond what moves with time or the camera: the HUD's
    // clock, its seconds left on cooldowns and effects, and its tip, the chat's fading, the fallen
    // notice's countdown, and the sensed markers. The controller's and the session's state hooks
    // cover every path that changes what the rest shows.
  }

  /**
   * Every overlay change goes through the controller's setter, whose `onOverlayChanged` hook lets
   * go of a held press and repaints, so a controller-initiated overlay gets exactly what a
   * DOM-initiated one does.
   */
  private present(overlay: OverlayKind | undefined): void {
    this.controller.presentedOverlay = overlay;
  }

  private framed(entityId: string | undefined): FramedEntity | undefined {
    const entity = entityId === undefined ? undefined : this.controller.entities.get(entityId);
    return entity === undefined
      ? undefined
      : {
          entity,
          health: this.session.vitalsOf(entity.id),
          effects: this.session.effectsOf(entity.id),
          channel: this.session.channelOf(entity.id),
          raise: this.session.raiseOf(entity.id),
        };
  }

  /** The world's time now, and the place the player stands in, for the HUD's clock. */
  private clock(): HUDClock {
    const sector = this.controller.world?.predictedSector;
    return { worldSeconds: this.controller.worldSecondsAt(performance.now()), place: sector === undefined ? undefined : placeName(sector) };
  }

  /** Keys 2 to 6 use the abilities on the belt's slots after slot 1. */
  private useAbilityOnKey(code: string): void {
    const key = /^Digit([2-6])$/.exec(code)?.[1];
    const abilityId = key === undefined ? undefined : this.session.abilities[Number(key) - 2];
    if (abilityId !== undefined) this.session.useAbility(abilityId);
  }

  /** Pushes controller and session state into the DOM. Cheap enough to run per frame. */
  render(): void {
    const overlay = this.controller.presentedOverlay;
    this.overlays.present(overlay);
    this.overlays.renderCharacters(this.controller.characters ?? NO_CHARACTERS, this.controller.awaitingCharacterAnswer);
    // Everything pre-login gives way in the frame the player's own body first appears, not at
    // `enterSpace`, which comes a little before it and on every later join as well.
    const inWorld = this.controller.inWorld;
    setHidden(this.splashVeil, inWorld);
    setHidden(this.splashWordmark, inWorld);
    this.container.classList.toggle('somnio-prelogin', !inWorld);
    this.hud.setShown(inWorld);
    this.overlays.setLogOutOtherBrowsersShown(inWorld && this.controller.otherSessionCount > 0);
    // The last failure says why on the login card, and a silent resume's retry under the wordmark.
    const sessionStatus = this.controller.sessionStatus;
    const status = inWorld || sessionStatus === undefined ? undefined : renderChatLine(sessionStatus, catalogTables, currentLocale());
    this.overlays.showLoginStatus(overlay?.kind === 'login' ? status : undefined);
    this.wordmarkStatus.textContent = overlay === undefined ? (status ?? '') : '';
    const selfId = this.controller.selfId;
    const self = selfId === undefined ? undefined : this.controller.entities.get(selfId);
    const target = this.session.target === undefined ? undefined : this.controller.entities.get(this.session.target);
    this.hud.renderPools(this.session.energy, this.session.winded);
    this.hud.renderRun(this.session.running, this.session.runHeldOff);
    this.hud.renderSlotOne(this.session.engaged, this.session.engageAction(), target?.condition === 'fallen');
    this.hud.renderAbilities(this.session.abilitySlots());
    this.hud.renderLucidity(this.session.lucidity);
    this.hud.renderSelf({
      name: this.controller.selfDisplayName,
      people: this.controller.selfPeople,
      role: this.session.lucidity.role,
      condition: self?.condition ?? 'hale',
      targeted: selfId !== undefined && this.session.target === selfId,
      effects: this.session.effectsOf(selfId),
      channel: this.session.channelOf(selfId),
      raise: this.session.raiseOf(selfId),
    });
    this.servicePanel.render(this.session.servicePanel, this.session.lucidity, this.session.inventory, this.session.tradeLocked());
    // The fallen notice takes the target frame's place while the player lies fallen.
    const framing = inWorld && !this.session.fallen;
    this.hud.renderTarget(framing ? this.framed(this.session.target) : undefined, this.session.gazeLocked);
    this.fallenNotice.render({ fallen: this.session.fallen, raise: this.session.raiseOf(selfId) }, performance.now());
    this.hud.renderChat(this.controller.chatHistory);
    this.hud.renderPlayers(this.controller.players, { own: this.controller.selfDisplayName, target: target?.name });
    this.hud.renderItems(this.session.inventory);
    this.hud.tick(performance.now(), this.clock());
  }
}
