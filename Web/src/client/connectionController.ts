import {
  LOGIN_RESULT,
  REGISTER_RESULT,
  SOMNIO_PROTOCOL_CONSTANTS,
  WIRE_ENTITY_TYPE,
  assertNever,
  isClientOnlyMessage,
} from '@/protocol'
import type { LoginResultCode, RegisterResultCode, SomnioMessage, WireEntityType } from '@/protocol'
import { heading, sectorFromWire, tempoFromRaw } from '@/core'
import type { Sector, WorldEntity, WorldEntityKind } from '@/core'
import type { GameplayTransport, GameplayTransportEvent } from '@/transport'
import { SessionStore } from './sessionStore'
import type { ChatLine } from './chatLine'
import { noopRenderSurface } from './renderSurface'
import type { WorldRenderSurface } from './renderSurface'

/**
 * Chat lines kept in memory. Well past a panel's worth of scrollback, and far short of where the
 * per-append rebuild cost starts to bite.
 */
const MAX_RETAINED_CHAT_LINES = 500

/**
 * Names retained in the online roster. Far above any real sector's occupancy, and low enough that
 * the per-append collating sort stays cheap.
 */
const MAX_ROSTER_NAMES = 500

/**
 * The tags the controller hands to the gameplay half.
 *
 * Naming the subset as a type makes the ownership split compiler-enforced instead of
 * comment-enforced: the gameplay dispatcher's switch is exhaustive over exactly these five, so
 * routing a sixth tag here without handling it fails to build.
 */
export type GameplayMessage = Extract<
  SomnioMessage,
  { tag: 'serverPosition' | 'serverSay' | 'energy' | 'inventory' | 'adminSay' }
>

/** Mirror of `ClientViewModel.ConnectionState`. */
export type ConnectionState =
  'disconnected' | 'awaitingHello' | 'awaitingLoginResult' | 'awaitingEnterSector' | 'attached'

/** Mirror of `VersionSkew`. Strict equality at the gate means either direction is a rejection. */
export type VersionSkew = 'clientOutdated' | 'serverOutdated'

export type OverlayKind =
  | { kind: 'login' }
  | { kind: 'registration' }
  | { kind: 'about' }
  | { kind: 'updateRequired'; skew: VersionSkew }
  | { kind: 'options' }
  | { kind: 'gameMenu' }

export interface LoginCredentials {
  nickname: string
  password: string
  /** Mirrors the native "Remember password" box; gates session-token issuance. */
  rememberMe: boolean
}

/** The registration form's fields, in `RegisterMessage` shape. */
export interface RegistrationForm {
  nickname: string
  password: string
  passwordRepeat: string
  characterClass: number
  gender: number
  email: string
}

/**
 * How a connection attempt intends to authenticate. Mirrors `ClientViewModel.AuthIntent`, minus the
 * `resume` case — session tokens are browser-only, so the native client has nothing to resume from.
 *
 * One tagged value rather than a set of optional parameters or fields: every combination it can
 * express is one the wire can carry, so a form cannot be queued without the credentials that
 * authenticate it, and a plain login cannot silently inherit a registration it never asked for.
 */
export type AuthIntent =
  | { kind: 'resume' }
  | { kind: 'login'; credentials: LoginCredentials }
  | { kind: 'register'; form: RegistrationForm }

/** Which message the registration overlay shows, mirroring `RegistrationError`. */
export type RegistrationOutcome = 'ok' | 'nicknameExists' | 'nameNotAllowed' | 'failure'

export interface ConnectionControllerOptions {
  transport: GameplayTransport
  renderSurface?: WorldRenderSurface
  sessionStore?: SessionStore
  /** Bounded retry budget for the `alreadyLoggedIn` refresh race. */
  maxResumeRetries?: number
  resolveURL?: () => string
}

/**
 * Mirror of `ClientViewModel`'s connection half.
 *
 * The controller owns the state the UI renders from — including `presentedOverlay` and
 * `isChatInputFocused`, the two predicates the gameplay input gate depends on. That ownership
 * is deliberate: it means the gate is complete before any DOM exists, and the DOM layer calls
 * explicit methods on the controller rather than the controller reaching into the DOM.
 */
export class ConnectionController {
  connectionState: ConnectionState = 'disconnected'
  isChatInputFocused = false

  private overlay: OverlayKind | undefined = { kind: 'login' }

  /**
   * An accessor rather than a plain field, because the controller presents overlays the DOM layer
   * never asked for — `badCredentials` and `alreadyLoggedIn` returning to the login form, a version
   * skew replacing it. A plain field left those assignments correct but invisible: the state said
   * "login overlay" while the DOM kept showing whatever the last render painted, which reads as the
   * dialog having closed on a rejected password. Notifying on write means no site can present an
   * overlay and forget to repaint.
   */
  get presentedOverlay(): OverlayKind | undefined {
    return this.overlay
  }

  set presentedOverlay(overlay: OverlayKind | undefined) {
    this.overlay = overlay
    this.onOverlayChanged?.(overlay)
  }

  onOverlayChanged: ((overlay: OverlayKind | undefined) => void) | undefined

  entities = new Map<number, WorldEntity>()
  players: string[] = []
  selfEntityIndex: number | undefined
  selfDisplayName = ''
  currentSector: Sector | undefined
  currentDateTick = { hour: 12, minute: 0 }

  readonly sessionStore: SessionStore
  readonly renderSurface: WorldRenderSurface

  private readonly transport: GameplayTransport
  private readonly resolveURL: () => string
  private readonly maxResumeRetries: number
  private credentials: LoginCredentials | undefined
  /** Set between `register` being submitted and its `registerResult` arriving. */
  private pendingRegistration: RegistrationForm | undefined
  /** Set while a `redeemSession` is in flight, so `alreadyLoggedIn` can be retried. */
  private resumingWithToken: string | undefined
  private resumeAttempts = 0
  /** Bumped by every explicit authentication, so a resume scheduled before it cannot still fire. */
  private authGeneration = 0
  private chatLines: ChatLine[] = []

  constructor(options: ConnectionControllerOptions) {
    this.transport = options.transport
    this.renderSurface = options.renderSurface ?? noopRenderSurface
    this.sessionStore = options.sessionStore ?? new SessionStore()
    this.resolveURL = options.resolveURL ?? (() => '/ws')
    this.maxResumeRetries = options.maxResumeRetries ?? 3
  }

  get chatHistory(): readonly ChatLine[] {
    return this.chatLines
  }

  /**
   * Structured append, so the locale is resolved at render time rather than baked in here.
   *
   * The history is bounded, unlike the native array. Every append triggers a full scrollback rebuild
   * in the DOM (`renderChat` replaces the whole subtree), so an unbounded history makes the cost per
   * message grow with the session — and chat is peer-driven with no server-side rate limit, so one
   * scripted client sending in a loop would otherwise lock up every other player's tab. The native
   * client can keep everything because SwiftUI's `List` only realises visible rows.
   */
  appendChat(line: ChatLine): void {
    this.chatLines.push(line)
    if (this.chatLines.length > MAX_RETAINED_CHAT_LINES) {
      this.chatLines.splice(0, this.chatLines.length - MAX_RETAINED_CHAT_LINES)
    }
    this.onChatLinesChanged?.()
  }

  onChatLinesChanged: (() => void) | undefined

  // MARK: - Connection lifecycle

  /**
   * Opens a connection. Explicitly supplied credentials always win; a stored session token is
   * redeemed only on a credential-free resume. State is set before the transport starts so the
   * server's immediate `hello` cannot race the assignment.
   *
   * The precedence matters and is not cosmetic. Preferring the token would mean that on a shared
   * browser, someone typing *their own* nickname and password gets signed into whoever last ticked
   * "Remember password" — their credentials never reach the wire, and the players panel would label
   * the hijacked character with the typed name. So an explicit login also clears the store: the
   * user just told us which account they want, and leaving a foreign token behind would hijack the
   * next login too.
   *
   * The clear is **unconditional**, not gated on `rememberMe`. Gating it there would leave the store
   * populated in exactly the case where a foreign token is most dangerous: tick "Remember password",
   * mistype your own password, and nothing clears it — the failure branch below only clears while
   * resuming — so the next reload redeems the previous user's token and signs you in as them. Ticking
   * the box asks for *this* account to be remembered, which is a replacement, not an addition. There
   * is nothing to lose by clearing early: a successful login's `sessionToken` frame repopulates the
   * store moments later, and if issuance fails there is no session worth remembering anyway.
   *
   * An explicit login is **authoritative** over every other authentication input, not just the
   * token. It abandons whatever attempt is already in flight rather than being dropped, and it sets
   * all three inputs — credentials, stored token, queued registration — from the intent it was
   * handed. That is why authentication arrives as one `AuthIntent` rather than as fields the caller
   * assigns beforehand: a field survives the teardown and is read first by `sendAuth`, so an
   * ordinary login could otherwise inherit a registration form it never queued and create an account
   * instead of signing in. A single tagged intent makes that unrepresentable rather than merely
   * unreachable. Only a `resume` intent may no-op on a live connection.
   *
   * The reachable case is not exotic: the `alreadyLoggedIn` resume retry repaints the DOM and leaves
   * a focused login card over a resuming session, and cancelling the registration overlay returns to
   * that same card without ending the socket. Both leave a user typing credentials into a form while
   * this method's state guard is closed.
   */
  connect(intent: AuthIntent): void {
    if (intent.kind === 'resume') {
      if (this.connectionState !== 'disconnected') {
        // A registration queued while a socket was already open must not ride out the next hello
        // and silently re-issue, so the pending form is dropped rather than held.
        this.pendingRegistration = undefined
        return
      }
      this.resumingWithToken = this.sessionStore.load()?.token
    } else {
      if (this.connectionState !== 'disconnected') this.teardown()
      // Derived here rather than by the caller, so a registration cannot reach the wire without the
      // credentials it authenticates with — the two travel as one intent or not at all.
      this.credentials =
        intent.kind === 'register'
          ? { nickname: intent.form.nickname, password: intent.form.password, rememberMe: false }
          : intent.credentials
      this.pendingRegistration = intent.kind === 'register' ? intent.form : undefined
      this.sessionStore.clear()
      this.resumingWithToken = undefined
      // Retires any resume still scheduled. A pending retry fires credential-free, which drops the
      // queued registration — so without this an explicit login or sign-up landing inside the
      // retry window has its own authentication input erased by an attempt it superseded.
      this.authGeneration += 1
    }
    // Not reset here: `scheduleResume` re-enters through this method, so zeroing the counter on
    // every attempt would make the `alreadyLoggedIn` retry budget unreachable and the client would
    // reconnect forever. `beginSession` is the one entry point that zeroes it; `register` goes
    // straight to `connect` and deliberately does not.
    this.connectionState = 'awaitingHello'
    this.transport.connect(this.resolveURL(), (event) => this.handleTransportEvent(event))
  }

  /**
   * Starts a fresh connection attempt from a user action, resetting the bounded-retry budget.
   *
   * Separate from `connect` because the retry path re-enters `connect` itself: a reset inside
   * `connect` is a reset on every retry, which is the same as no bound at all.
   */
  beginSession(intent: AuthIntent = { kind: 'resume' }): void {
    this.resumeAttempts = 0
    this.connect(intent)
  }

  /** Resumes from a stored token with no typed credentials, e.g. on page load after a refresh. */
  resumeStoredSession(): boolean {
    if (this.sessionStore.load() === undefined) return false
    this.beginSession({ kind: 'resume' })
    return true
  }

  /**
   * Opens a connection that authenticates by creating the account rather than logging in. The
   * credentials are pre-filled from the same form so the login overlay the `ok` path returns to
   * is already populated, exactly as `submitRegistration` does natively.
   */
  register(form: RegistrationForm): void {
    this.connect({ kind: 'register', form })
  }

  /**
   * Drops everything this client holds *about the departing player*: the stored token, the typed
   * credentials, any queued registration, the chat scrollback and display name, and — through
   * `onSessionIdentityEnded` — both credential forms' own field values.
   *
   * One method rather than a clear per call site, because these surfaces outlive the connection by
   * design and each has a different lifetime: `sessionStore` is persistent, `credentials` survives
   * a teardown so a reconnect can re-authenticate, and the form fields live as long as the page.
   * A surface missed here is not visible in the UI — the next person sees a login card that looks
   * empty of session state while `sendAuth` still has enough to authenticate as the last one.
   *
   * The scrollback belongs here and not in `teardown`, and the distinction is the whole reason
   * these are two methods. Ending a *session identity* is deliberate — Leave Game, or a revoke
   * from the server — and the next person at a shared browser must not read the previous player's
   * conversation through the login card's scrim. A teardown is not deliberate: it also covers a
   * dropped connection, where the `connectionLost` line explaining what happened is the one thing
   * the player needs to still be there.
   */
  private endSessionIdentity(): void {
    this.sessionStore.clear()
    this.credentials = undefined
    this.pendingRegistration = undefined
    this.resumingWithToken = undefined
    this.chatLines = []
    this.selfDisplayName = ''
    this.onChatLinesChanged?.()
    this.onSessionIdentityEnded?.()
  }

  /** Explicit logout: revoke the token server-side, then drop every credential and tear down. */
  leaveGame(): void {
    const stored = this.sessionStore.load()
    // Both post-login states, not `attached` alone. The server accepts `revokeSession` from the
    // moment the connection is registered, and the player can reach Leave Game in either: the game
    // menu opens whenever no overlay is presented, and `handleEnterSector` clears the overlay while
    // dropping back to `awaitingEnterSector` on every sector load and portal hop. Gating on
    // `attached` alone therefore skipped the revoke on a hop while still clearing the store below —
    // leaving a token that stays redeemable for its full lifetime with nothing left to revoke it.
    const canRevoke = this.connectionState === 'attached' || this.connectionState === 'awaitingEnterSector'
    if (stored !== undefined && canRevoke) {
      this.transport.send({ tag: 'revokeSession', payload: { token: stored.token } })
    }
    // Cleared regardless of whether the revoke was sent or landed. A UI that still claimed a
    // session after a failed revoke would be lying about state it cannot observe.
    //
    // Logging out before the connection is registered leaves the row alive server-side until it
    // expires, because the server protocol-error-closes a `revokeSession` sent that early. Keeping
    // the token to revoke later was considered and rejected: it would mean an explicit Log Out did
    // not log the player out, which is a worse failure than an unreferenced row. The dropped copy
    // was the only one in existence, so nothing can redeem it — the cost is a stale row that
    // `CheckpointService`'s expiry sweep collects, not a live credential.
    this.endSessionIdentity()
    this.teardown()
    this.renderSurface.showSplash()
    this.presentedOverlay = { kind: 'login' }
  }

  setChatInputFocused(focused: boolean): void {
    this.isChatInputFocused = focused
    if (focused) this.onGateClosed?.()
  }

  /**
   * Hook the input layer installs to clear held keys whenever the gameplay gate closes. Routing
   * focus through this method rather than letting the DOM own a local flag is what keeps focus
   * gain clearing held keys on the production path.
   */
  onGateClosed: (() => void) | undefined

  private handleTransportEvent(event: GameplayTransportEvent): void {
    switch (event.kind) {
      case 'message':
        this.dispatch(event.message)
        return
      case 'connectFailed':
        this.appendChat({ kind: 'serverUnreachable' })
        this.endSessionWithRecovery()
        return
      case 'decodeFailed':
        this.appendChat({ kind: 'errorCode', code: String(event.error) })
        this.endSessionWithRecovery()
        return
      case 'unexpectedBinaryFrame':
        this.appendChat({ kind: 'errorCode', code: 'unexpected_binary_frame' })
        this.endSessionWithRecovery()
        return
      case 'peerEOF':
        this.appendChat({ kind: 'connectionLost' })
        this.endSessionWithRecovery()
        return
      default:
        assertNever(event, 'transport event')
    }
  }

  // MARK: - Inbound dispatch

  /**
   * Authentication and session frames belong here; gameplay frames are forwarded to
   * `onGameplayMessage`. Splitting ownership explicitly is what keeps a tag from ending up
   * owned by neither half.
   */
  onGameplayMessage: ((message: GameplayMessage) => void) | undefined

  dispatch(message: SomnioMessage): void {
    // A client-only tag arriving inbound is a hard error, matching the native dispatch.
    if (isClientOnlyMessage(message)) {
      this.appendChat({ kind: 'errorCode', code: 'client_only_tag' })
      this.endSessionWithRecovery()
      return
    }

    switch (message.tag) {
      case 'hello':
        this.handleHello(message.payload.protocolVersion)
        return
      case 'loginResult':
        this.handleLoginResult(message.payload.result)
        return
      case 'registerResult':
        this.handleRegisterResult(message.payload.result)
        return
      case 'sessionToken':
        // Only stored when this client asked for one. Saving whatever arrives would let a future
        // issuance change — or a compromised server — plant a 30-day credential on a machine whose
        // user deliberately left "Remember password" unticked.
        if (this.credentials?.rememberMe === true) {
          // Reported rather than swallowed, matching `ClientViewModel.handleLoginResult`'s
          // `catch` around `CredentialStore.save`: the player asked to be remembered, and a
          // storage refusal is otherwise discovered only on the next visit, as an unexplained
          // login form. The line is a *report*, not a failure — the session itself is fine, which
          // is why nothing here tears down.
          if (!this.sessionStore.save(message.payload.token, message.payload.expiresInSeconds)) {
            this.appendChat({ kind: 'credentialSaveFailed' })
          }
        }
        return
      case 'sessionRevoked':
        // The server has retired this token, so the identity it authenticated is over here too —
        // the same surfaces `leaveGame` drops, for the same reason.
        this.endSessionIdentity()
        return
      case 'enterSector':
        // `sectorFromWire` is a hostile-input boundary and throws on a sector that violates the
        // shared bounds. Matching the native `do`/`catch`: report and tear down, rather than
        // letting the throw escape `dispatch` and leave the controller in a half-loaded sector.
        try {
          this.handleEnterSector(sectorFromWire(message.payload.sector))
        } catch (error) {
          this.appendChat({ kind: 'errorCode', code: String(error) })
          this.endSessionWithRecovery()
        }
        return
      case 'mainCharacter':
        this.handleMainCharacter(message.payload.entityIndex)
        return
      case 'entity':
        this.handleEntity(message)
        return
      case 'leave':
        this.handleLeave(message.payload.entityIndex, message.payload.leftGame)
        return
      case 'dateTick':
        this.currentDateTick = { hour: message.payload.hour, minute: message.payload.minute }
        this.renderSurface.updateDayNightTint(
          message.payload.hour,
          message.payload.minute,
          this.currentSector?.light ?? { indoor: false, brightness: 100 }
        )
        return
      case 'serverPosition':
      case 'serverSay':
      case 'energy':
      case 'inventory':
      case 'adminSay':
        this.onGameplayMessage?.(message)
        return
      default:
        // Exhaustiveness guard. Swift's enum switch is exhaustive by compiler enforcement; a
        // TypeScript switch silently ignores an unhandled tag without this.
        assertNever(message, 'inbound dispatch')
    }
  }

  private handleHello(protocolVersion: number): void {
    if (this.connectionState !== 'awaitingHello') {
      this.appendChat({ kind: 'errorCode', code: 'unexpected_hello' })
      this.endSessionWithRecovery()
      return
    }
    // Strict equality, matching the native gate: a bump rejects clients rather than degrading
    // them, so a newer *or* older server is a rejection.
    if (protocolVersion !== SOMNIO_PROTOCOL_CONSTANTS.helloVersion) {
      const skew: VersionSkew =
        protocolVersion > SOMNIO_PROTOCOL_CONSTANTS.helloVersion ? 'clientOutdated' : 'serverOutdated'
      this.teardown()
      this.presentedOverlay = { kind: 'updateRequired', skew }
      return
    }
    this.connectionState = 'awaitingLoginResult'
    this.sendAuth()
  }

  private sendAuth(): void {
    // Registration outranks both other paths, and the token especially: a stored token
    // authenticates an account that by definition does not exist yet, so redeeming one here would
    // answer `badCredentials` and the account would never be created. This ordering is the only
    // thing that decides it, mirroring the native `if let pendingRegistration` gate.
    const registration = this.pendingRegistration
    if (registration !== undefined) {
      this.transport.send({ tag: 'register', payload: registration })
      return
    }
    // Safe above the credentials branch only because `connect` clears `resumingWithToken` whenever
    // it was handed explicit credentials — the token is set solely on the credential-free resume
    // path. Setting it unconditionally here would make a typed login redeem a stored token instead.
    if (this.resumingWithToken !== undefined) {
      this.transport.send({ tag: 'redeemSession', payload: { token: this.resumingWithToken } })
      return
    }
    const credentials = this.credentials
    if (credentials === undefined) {
      this.teardown()
      this.presentedOverlay = { kind: 'login' }
      return
    }
    this.transport.send({
      tag: 'login',
      payload: {
        nickname: credentials.nickname,
        password: credentials.password,
        // Request-gated: omitted entirely unless the user opted in, which is what keeps the
        // server from volunteering a new tag to a client that never asked for one.
        ...(credentials.rememberMe ? { requestSessionToken: true } : {}),
      },
    })
  }

  private handleLoginResult(result: LoginResultCode): void {
    switch (result) {
      case LOGIN_RESULT.ok:
        this.selfDisplayName = this.credentials?.nickname ?? this.selfDisplayName
        this.connectionState = 'awaitingEnterSector'
        return
      case LOGIN_RESULT.alreadyLoggedIn:
        this.handleAlreadyLoggedIn()
        return
      case LOGIN_RESULT.badCredentials: {
        // Expired, unknown, and revoked tokens are all reported as bad credentials, so a
        // probing client learns nothing about which. Drop the stored token and fall back to
        // the password form.
        const wasResuming = this.resumingWithToken !== undefined
        if (wasResuming) {
          this.sessionStore.clear()
          this.resumingWithToken = undefined
        }
        // The *client* does know which case this was, even though the server deliberately does not
        // say: a rejection during a resume is a dead token, not a wrong password. Reporting
        // "Bad credentials." there would tell a returning player their password is wrong when they
        // never typed one.
        this.appendChat(wasResuming ? { kind: 'sessionExpired' } : { kind: 'badCredentials' })
        this.teardown()
        this.presentedOverlay = { kind: 'login' }
        return
      }
      default:
        assertNever(result, 'login result')
    }
  }

  /**
   * Every outcome ends the socket — the account either exists now or does not, and either way this
   * connection has nothing left to authenticate. Only `ok` returns to the login overlay; the three
   * failures leave the registration overlay up so the form can be corrected in place.
   */
  private handleRegisterResult(result: RegisterResultCode): void {
    this.pendingRegistration = undefined
    this.teardown()
    switch (result) {
      case REGISTER_RESULT.ok:
        this.presentedOverlay = { kind: 'login' }
        this.onRegistrationOutcome?.('ok')
        return
      case REGISTER_RESULT.nicknameExists:
        this.onRegistrationOutcome?.('nicknameExists')
        return
      case REGISTER_RESULT.nameNotAllowed:
        this.onRegistrationOutcome?.('nameNotAllowed')
        return
      case REGISTER_RESULT.failure:
        this.onRegistrationOutcome?.('failure')
        return
      default:
        assertNever(result, 'register result')
    }
  }

  /**
   * Reports the registration verdict to the overlay layer. It is a hook rather than a rendered
   * chat line because none of the outcomes has one natively, and the overlay is where the player
   * is looking.
   */
  onRegistrationOutcome: ((outcome: RegistrationOutcome) => void) | undefined

  /**
   * A refresh can open the resumed connection before the previous socket's cleanup has
   * unregistered the account, so login legitimately answers `alreadyLoggedIn` for a moment.
   * A bounded retry rides that out; the alternative — token-authorized session takeover — would
   * add a whole server-side eviction path for a race that resolves itself in milliseconds.
   */
  private handleAlreadyLoggedIn(): void {
    if (this.resumingWithToken !== undefined && this.resumeAttempts < this.maxResumeRetries) {
      this.resumeAttempts += 1
      this.transport.disconnect()
      this.connectionState = 'disconnected'
      // Announced rather than silent: the retry usually resolves in milliseconds, but when the
      // previous socket is slow to unwind the player is left looking at a dead screen with no idea
      // anything is happening.
      this.appendChat({ kind: 'reconnecting' })
      this.scheduleResume()
      return
    }
    this.appendChat({ kind: 'alreadyLoggedIn' })
    this.teardown()
    this.presentedOverlay = { kind: 'login' }
  }

  /** Overridable so tests drive the retry without real timers. */
  scheduleResume: () => void = () => {
    const generation = this.authGeneration
    setTimeout(() => {
      if (generation !== this.authGeneration) return
      this.connect({ kind: 'resume' })
    }, 250)
  }

  private handleEnterSector(sector: Sector): void {
    // Clear sector-local state before loading so a portal hop cannot leave the previous
    // sector's entities and peers alive alongside the new sector.
    this.entities.clear()
    this.players = []
    this.selfEntityIndex = undefined
    this.currentSector = sector
    this.renderSurface.load(sector, true)
    this.renderSurface.updateDayNightTint(
      this.currentDateTick.hour,
      this.currentDateTick.minute,
      sector.light
    )
    // Back to `awaitingEnterSector` until the next `mainCharacter`, so chat and movement that
    // depend on `selfEntityIndex` cannot fire in the gap during a portal hop.
    this.connectionState = 'awaitingEnterSector'
    this.presentedOverlay = undefined
    this.onSectorChanged?.()
  }

  onSectorChanged: (() => void) | undefined

  /**
   * Fires on every teardown path so the owner can drop per-session state the controller does not
   * hold — the predictor's sub-pixel carry and heartbeat clocks, and the input sampler's held bits.
   */
  onTeardown: (() => void) | undefined

  /**
   * Fires when a session identity ends, so the owner can drop the credential-bearing surfaces the
   * controller does not hold — the login form's field values and its "Remember password" state.
   * Separate from `onTeardown`, which fires on every transport drop and must leave a retry able to
   * re-authenticate.
   */
  onSessionIdentityEnded: (() => void) | undefined

  /**
   * `mainCharacter` is what promotes the connection to `attached`, which is the gate the frame
   * loop reads before running a tick — not `dateTick`, which is only the integration helper's drain
   * sentinel and arrives last for unrelated reasons.
   */
  private handleMainCharacter(entityIndex: number): void {
    this.selfEntityIndex = entityIndex
    this.connectionState = 'attached'
  }

  private handleEntity(message: Extract<SomnioMessage, { tag: 'entity' }>): void {
    const payload = message.payload
    const kind = entityKind(payload.type, payload.entityIndex === this.selfEntityIndex)
    // A token resume has no typed credentials, so `handleLoginResult` had no name to record. The
    // self entity carries the authoritative one — without this, a resumed player's own chat lines
    // render with an empty sender.
    if (kind === 'player' && this.selfDisplayName === '') this.selfDisplayName = payload.name
    const entity: WorldEntity = {
      id: payload.entityIndex,
      kind,
      figure: payload.figure,
      gender: payload.gender,
      position: { x: payload.x, y: payload.y },
      facing: heading(payload.facing),
      tempo: tempoFromRaw(payload.tempo),
      maskSize: { width: payload.maskWidth, height: payload.maskHeight },
      name: payload.name,
    }
    this.entities.set(payload.entityIndex, entity)
    this.renderSurface.placeEntity(entity)
    if (
      (kind === 'peer' || kind === 'player') &&
      !this.players.includes(entity.name) &&
      // The roster dedupes by name while `leave` removes only the name an index currently carries,
      // so re-announcing one entity under fresh names appends without ever removing. `entities` is
      // bounded by the Int16 index space; this is not, and each append re-runs a collating sort and
      // a full panel rebuild. Sector occupancy has no legitimate reason to approach the cap.
      this.players.length < MAX_ROSTER_NAMES
    ) {
      this.players.push(entity.name)
      // `numeric` + `sensitivity: 'base'` is the JS equivalent of the native roster's
      // `localizedStandardCompare` (`ClientViewModel.swift`), the Finder-style collation. A bare
      // `localeCompare` is locale-aware but neither numeric nor base-sensitive, so `Held10` would
      // sort before `Held2` in the browser and after it natively.
      this.players.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
      this.onPlayersChanged?.()
    }
  }

  /**
   * Fires whenever the online roster changes.
   *
   * Without it the players panel only refreshes when something *else* forces a render — a chat
   * line, an energy frame — so a peer who joins quietly is missing from the list, and its count
   * footer disagrees with the characters visibly standing in the sector.
   */
  onPlayersChanged: (() => void) | undefined

  /**
   * Dropping `leave` leaves departed peers rendered forever, which is why it is called out as
   * an easy tag to miss.
   */
  private handleLeave(entityIndex: number, leftGame: boolean): void {
    if (entityIndex === this.selfEntityIndex && leftGame) {
      // The server ended *our* session, so the world on screen is dead. Recovering rather than
      // tearing down bare: this arrives while attached, so a bare teardown would leave the last
      // rendered frame up with Esc inert and only a reload as the way out.
      this.endSessionWithRecovery()
      return
    }
    const leaving = this.entities.get(entityIndex)
    if (leaving === undefined) return
    this.entities.delete(entityIndex)
    this.renderSurface.removeEntity(entityIndex)
    if (leaving.kind === 'peer') {
      this.players = this.players.filter((name) => name !== leaving.name)
      this.onPlayersChanged?.()
      // A peer changing sectors detaches with `leftGame: false`; only a real disconnect is a
      // "left the game" event.
      if (leftGame) this.appendChat({ kind: 'left', playerName: leaving.name })
    }
  }

  /**
   * Ends a session that failed on its own, leaving the player somewhere they can act.
   *
   * `teardown` alone is not enough for a *terminal* failure. Once attached there is no overlay up,
   * so a bare teardown leaves the last frame of a dead world on screen with no dialog — and Esc is
   * deliberately inert while disconnected, because a game menu whose Resume button leads nowhere is
   * worse than none. The player's only way out would be reloading the page.
   *
   * The native client reaches the same state but recovers through Esc, which always opens the game
   * menu, and Leave Game from there. The browser presents the login overlay directly instead: it is
   * the same surface `leaveGame` and the `alreadyLoggedIn` retry already use, so this needs no new
   * UI, and the splash replaces the frozen world behind it. The chat line naming the cause stays
   * readable behind the overlay.
   */
  private endSessionWithRecovery(): void {
    this.teardown()
    // The forms have to be emptied too, not just the in-memory credentials. This path returns the
    // player to the login card without any action on their part — a server restart is enough — and
    // `clearCredentialForms` is what keeps the departing player's password from sitting in a
    // `type="password"` input for whoever opens that card next on a shared browser. `leaveGame` and
    // `sessionRevoked` reach it through `endSessionIdentity`; the failure paths did not.
    this.onSessionIdentityEnded?.()
    this.renderSurface.showSplash()
    this.presentedOverlay = { kind: 'login' }
  }

  private teardown(): void {
    this.transport.disconnect()
    this.onTeardown?.()
    this.connectionState = 'disconnected'
    this.entities.clear()
    this.players = []
    this.selfEntityIndex = undefined
    this.currentSector = undefined
    this.resumingWithToken = undefined
    // Cleared here, not only on `connect`'s early-return branch — that branch runs only when a
    // socket was already open, i.e. never after a teardown. Left set, a registration submitted
    // against an unreachable server survives to the next login and re-issues `register` instead,
    // answering `nicknameExists` for an account the player already has. `resetSession` clears it
    // natively for this exact reason.
    //
    // The credentials go with it — for a login as much as a registration. On a `register` intent
    // both are derived from one form by `connect` and only mean anything together, so dropping the
    // form alone leaves `sendAuth` holding credentials for an account that does not exist. But the
    // login case is worse rather than milder: a `resume` intent is documented credential-free, and
    // `sendAuth` falls back to whatever `credentials` still holds, so a pair surviving a teardown
    // makes the next resume silently re-authenticate as the departing player. The `updateRequired`
    // card's only control is "Try Again", which is exactly that resume — on a shared machine the
    // next person clicks one button and lands in the previous player's account. Clearing
    // unconditionally makes both cases fall to the credential-free branch and the login card.
    this.credentials = undefined
    this.pendingRegistration = undefined
  }
}

/**
 * Wire entity type plus "is this us" to a render kind.
 *
 * A named function over the raw values rather than a nested ternary on bare `0`/`1` literals: the
 * mapping is the kind of thing a reader has to be able to answer at a glance ("which raw type is a
 * monster?"), and `WIRE_ENTITY_TYPE` already names them.
 */
function entityKind(type: WireEntityType, isSelf: boolean): WorldEntityKind {
  switch (type) {
    case WIRE_ENTITY_TYPE.player:
      return isSelf ? 'player' : 'peer'
    case WIRE_ENTITY_TYPE.npc:
      return 'npc'
    case WIRE_ENTITY_TYPE.monster:
      return 'monster'
    default:
      // Exhaustive rather than falling through to `monster`. `ClientViewModel.swift` switches over
      // `payload.type` and the compiler refuses an unhandled case; an added wire type reaching an
      // unguarded fallback here would silently render as a monster — no name plaque, monster
      // collision, monster speech routing — with every suite green.
      return assertNever(type, 'wire entity type')
  }
}
