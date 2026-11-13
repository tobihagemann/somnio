import { PROTOCOL_BYTE_CAPS, SOMNIO_PROTOCOL_CONSTANTS, utf8ByteLength } from '@somnio/protocol';
import type { CharacterSummaryMessage } from '@somnio/protocol';
import type { LoginCredentials, OverlayKind, RegistrationForm, VersionSkew } from '@/client';
import { PEOPLES, isEmailAddress, isPeople, peopleLabelKey, roleLabelKey } from '@somnio/core';
import type { People } from '@somnio/core';
import { t } from '@/i18n';
import { button, card, checkbox, element, field, replaceChildren, scrim, select, setHidden } from './dom';

/**
 * The `OverlayKind` cases. A browser client updates by reloading, so the version-skew overlay
 * offers a retry rather than an update action.
 *
 * Each overlay is built once and shown or hidden, so focus and typed-but-unsubmitted text survive a
 * state change that re-presents the same overlay.
 */

export interface OverlayCallbacks {
  onLogin: (credentials: LoginCredentials) => void;
  onRegister: (form: RegistrationForm) => void;
  onShowOverlay: (overlay: OverlayKind | undefined) => void;
  onResume: () => void;
  /** `dismissPresentedOverlay`: back out to the game menu while attached, else to login. */
  onDismissOverlay: () => void;
  /** Back out of the registration form to login, dropping its inline error. Bound to Esc and Cancel alike. */
  onCancelRegistration: () => void;
  onLeaveGame: () => void;
  onPlay: (characterId: string) => void;
  onCreateCharacter: (name: string, people: People) => void;
  /** Back out of the New Dreamer form to the card, dropping its inline error. Bound to Esc and Cancel alike. */
  onCancelNewCharacter: () => void;
  onDeleteCharacter: (characterId: string) => void;
  onLogOutOtherBrowsers: () => void;
  onRetryConnection: () => void;
  onToggleFullscreen: () => void;
  appVersion: string;
}

/** Built as a function rather than a module constant so `t` runs after the locale is resolved. */
function peopleOptions(): { value: string; label: string }[] {
  return PEOPLES.map((people) => ({ value: people, label: t(peopleLabelKey(people)) }));
}

/** A people the client does not know shows as sent rather than not at all. */
function peopleName(people: string): string {
  return isPeople(people) ? t(peopleLabelKey(people)) : people;
}

export class Overlays {
  readonly root: HTMLElement;
  readonly loginEmail: HTMLInputElement;

  private readonly callbacks: OverlayCallbacks;
  /**
   * Keyed by the union rather than by `string`, so adding an `OverlayKind` case fails to build here
   * the way it already does in `AppShell.handleEscape` and the controller's dispatch. Under
   * `Record<string, …>` a missing view compiled fine and `present` simply hid all the others,
   * rendering the new overlay as a blank screen with a green suite.
   */
  private readonly views: Record<OverlayKind['kind'], HTMLElement>;
  private readonly loginPassword: HTMLInputElement;
  private readonly loginRemember: HTMLInputElement;
  /** One line under the login form: the form's own check, or else the controller's session status. */
  private readonly loginError: HTMLElement;
  private loginInvalid: string | undefined;
  private loginStatus: string | undefined;
  private readonly registration: {
    email: HTMLInputElement;
    password: HTMLInputElement;
    passwordRepeat: HTMLInputElement;
    error: HTMLElement;
  };
  private readonly characterList: HTMLElement;
  private readonly characterError: HTMLElement;
  private readonly newCharacterButton: HTMLButtonElement;
  private readonly charactersFull: HTMLElement;
  /** What the card's rows were last built from, so a repaint that changed neither leaves the buttons standing. */
  private shownCharacters: { characters: readonly CharacterSummaryMessage[]; locked: boolean } | undefined;
  private readonly newCharacter: {
    name: HTMLInputElement;
    people: HTMLSelectElement;
    submit: HTMLButtonElement;
    error: HTMLElement;
  };
  private readonly deleteMessage: HTMLElement;
  private deleteTarget: CharacterSummaryMessage | undefined;
  private readonly skewMessage: HTMLElement;
  private readonly logOutOtherBrowsers: HTMLButtonElement;
  private presentedKind: OverlayKind['kind'] | undefined;

  constructor(callbacks: OverlayCallbacks) {
    this.callbacks = callbacks;

    // Login. Real `type="password"` and standard autocomplete tokens, so a password manager
    // recognizes the form — the whole reason the overlay is DOM rather than something drawn in WebGL.
    // The email is the account's username, so the login form asks for it as one.
    const email = field(t('Email'), {
      type: 'email',
      autocomplete: 'username',
      maxUTF8Bytes: PROTOCOL_BYTE_CAPS.identifier,
    });
    const password = field(t('Password'), {
      type: 'password',
      autocomplete: 'current-password',
      maxUTF8Bytes: PROTOCOL_BYTE_CAPS.password,
    });
    const remember = checkbox(t('Remember password'), false);
    this.loginEmail = email.input;
    this.loginPassword = password.input;
    this.loginRemember = remember.input;
    this.loginError = element('p', { className: 'form-error hidden' });
    const loginForm = element('form', {
      children: [
        email.row,
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
            button(t("If you don't have an account, click here!"), () => this.callbacks.onShowOverlay({ kind: 'registration' }), { className: 'link-button' }),
          ],
        }),
      ],
    });
    // The address check below and its localized line are the only gate: the browser's own refuses a
    // non-ASCII local part and blocks the submit.
    loginForm.noValidate = true;
    loginForm.addEventListener('submit', (event) => {
      event.preventDefault();
      this.submitLogin();
    });

    const regEmail = field(t('Email:'), {
      type: 'email',
      autocomplete: 'username',
      maxUTF8Bytes: PROTOCOL_BYTE_CAPS.identifier,
    });
    const regPassword = field(t('Password:'), {
      type: 'password',
      autocomplete: 'new-password',
      maxUTF8Bytes: PROTOCOL_BYTE_CAPS.password,
    });
    const regRepeat = field(t('Repeat password:'), {
      type: 'password',
      autocomplete: 'new-password',
      maxUTF8Bytes: PROTOCOL_BYTE_CAPS.password,
    });
    const regError = element('p', { className: 'form-error hidden' });
    this.registration = {
      email: regEmail.input,
      password: regPassword.input,
      passwordRepeat: regRepeat.input,
      error: regError,
    };
    const registrationForm = element('form', {
      children: [
        regEmail.row,
        regPassword.row,
        regRepeat.row,
        regError,
        element('div', {
          className: 'form-actions',
          children: [
            // Through the same callback Escape uses, not a direct `onShowOverlay`. `AppShell`
            // clears the inline error there, so backing out with the button rather than the key
            // would carry the previous attempt's "Another account already uses that email." into a
            // reopened form.
            button(t('Cancel'), () => this.callbacks.onCancelRegistration()),
            element('button', {
              className: 'fantasy-button',
              text: t('Sign Up'),
              attributes: { type: 'submit' },
            }),
          ],
        }),
      ],
    });
    registrationForm.noValidate = true;
    registrationForm.addEventListener('submit', (event) => {
      event.preventDefault();
      this.submitRegistration();
    });

    // The character card: every dreamer of the account with Play and Delete, then a new one or out.
    this.characterList = element('div', { attributes: { role: 'list', 'aria-label': t('Your Dreamers') } });
    this.characterError = element('p', { className: 'form-error hidden' });
    this.charactersFull = element('p', { className: 'form-note hidden', text: t('Delete a dreamer to make room for a new one.') });
    this.newCharacterButton = button(t('New Dreamer'), () => this.callbacks.onShowOverlay({ kind: 'newCharacter' }));
    const characters = element('div', {
      children: [
        this.characterList,
        this.charactersFull,
        this.characterError,
        element('div', {
          className: 'form-actions',
          children: [button(t('Log Out'), () => this.callbacks.onLeaveGame()), this.newCharacterButton],
        }),
      ],
    });

    const newName = field(t('Name:'), { maxUTF8Bytes: PROTOCOL_BYTE_CAPS.identifier });
    const newPeople = select(t('People:'), peopleOptions());
    const newSubmit = element('button', { className: 'fantasy-button', text: t('Create'), attributes: { type: 'submit' } });
    this.newCharacter = { name: newName.input, people: newPeople.input, submit: newSubmit, error: element('p', { className: 'form-error hidden' }) };
    const newCharacterForm = element('form', {
      children: [
        newName.row,
        newPeople.row,
        this.newCharacter.error,
        element('div', {
          className: 'form-actions',
          children: [button(t('Cancel'), () => this.callbacks.onCancelNewCharacter()), newSubmit],
        }),
      ],
    });
    newCharacterForm.addEventListener('submit', (event) => {
      event.preventDefault();
      this.submitNewCharacter();
    });

    this.deleteMessage = element('p', { className: 'service-text' });
    const confirmDelete = button(t('Delete'), () => {
      if (this.deleteTarget !== undefined) this.callbacks.onDeleteCharacter(this.deleteTarget.id);
    });
    const keep = button(t('Cancel'), () => this.callbacks.onShowOverlay({ kind: 'characters' }));
    const deleteCharacter = element('div', {
      children: [this.deleteMessage, element('div', { className: 'menu-actions', children: [confirmDelete, keep] })],
    });

    // Game menu, options, about, version skew
    this.logOutOtherBrowsers = button(t('Log Out Other Browsers'), () => this.callbacks.onShowOverlay({ kind: 'logOutOtherBrowsers' }));
    setHidden(this.logOutOtherBrowsers, true);
    // A vertical stack of full-width buttons, not a row of actions: the menu is a 280pt column, and
    // laying it out as a form footer both reorders the entries and squeezes each label until it wraps or clips.
    const gameMenu = element('div', {
      className: 'menu-actions',
      children: [
        button(t('Resume'), () => this.callbacks.onResume()),
        button(t('Options'), () => this.callbacks.onShowOverlay({ kind: 'options' })),
        button(t('Leave Game'), () => this.callbacks.onLeaveGame()),
        this.logOutOtherBrowsers,
        button(t('About Somnio'), () => this.callbacks.onShowOverlay({ kind: 'about' })),
      ],
    });

    const logOutOtherBrowsers = element('div', {
      children: [
        element('p', { className: 'service-text', text: t('Every other browser that remembers your password will have to log in again.') }),
        element('div', {
          className: 'menu-actions',
          children: [button(t('Log Them Out'), () => this.callbacks.onLogOutOtherBrowsers()), button(t('Cancel'), () => this.callbacks.onDismissOverlay())],
        }),
      ],
    });

    const options = element('div', {
      children: [
        element('p', { className: 'service-text', text: t('Alt+Enter also enters and leaves fullscreen.') }),
        element('div', {
          className: 'menu-actions',
          children: [button(t('Fullscreen'), () => this.callbacks.onToggleFullscreen()), button(t('Close'), () => this.callbacks.onDismissOverlay())],
        }),
      ],
    });

    // `AboutOverlayView`'s centred column: its own flanked `largeTitle` heading, the version and
    // copyright, the revival blurb, then the pack credits under a plain rule. The packs are named
    // in the order the world is built out of them, models first.
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
            element('p', { text: t('UI borders by Kenney.') }),
          ],
        }),
        element('div', {
          className: 'form-actions',
          children: [button(t('OK'), () => this.callbacks.onDismissOverlay())],
        }),
      ],
    });

    this.skewMessage = element('p');
    const updateRequired = element('div', {
      children: [
        this.skewMessage,
        element('div', {
          className: 'form-actions',
          children: [button(t('Try Again'), () => this.callbacks.onRetryConnection())],
        }),
      ],
    });

    this.views = {
      // The wordmark above the card names the game, so the card shows no title of its own.
      login: scrim(card(t('Somnio'), [loginForm], 'default', 'accessibleOnly')),
      registration: scrim(card(t('Sign Up'), [registrationForm], 'default', 'accessibleOnly')),
      characters: scrim(card(t('Your Dreamers'), [characters], 'default', 'accessibleOnly')),
      newCharacter: scrim(card(t('New Dreamer'), [newCharacterForm], 'default', 'accessibleOnly')),
      deleteCharacter: scrim(card(t('Delete Dreamer'), [deleteCharacter], 'menu')),
      gameMenu: scrim(card(t('Somnio'), [gameMenu], 'menu')),
      logOutOtherBrowsers: scrim(card(t('Log Out Other Browsers'), [logOutOtherBrowsers], 'menu')),
      options: scrim(card(t('Options'), [options], 'menu')),
      about: scrim(card(t('About Somnio'), [about], 'default', 'accessibleOnly')),
      updateRequired: scrim(card(t('Update required'), [updateRequired])),
    };
    this.root = element('div', { children: Object.values(this.views) });
  }

  get presentedCard(): HTMLElement | undefined {
    return this.presentedKind === undefined ? undefined : (this.views[this.presentedKind].firstElementChild as HTMLElement);
  }

  present(overlay: OverlayKind | undefined): void {
    for (const [kind, view] of Object.entries(this.views)) {
      setHidden(view, overlay?.kind !== kind);
    }
    if (overlay?.kind === 'updateRequired') this.renderSkew(overlay.skew);
    if (overlay?.kind === 'deleteCharacter') this.renderDeleteCharacter(overlay.character);
    // Focus only on the transition into a credential form, never on a repaint of one already
    // showing. `AppShell.render` re-presents on every chat line, so focusing unconditionally moves
    // the caret to field one mid-keystroke: the rest of a password being typed lands in the
    // plaintext email box and Return submits it as the email.
    const entered = overlay?.kind !== this.presentedKind;
    this.presentedKind = overlay?.kind;
    if (!entered) return;
    if (overlay?.kind === 'login') this.loginEmail.focus();
    if (overlay?.kind === 'registration') this.registration.email.focus();
    if (overlay?.kind === 'newCharacter') this.newCharacter.name.focus();
  }

  /**
   * The card's rows, one per dreamer. While the server answers, Play, Delete, New Dreamer, and the
   * form's Create are locked, and Log Out is not. The shell repaints on every state change, and a row
   * replaced between press and release loses its click.
   */
  renderCharacters(characters: readonly CharacterSummaryMessage[], locked: boolean): void {
    const shown = this.shownCharacters;
    if (shown?.characters === characters && shown.locked === locked) return;
    this.shownCharacters = { characters, locked };
    const full = characters.length >= SOMNIO_PROTOCOL_CONSTANTS.maxCharactersPerAccount;
    setHidden(this.newCharacterButton, full);
    setHidden(this.charactersFull, !full);
    this.newCharacterButton.disabled = locked;
    this.newCharacter.submit.disabled = locked;
    replaceChildren(
      this.characterList,
      characters.length === 0
        ? [element('p', { className: 'form-note', text: t('No dreamers yet. Create one to enter the world.') })]
        : characters.map((character) => this.characterRow(character, locked)),
    );
  }

  private characterRow(character: CharacterSummaryMessage, locked: boolean): HTMLElement {
    const play = button(t('Play'), () => this.callbacks.onPlay(character.id));
    const remove = button(t('Delete'), () => this.callbacks.onShowOverlay({ kind: 'deleteCharacter', character }));
    play.disabled = locked;
    remove.disabled = locked;
    return element('div', {
      className: 'character-row',
      attributes: { role: 'listitem' },
      children: [
        element('div', {
          className: 'character-row__who',
          children: [
            element('strong', { text: character.name }),
            element('span', {
              className: 'character-row__traits',
              children: [
                element('span', { text: peopleName(character.people) }),
                element('span', { text: character.role === undefined ? t('No role yet') : t(roleLabelKey(character.role)) }),
              ],
            }),
          ],
        }),
        play,
        remove,
      ],
    });
  }

  private renderDeleteCharacter(character: CharacterSummaryMessage): void {
    this.deleteTarget = character;
    this.deleteMessage.textContent = t('%@ will be gone for good, with every rank and everything they carry.', character.name);
  }

  setLogOutOtherBrowsersShown(shown: boolean): void {
    setHidden(this.logOutOtherBrowsers, !shown);
  }

  /**
   * Empties every credential field the overlays own — both forms — and unticks "Remember password".
   *
   * Each overlay is built once and shown or hidden, so a field keeps its value for the lifetime of
   * the page unless something clears it. Bound to the controller's `onSessionIdentityEnded`, which
   * is what keeps a departing player's credentials from being handed to whoever opens the login card
   * next on a shared browser. The registration form counts: abandoning it leaves a plaintext
   * password in the DOM that no later login touches, and it is reachable from the same card. The
   * card's last error and a half-typed New Dreamer go too, since they belong to the departing account.
   */
  clearCredentialForms(): void {
    this.loginEmail.value = '';
    this.loginPassword.value = '';
    this.loginRemember.checked = false;
    this.showLoginError(undefined);
    this.registration.email.value = '';
    this.registration.password.value = '';
    this.registration.passwordRepeat.value = '';
    this.showRegistrationError(undefined);
    this.clearNewCharacterForm();
    this.showCharacterError(undefined);
  }

  clearNewCharacterForm(): void {
    this.newCharacter.name.value = '';
    this.newCharacter.people.value = PEOPLES[0];
    this.showNewCharacterError(undefined);
  }

  showLoginError(message: string | undefined): void {
    this.loginInvalid = message;
    this.paintLoginError();
  }

  /** Kept apart from the form's own check, because `render()` repaints often and would otherwise clear it. */
  showLoginStatus(message: string | undefined): void {
    this.loginStatus = message;
    this.paintLoginError();
  }

  private paintLoginError(): void {
    const message = this.loginInvalid ?? this.loginStatus;
    this.loginError.textContent = message ?? '';
    setHidden(this.loginError, message === undefined);
  }

  showRegistrationError(message: string | undefined): void {
    this.registration.error.textContent = message ?? '';
    setHidden(this.registration.error, message === undefined);
  }

  showCharacterError(message: string | undefined): void {
    this.characterError.textContent = message ?? '';
    setHidden(this.characterError, message === undefined);
  }

  showNewCharacterError(message: string | undefined): void {
    this.newCharacter.error.textContent = message ?? '';
    setHidden(this.newCharacter.error, message === undefined);
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
        : t('The server is being updated. Please try again in a few moments.');
  }

  /**
   * In-form pre-validation against the protocol byte caps. The server enforces these too, so this
   * is not the security boundary — it is what turns a silent rejection into a visible message
   * before a round trip.
   */
  private submitLogin(): void {
    const email = this.loginEmail.value.trim();
    const password = this.loginPassword.value;
    if (!isEmailAddress(email) || utf8ByteLength(email) > PROTOCOL_BYTE_CAPS.identifier) {
      this.showLoginError(t('Enter a valid email address.'));
      return;
    }
    // Empty as well as over-cap: a blank password would ship a `login` frame on a round trip that
    // cannot succeed, so the guard answers immediately with the message the server would send
    // anyway. It shows the message rather than disabling the submit button, because a disabled
    // button with no explanation reads as a broken page in a browser, where the player cannot
    // tell a validation gate from a stalled script.
    if (utf8ByteLength(password) === 0 || utf8ByteLength(password) > PROTOCOL_BYTE_CAPS.password) {
      this.showLoginError(t('Bad credentials.'));
      return;
    }
    this.showLoginError(undefined);
    this.callbacks.onLogin({ email, password, rememberMe: this.loginRemember.checked });
  }

  private submitRegistration(): void {
    // The handler answers an email that is not an address, or past the cap, with a bare `failure`,
    // which would read as an unexplained rejection; the same check here says what is wrong.
    const email = this.registration.email.value.trim();
    const password = this.registration.password.value;
    const passwordRepeat = this.registration.passwordRepeat.value;
    if (!isEmailAddress(email) || utf8ByteLength(email) > PROTOCOL_BYTE_CAPS.identifier) {
      this.showRegistrationError(t('Enter a valid email address.'));
      return;
    }
    if (utf8ByteLength(password) < PROTOCOL_BYTE_CAPS.minPassword || utf8ByteLength(password) > PROTOCOL_BYTE_CAPS.password || password !== passwordRepeat) {
      this.showRegistrationError(t('Registration failed.'));
      return;
    }
    this.showRegistrationError(undefined);
    // Pre-fill login from the same values before the request goes out, so the overlay a successful
    // registration returns to is already filled in — the ordering `submitRegistration` uses.
    this.loginEmail.value = email;
    this.loginPassword.value = password;
    this.callbacks.onRegister({ email, password, passwordRepeat });
  }

  /** The server holds a dreamer's name to the name policy; this only spares the round trip for an empty or over-long one. */
  private submitNewCharacter(): void {
    const name = this.newCharacter.name.value.trim();
    if (utf8ByteLength(name) === 0 || utf8ByteLength(name) > PROTOCOL_BYTE_CAPS.identifier) {
      this.showNewCharacterError(t('That name uses characters Somnio does not allow.'));
      return;
    }
    this.showNewCharacterError(undefined);
    this.callbacks.onCreateCharacter(name, this.newCharacter.people.value as People);
  }
}

/**
 * Full-page notices that replace the game rather than layering over it: no WebGL, a phone held
 * upright, and the first-load asset progress.
 */
export class BlockingNotices {
  readonly root: HTMLElement;

  private readonly webglView: HTMLElement;
  private readonly uprightView: HTMLElement;
  private readonly loadingView: HTMLElement;

  constructor() {
    this.webglView = element('div', {
      className: 'blocking-notice hidden',
      children: [
        card(t('This browser cannot render 3D graphics.'), [
          element('p', {
            text: t('Somnio needs WebGL. Try a current version of Safari, Chrome, or Firefox.'),
          }),
        ]),
      ],
    });
    this.uprightView = element('div', {
      className: 'blocking-notice hidden',
      children: [
        card(t('Turn your phone sideways.'), [
          element('p', {
            text: t('Somnio is played in landscape. Tap the ground to walk, and tap a nightmare to target it.'),
          }),
        ]),
      ],
    });
    this.loadingView = element('div', {
      className: 'blocking-notice hidden',
      children: [card(t('Loading the world...'), [])],
    });
    this.root = element('div', {
      children: [this.loadingView, this.uprightView, this.webglView],
    });
  }

  showWebGLUnavailable(): void {
    setHidden(this.webglView, false);
  }

  /** Over everything while the phone is upright, gone once it is turned. */
  setUpright(upright: boolean): void {
    setHidden(this.uprightView, !upright);
  }

  /**
   * Indeterminate on purpose. `ModelAssets.prewarm()` resolves once for the whole pack and reports
   * nothing along the way, so the only fraction this could ever have shown is 0% — a bar pinned at
   * zero for the entire wait reads as hung, which is worse than no bar. Restoring a real one means
   * threading a per-model completion count out of `prewarm` first.
   */
  setLoading(visible: boolean): void {
    setHidden(this.loadingView, !visible);
  }
}
