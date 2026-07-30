import { PROTOCOL_BYTE_CAPS, utf8ByteLength } from '@/protocol'
import type { LoginCredentials, OverlayKind, RegistrationForm, VersionSkew } from '@/client'
import { CHARACTER_CLASS, GENDER } from '@/core'
import { t } from '@/i18n'
import { button, checkbox, element, field, select, setHidden } from './dom'

/**
 * The six `OverlayKind` cases, minus `updateRequired`'s Sparkle path — a browser client updates by
 * reloading, so the native "Check for Updates..." button has no analogue and the skew overlay
 * offers a retry instead.
 *
 * Each overlay is built once and shown or hidden, so focus and typed-but-unsubmitted text survive a
 * state change that re-presents the same overlay.
 */

export interface OverlayCallbacks {
  onLogin: (credentials: LoginCredentials) => void
  onRegister: (form: RegistrationForm) => void
  onShowOverlay: (overlay: OverlayKind | undefined) => void
  onResume: () => void
  /** `dismissPresentedOverlay`: back out to the game menu while attached, else to login. */
  onDismissOverlay: () => void
  /** Back out of the registration form to login, dropping its inline error. Bound to Esc and Cancel alike. */
  onCancelRegistration: () => void
  onLeaveGame: () => void
  onRetryConnection: () => void
  onToggleFullscreen: () => void
  appVersion: string
}

/**
 * Options in `CharacterClass` and `Gender` raw-value order. Built as functions rather than module
 * constants so `t` runs after the locale is resolved — and so each key sits in a literal `t('...')`
 * the catalog test's source scan can find.
 */
function characterClassOptions(): { value: string; label: string }[] {
  return [
    { value: String(CHARACTER_CLASS.fighter), label: t('Fighter') },
    { value: String(CHARACTER_CLASS.lancer), label: t('Lancer') },
    { value: String(CHARACTER_CLASS.warrior), label: t('Warrior') },
    { value: String(CHARACTER_CLASS.thief), label: t('Thief') },
    { value: String(CHARACTER_CLASS.hunter), label: t('Hunter') },
    { value: String(CHARACTER_CLASS.gangster), label: t('Gangster') },
    { value: String(CHARACTER_CLASS.cleric), label: t('Cleric') },
    { value: String(CHARACTER_CLASS.mage), label: t('Mage') },
  ]
}

function genderOptions(): { value: string; label: string }[] {
  return [
    { value: String(GENDER.male), label: t('Male') },
    { value: String(GENDER.female), label: t('Female') },
  ]
}

/**
 * Takes the localized title, for the same call-site-scannability reason as `hudBar`. `width` picks
 * the panel's frame: the game menu is a narrow 280pt column, the registration form is wide,
 * everything else takes the default.
 *
 * `heading` covers the two panels `FantasyPanel` builds without a `title:` — registration, which
 * carries none at all, and the credits, which author their own oversized one in the body. The title
 * still reaches the `aria-label`, so the dialog keeps an accessible name that the native panel gets
 * from its window rather than from a heading.
 */
function card(
  title: string,
  body: readonly Node[],
  width: 'default' | 'wide' | 'menu' = 'default',
  heading: 'shown' | 'accessibleOnly' = 'shown'
): HTMLElement {
  const modifier = width === 'default' ? '' : ` overlay-card--${width}`
  const titleNodes = heading === 'shown' ? [element('h1', { className: 'overlay-title', text: title })] : []
  return element('div', {
    className: `fantasy-panel fantasy-panel--opaque overlay-card${modifier}`,
    attributes: { role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    children: [...titleNodes, ...body],
  })
}

function scrim(card: HTMLElement): HTMLElement {
  return element('div', { className: 'overlay-scrim hidden', children: [card] })
}

export class Overlays {
  readonly root: HTMLElement
  readonly loginNickname: HTMLInputElement

  private readonly callbacks: OverlayCallbacks
  /**
   * Keyed by the union rather than by `string`, so adding an `OverlayKind` case fails to build here
   * the way it already does in `AppShell.handleEscape` and the controller's dispatch. Under
   * `Record<string, …>` a missing view compiled fine and `present` simply hid all the others,
   * rendering the new overlay as a blank screen with a green suite.
   */
  private readonly views: Record<OverlayKind['kind'], HTMLElement>
  private readonly loginPassword: HTMLInputElement
  private readonly loginRemember: HTMLInputElement
  private readonly loginError: HTMLElement
  private readonly registration: {
    nickname: HTMLInputElement
    password: HTMLInputElement
    passwordRepeat: HTMLInputElement
    characterClass: HTMLSelectElement
    gender: HTMLSelectElement
    email: HTMLInputElement
    error: HTMLElement
  }
  private readonly skewMessage: HTMLElement
  private presentedKind: OverlayKind['kind'] | undefined

  constructor(callbacks: OverlayCallbacks) {
    this.callbacks = callbacks

    // MARK: Login. Real `type="password"` and standard autocomplete tokens, so a password manager
    // recognizes the form — the whole reason the overlay is DOM rather than something drawn in WebGL.
    const nickname = field(t('Nickname'), {
      autocomplete: 'username',
      maxUTF8Bytes: PROTOCOL_BYTE_CAPS.identifier,
    })
    const password = field(t('Password'), {
      type: 'password',
      autocomplete: 'current-password',
      maxUTF8Bytes: PROTOCOL_BYTE_CAPS.password,
    })
    const remember = checkbox(t('Remember password'), false)
    this.loginNickname = nickname.input
    this.loginPassword = password.input
    this.loginRemember = remember.input
    this.loginError = element('p', { className: 'form-error hidden' })
    const loginForm = element('form', {
      children: [
        nickname.row,
        password.row,
        remember.row,
        this.loginError,
        element('div', {
          className: 'form-actions',
          children: [
            element('button', {
              className: 'fantasy-button',
              text: t('Log In'),
              attributes: { type: 'submit' },
            }),
          ],
        }),
        element('p', {
          className: 'form-note',
          children: [
            button(
              t("If you don't have an account, click here!"),
              () => this.callbacks.onShowOverlay({ kind: 'registration' }),
              { className: 'link-button' }
            ),
          ],
        }),
      ],
    })
    loginForm.addEventListener('submit', (event) => {
      event.preventDefault()
      this.submitLogin()
    })

    // MARK: Registration
    const regNickname = field(t('Nickname:'), {
      autocomplete: 'username',
      maxUTF8Bytes: PROTOCOL_BYTE_CAPS.identifier,
    })
    const regPassword = field(t('Password:'), {
      type: 'password',
      autocomplete: 'new-password',
      maxUTF8Bytes: PROTOCOL_BYTE_CAPS.password,
    })
    const regRepeat = field(t('Password (*):'), {
      type: 'password',
      autocomplete: 'new-password',
      maxUTF8Bytes: PROTOCOL_BYTE_CAPS.password,
    })
    const regClass = select(t('Character:'), characterClassOptions())
    const regGender = select(t('Gender:'), genderOptions())
    const regEmail = field(t('Email:'), {
      type: 'email',
      autocomplete: 'email',
      maxUTF8Bytes: PROTOCOL_BYTE_CAPS.identifier,
    })
    const regError = element('p', { className: 'form-error hidden' })
    this.registration = {
      nickname: regNickname.input,
      password: regPassword.input,
      passwordRepeat: regRepeat.input,
      characterClass: regClass.input,
      gender: regGender.input,
      email: regEmail.input,
      error: regError,
    }
    const registrationForm = element('form', {
      children: [
        regNickname.row,
        regPassword.row,
        regRepeat.row,
        regClass.row,
        regGender.row,
        regEmail.row,
        element('p', { className: 'form-note', text: t('*: repeat') }),
        regError,
        element('div', {
          className: 'form-actions',
          children: [
            // Through the same callback Escape uses, not a direct `onShowOverlay`. `AppShell`
            // clears the inline error there, so backing out with the button rather than the key
            // would carry the previous attempt's "That name is taken." into a reopened form.
            button(t('Cancel'), () => this.callbacks.onCancelRegistration()),
            element('button', {
              className: 'fantasy-button',
              text: t('Sign Up'),
              attributes: { type: 'submit' },
            }),
          ],
        }),
      ],
    })
    registrationForm.addEventListener('submit', (event) => {
      event.preventDefault()
      this.submitRegistration()
    })

    // MARK: Game menu, options, about, version skew
    // A vertical stack of full-width buttons in `GameMenuOverlayView`'s order, not a row of
    // actions: the menu is a 280pt column, and laying it out as a form footer both reorders the
    // entries and squeezes each label until it wraps or clips.
    const gameMenu = element('div', {
      className: 'menu-actions',
      children: [
        button(t('Resume'), () => this.callbacks.onResume()),
        button(t('Options'), () => this.callbacks.onShowOverlay({ kind: 'options' })),
        button(t('Leave Game'), () => this.callbacks.onLeaveGame()),
        button(t('About Somnio'), () => this.callbacks.onShowOverlay({ kind: 'about' })),
      ],
    })

    const options = element('div', {
      children: [
        // Fullscreen lives here rather than being entered automatically: the browser's Esc handling
        // would otherwise steal the key the game menu owns.
        element('div', {
          className: 'menu-actions',
          children: [
            button(t('Fullscreen'), () => this.callbacks.onToggleFullscreen()),
            button(t('Close'), () => this.callbacks.onDismissOverlay()),
          ],
        }),
      ],
    })

    // `AboutOverlayView`'s centred column: its own flanked `largeTitle` heading, the version and
    // copyright, the revival blurb, then the pack credits under a plain rule. Credit order follows
    // the native list — the packs are named in the order the world is built out of them, models
    // first — so the two read the same way down the panel.
    const about = element('div', {
      className: 'about-panel',
      children: [
        element('h1', { className: 'overlay-title overlay-title--large', text: t('Somnio') }),
        element('p', { text: t('Version: %@', this.callbacks.appVersion) }),
        element('p', { className: 'about-caption', text: t('Copyright') }),
        element('p', { className: 'about-caption about-blurb', text: t('Thanks paragraph') }),
        element('hr', { className: 'fantasy-divider' }),
        element('div', {
          className: 'about-credits',
          children: [
            element('p', { text: t('3D characters and props by KayKit.') }),
            element('p', { text: t('Ghost model by Quaternius.') }),
            element('p', { text: t('Floor textures by ambientCG.') }),
            element('p', { text: t('UI borders by Kenney.') }),
          ],
        }),
        element('div', {
          className: 'form-actions',
          children: [button(t('OK'), () => this.callbacks.onDismissOverlay())],
        }),
      ],
    })

    this.skewMessage = element('p')
    const updateRequired = element('div', {
      children: [
        this.skewMessage,
        element('div', {
          className: 'form-actions',
          children: [button(t('Try Again'), () => this.callbacks.onRetryConnection())],
        }),
      ],
    })

    this.views = {
      login: scrim(card(t('Somnio'), [loginForm])),
      registration: scrim(card(t('Sign Up'), [registrationForm], 'wide', 'accessibleOnly')),
      gameMenu: scrim(card(t('Somnio'), [gameMenu], 'menu')),
      options: scrim(card(t('Options'), [options], 'menu')),
      about: scrim(card(t('About Somnio'), [about], 'default', 'accessibleOnly')),
      updateRequired: scrim(card(t('Update required'), [updateRequired])),
    }
    this.root = element('div', { children: Object.values(this.views) })
  }

  present(overlay: OverlayKind | undefined): void {
    for (const [kind, view] of Object.entries(this.views)) {
      setHidden(view, overlay?.kind !== kind)
    }
    if (overlay?.kind === 'updateRequired') this.renderSkew(overlay.skew)
    // Focus only on the transition into a credential form, never on a repaint of one already
    // showing. `AppShell.render` re-presents on every chat line, so focusing unconditionally moves
    // the caret to field one mid-keystroke: the rest of a password being typed lands in the
    // plaintext nickname box and Return submits it as the nickname.
    const entered = overlay?.kind !== this.presentedKind
    this.presentedKind = overlay?.kind
    if (!entered) return
    if (overlay?.kind === 'login') this.loginNickname.focus()
    if (overlay?.kind === 'registration') this.registration.nickname.focus()
  }

  /**
   * Empties every credential field the overlays own — both forms — and unticks "Remember password".
   *
   * Each overlay is built once and shown or hidden, so a field keeps its value for the lifetime of
   * the page unless something clears it. Bound to the controller's `onSessionIdentityEnded`, which
   * is what keeps a departing player's credentials from being handed to whoever opens the login card
   * next on a shared browser. The registration form counts: abandoning it leaves a plaintext
   * password in the DOM that no later login touches, and it is reachable from the same card.
   */
  clearCredentialForms(): void {
    this.loginNickname.value = ''
    this.loginPassword.value = ''
    this.loginRemember.checked = false
    this.showLoginError(undefined)
    this.registration.nickname.value = ''
    this.registration.password.value = ''
    this.registration.passwordRepeat.value = ''
    this.registration.email.value = ''
    this.showRegistrationError(undefined)
  }

  showLoginError(message: string | undefined): void {
    this.loginError.textContent = message ?? ''
    setHidden(this.loginError, message === undefined)
  }

  showRegistrationError(message: string | undefined): void {
    this.registration.error.textContent = message ?? ''
    setHidden(this.registration.error, message === undefined)
  }

  /**
   * `clientOutdated` means the server advertises a newer version than this build understands;
   * `serverOutdated` means the deploy is mid-rollout. Different sentences, because the action the
   * player should take is different.
   */
  private renderSkew(skew: VersionSkew): void {
    this.skewMessage.textContent =
      skew === 'clientOutdated'
        ? t('A newer version is available. Please update your client to keep playing.')
        : t('The server is being updated. Please try again in a few moments.')
  }

  /**
   * In-form pre-validation against the protocol byte caps. The server enforces these too, so this
   * is not the security boundary — it is what turns a silent rejection into a visible message
   * before a round trip.
   */
  private submitLogin(): void {
    const nickname = this.loginNickname.value.trim()
    const password = this.loginPassword.value
    if (utf8ByteLength(nickname) === 0 || utf8ByteLength(nickname) > PROTOCOL_BYTE_CAPS.identifier) {
      this.showLoginError(t('That name uses characters Somnio does not allow.'))
      return
    }
    // Empty as well as over-cap, matching the `!form.password.isEmpty` guard in
    // `LoginOverlayView.isValid(form:)` alongside both byte caps. Only the upper bound was checked
    // here, so a blank password shipped a `login` frame on a round trip that could not succeed; the
    // guard answers immediately with the message the server would have sent anyway.
    //
    // The native client spends that guard differently: `isValid(form:)` *disables* the submit
    // button, so there is nothing to answer. The browser shows the message instead — a deliberate
    // divergence, because a disabled button with no explanation reads as a broken page in a browser,
    // where the player cannot tell a validation gate from a stalled script.
    if (utf8ByteLength(password) === 0 || utf8ByteLength(password) > PROTOCOL_BYTE_CAPS.password) {
      this.showLoginError(t('Bad credentials.'))
      return
    }
    this.showLoginError(undefined)
    this.callbacks.onLogin({ nickname, password, rememberMe: this.loginRemember.checked })
  }

  private submitRegistration(): void {
    const nickname = this.registration.nickname.value.trim()
    const password = this.registration.password.value
    const passwordRepeat = this.registration.passwordRepeat.value
    if (utf8ByteLength(nickname) === 0 || utf8ByteLength(nickname) > PROTOCOL_BYTE_CAPS.identifier) {
      this.showRegistrationError(t('That name uses characters Somnio does not allow.'))
      return
    }
    if (
      utf8ByteLength(password) < PROTOCOL_BYTE_CAPS.minPassword ||
      utf8ByteLength(password) > PROTOCOL_BYTE_CAPS.password ||
      password !== passwordRepeat
    ) {
      this.showRegistrationError(t('Registration failed.'))
      return
    }
    // `RegisterHandler` requires a non-empty, length-bounded email and answers `.failure` without
    // it, which reads as an unexplained rejection. `isValid(form:)` gates on the same two bounds.
    const email = this.registration.email.value.trim()
    if (utf8ByteLength(email) === 0 || utf8ByteLength(email) > PROTOCOL_BYTE_CAPS.identifier) {
      this.showRegistrationError(t('Registration failed.'))
      return
    }
    this.showRegistrationError(undefined)
    // Pre-fill login from the same values before the request goes out, so the overlay a successful
    // registration returns to is already filled in — the ordering `submitRegistration` uses.
    this.loginNickname.value = nickname
    this.loginPassword.value = password
    this.callbacks.onRegister({
      nickname,
      password,
      passwordRepeat,
      characterClass: Number(this.registration.characterClass.value),
      gender: Number(this.registration.gender.value),
      email,
    })
  }
}

/**
 * Full-page notices that replace the game rather than layering over it: no WebGL, a phone-sized
 * viewport, and the first-load asset progress. None has a native analogue — the Swift client bundles
 * its assets and cannot be launched on a phone.
 */
export class BlockingNotices {
  readonly root: HTMLElement

  private readonly webglView: HTMLElement
  private readonly mobileView: HTMLElement
  private readonly loadingView: HTMLElement

  constructor() {
    this.webglView = element('div', {
      className: 'blocking-notice hidden',
      children: [
        card(t('This browser cannot render 3D graphics.'), [
          element('p', {
            text: t(
              'Somnio needs WebGL. Try a current version of Safari, Chrome, or Firefox on a desktop computer.'
            ),
          }),
        ]),
      ],
    })
    this.mobileView = element('div', {
      className: 'blocking-notice hidden',
      children: [
        card(t('Somnio needs a desktop computer.'), [
          element('p', {
            text: t('The game is played with a keyboard and a mouse. Come back from a laptop or desktop.'),
          }),
        ]),
      ],
    })
    this.loadingView = element('div', {
      className: 'blocking-notice hidden',
      children: [card(t('Loading the world...'), [])],
    })
    this.root = element('div', {
      children: [this.loadingView, this.mobileView, this.webglView],
    })
  }

  showWebGLUnavailable(): void {
    setHidden(this.webglView, false)
  }

  showMobileNotice(): void {
    setHidden(this.mobileView, false)
  }

  /**
   * Indeterminate on purpose. `ModelAssets.prewarm()` resolves once for the whole pack and reports
   * nothing along the way, so the only fraction this could ever have shown is 0% — a bar pinned at
   * zero for the entire wait reads as hung, which is worse than no bar. Restoring a real one means
   * threading a per-model completion count out of `prewarm` first.
   */
  setLoading(visible: boolean): void {
    setHidden(this.loadingView, !visible)
  }
}
