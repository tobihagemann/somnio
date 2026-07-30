import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AppShell, GamePanels, Overlays, detectDesktop, element, field } from '@/ui'
import { catalogTables } from '@/i18n'
import { CHARACTER_CLASS, GENDER } from '@/core'
import type { RegistrationForm } from '@/client'
import { LOGIN_RESULT, SOMNIO_PROTOCOL_CONSTANTS, encodeSomnioMessage } from '@/protocol'
import type { WireSector } from '@/protocol'
import { fakeSocketFactory } from './helpers/fakeSocket'
import type { FakeSocket } from './helpers/fakeSocket'
import type { ChatLine, InventoryRow } from '@/client'

/** Minimal sector, enough for `enterSector` to reach the overlay-dismissing tail of its handler. */
function loginWireSector(): WireSector {
  return {
    name: 'EdariaMitte',
    version: 1,
    dimensions: { width: 4, height: 4 },
    floorMaterialID: 'grass-meadow',
    light: { indoor: false, brightness: 100 },
    objects: [],
    collisionMasks: [],
    portals: [],
    npcs: [],
    monsterSpawns: [],
    floorPatches: [],
  }
}

/**
 * The DOM layer, against `happy-dom`.
 *
 * WebGL is unavailable here, which is convenient rather than limiting: it exercises the same
 * no-WebGL path a real browser with a blocklisted driver takes, and everything the shell does that
 * is *not* rendering — the overlays, the panels, the host handlers, the notices — is fully driven.
 */

const chromePath = resolve(process.cwd(), 'src/ui/chrome.css')

function noopCallbacks(): ConstructorParameters<typeof GamePanels>[0] {
  return {
    onSubmitChat: () => {},
    onChatFocusChange: () => {},
    onActivateItem: () => {},
    onFloatingHoverChange: () => {},
  }
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
  }
}

describe('panel chrome metrics', () => {
  const css = readFileSync(chromePath, 'utf8')

  it('slices the border image at 36 image pixels', () => {
    // `FantasyChrome.capInset` is 18 *points* against an image the native loader has already
    // halved. A literal 18 here slices at half the intended depth and cuts through the corner
    // ornaments — the single easiest thing to get wrong in this file.
    expect(css).toContain('border-image-slice: 36')
    expect(css).not.toMatch(/border-image-slice:\s*18\b/)
  })

  it('draws the border 18 CSS pixels wide', () => {
    expect(css).toContain('--somnio-cap-inset: 18px')
    expect(css).toContain('border-image-width: var(--somnio-cap-inset)')
  })

  it('reproduces the plate inset and content padding', () => {
    expect(css).toContain('--somnio-plate-inset: 3px')
    expect(css).toContain('--somnio-content-padding: 20px')
  })

  it('uses the four semantic texture stems', () => {
    for (const stem of ['panel-primary', 'panel-button', 'panel-button-hover', 'divider']) {
      expect(css).toContain(`/assets/UI/${stem}.png`)
    }
  })

  it('slices the title flanks so only their middle band stretches', () => {
    const flank = /\.overlay-title::before,\s*\.overlay-title::after\s*\{([^}]*)\}/.exec(css)?.[1]
    expect(flank).toBeDefined()
    // Doubled from `.resizable(capInsets: leading 12, trailing 24)` for the same halved-image
    // reason as the panel border, plus `fill` so the stretchable middle is painted at all.
    expect(flank).toContain('border-image-slice: 0 48 0 24 fill')
    expect(flank).toContain('border-image-width: 0 24px 0 12px')
    // The sheet is 192x44. Scaling it whole into the flank's box squashes the end ornament and
    // the line weight together, which reads as a cramped smudge rather than a broken layout.
    expect(flank).toContain('height: 22px')
    // Anchored to a declaration: the rule's own comment names the mistake it is guarding against.
    expect(flank).not.toMatch(/^\s*background-size:/m)
  })

  it('mirrors the trailing flank so both ornaments face the title', () => {
    // `FantasyFlankedLabel` is [.trailing, label, .leading], and the sheet authors its ornament on
    // the trailing end — so the *right* flank is the mirrored one. Flipping the left one instead
    // turns both ornaments outward, which still renders and still looks deliberate.
    expect(css).toMatch(/\.overlay-title::after\s*\{[^}]*scaleX\(-1\)/)
    expect(css).not.toMatch(/\.overlay-title::before\s*\{[^}]*scaleX\(-1\)/)
  })

  it('lays the chat panel out like its native VStack', () => {
    const panel = /\n\.chat-panel\s*\{([^}]*)\}/.exec(css)?.[1]
    expect(panel).toBeDefined()
    expect(panel).toContain('width: 380px')
    // `chatPanel`'s inner `VStack(spacing: 8)`; without it the scrollback's 3px line margin is the
    // only thing between the history and the input.
    expect(panel).toContain('gap: 8px')

    const field = /\.chat-panel \.fantasy-field\s*\{([^}]*)\}/.exec(css)?.[1]
    // The native text area is 44px: `.frame(height: 52)` is the scroll view, `fantasyFieldChrome()`
    // adds 6px around it and `textContainerInset` takes 4 off the inside. Matching the 52 instead
    // leaves 38px of text — a whole row less, which is what made the field look shallow.
    expect(field).toContain('height: 64px')
    expect(field).toContain('padding: 9px')
    // 44 / 16 is exactly 2.75 rows; `line-height: normal` is ~15.6 and drifts off the native count.
    expect(field).toContain('line-height: 16px')
  })

  it('draws the standalone rule without the ornamented sheet', () => {
    const divider = /\n\.fantasy-divider\s*\{([^}]*)\}/.exec(css)?.[1]
    expect(divider).toBeDefined()
    // `FantasyDivider` is two plain rules with a 3pt gap. Borrowing `divider.png` hangs a
    // half-cut end ornament off every standalone rule in the app.
    expect(divider).not.toContain('divider.png')
    expect(divider).toContain('background-size: 100% 1.5px')
  })
})

describe('the four floating panels', () => {
  it('renders HUD, chat, players, and items', () => {
    const panels = new GamePanels(noopCallbacks(), catalogTables, 'en')

    expect(panels.root.querySelectorAll('.floating')).toHaveLength(4)
    expect(panels.root.querySelector('.chat-scrollback')).not.toBeNull()
    expect(panels.root.querySelector('.trailing-list--players')).not.toBeNull()
    expect(panels.root.querySelector('.trailing-list--items')).not.toBeNull()
    expect(panels.root.querySelectorAll('.hud-bar__track')).toHaveLength(3)
  })

  /** `HUDBarPair` is a bare track with the name in `.help`, so the browser must not draw it either. */
  it('names the energy bars without rendering text beside them', () => {
    const panels = new GamePanels(noopCallbacks(), catalogTables, 'en')

    const tracks = [...panels.root.querySelectorAll('.hud-bar__track')]
    expect(tracks.map((node) => node.getAttribute('aria-label'))).toEqual(['HP', 'Balance', 'Mana'])
    for (const track of tracks) expect(track.textContent).toBe('')

    panels.renderEnergy({
      hpCurrent: 30,
      hpMax: 60,
      balanceCurrent: 1,
      balanceMax: 2,
      manaCurrent: 5,
      manaMax: 5,
    })
    expect(tracks[0]?.getAttribute('aria-label')).toBe('HP 30/60')
    expect(tracks[0]?.getAttribute('title')).toBe('HP 30/60')
  })

  /**
   * `panelToggle` renders `Image(systemName:)` with the text only as a tooltip, so the browser
   * has to carry the label out-of-band or the accessible name is lost with the visible text.
   */
  it('renders the three panel toggles as named icon buttons', () => {
    const panels = new GamePanels(noopCallbacks(), catalogTables, 'en')

    const toggles = [...panels.root.querySelectorAll('.fantasy-button--compact')]
    expect(toggles.map((node) => node.getAttribute('aria-label'))).toEqual(['Chat', 'Players', 'Items'])
    for (const toggle of toggles) {
      expect(toggle.textContent).toBe('')
      expect(toggle.querySelector('svg.fantasy-icon path')?.getAttribute('d')).toBeTruthy()
      expect(toggle.getAttribute('title')).toBe(toggle.getAttribute('aria-label'))
    }
  })

  it('toggles its panel body on click', () => {
    const panels = new GamePanels(noopCallbacks(), catalogTables, 'en')
    const chatBody = panels.root.querySelector('.chat-panel') as HTMLElement
    // Scoped to the button: the scrollback and the chat input carry the same accessible name.
    const toggle = panels.root.querySelector('button[aria-label="Chat"]') as HTMLButtonElement

    expect(chatBody.classList.contains('hidden')).toBe(false)
    toggle.click()
    expect(chatBody.classList.contains('hidden')).toBe(true)
    toggle.click()
    expect(chatBody.classList.contains('hidden')).toBe(false)
  })

  it('scales each energy bar by its own maximum', () => {
    const panels = new GamePanels(noopCallbacks(), catalogTables, 'en')

    panels.renderEnergy({
      hpCurrent: 50,
      hpMax: 100,
      balanceCurrent: 3,
      balanceMax: 4,
      manaCurrent: 0,
      manaMax: 10,
    })

    const widths = [...panels.root.querySelectorAll('.hud-bar__fill')].map(
      (node) => (node as HTMLElement).style.width
    )
    // Pixels against `HUDBarPair.foregroundWidth`'s 148px span, not a percentage of the 150px
    // track: a percentage runs the full bar one pixel past the track's trailing seam.
    expect(widths).toEqual(['74px', '111px', '0px'])
  })

  it('collapses a bar whose maximum arrives as zero instead of rendering NaN', () => {
    const panels = new GamePanels(noopCallbacks(), catalogTables, 'en')

    panels.renderEnergy({
      hpCurrent: 5,
      hpMax: 0,
      balanceCurrent: 0,
      balanceMax: 1,
      manaCurrent: 0,
      manaMax: 1,
    })

    const first = panels.root.querySelector('.hud-bar__fill') as HTMLElement
    expect(first.style.width).toBe('0px')
  })

  it('inserts chat as text, never as markup', () => {
    const panels = new GamePanels(noopCallbacks(), catalogTables, 'en')
    const hostile: ChatLine[] = [
      { kind: 'spokenByPeer', senderName: '<img src=x onerror=alert(1)>', message: '<script>x</script>' },
    ]

    panels.renderChat(hostile)

    // The last row, not the first: the scrollback synthesizes the startup greeting ahead of the
    // delivered lines, as the native `ChatScrollbackView` does.
    const rows = panels.root.querySelectorAll('.chat-line')
    const row = rows[rows.length - 1]
    // Peer names and chat text are attacker-chosen, and a stored session token makes an injected
    // script materially worse than a defaced panel.
    expect(panels.root.querySelector('img')).toBeNull()
    expect(panels.root.querySelector('script')).toBeNull()
    expect(row?.textContent).toContain('<img src=x onerror=alert(1)>')
  })

  /**
   * The native chat panel always opens with this line — `ChatScrollbackView.renderedLines` prepends
   * it rather than storing it — so an empty browser scrollback was a parity gap, not a design choice.
   * Synthesized at render time, so the scrollback cap can never trim it away.
   */
  it('always opens the scrollback with the startup greeting', () => {
    const panels = new GamePanels(noopCallbacks(), catalogTables, 'en')

    panels.renderChat([])
    expect(panels.root.querySelector('.chat-line')?.textContent).toBe('Welcome to Somnio!')

    panels.renderChat([{ kind: 'joined', playerName: 'Saibot' }])
    const rows = panels.root.querySelectorAll('.chat-line')
    expect(rows).toHaveLength(2)
    expect(rows[0]?.textContent).toBe('Welcome to Somnio!')
  })

  it('inserts a player name as text, never as markup', () => {
    const panels = new GamePanels(noopCallbacks(), catalogTables, 'en')

    panels.renderPlayers(['<b>bold</b>'])

    const row = panels.root.querySelector('.trailing-list--players .list-row')
    expect(row?.querySelector('b')).toBeNull()
    expect(row?.textContent).toBe('<b>bold</b>')
  })

  it('labels inventory rows from the item table and marks the equipped one', () => {
    const panels = new GamePanels(noopCallbacks(), catalogTables, 'en')
    const rows: InventoryRow[] = [
      { slot: 0, category: 0, itemId: 0, extras: [{ key: 'gold', value: 7 }], equippedHand: undefined },
      { slot: 1, category: 1, itemId: 0, extras: [], equippedHand: 1 },
    ]

    panels.renderItems(rows)

    const rowNodes = [...panels.root.querySelectorAll('.trailing-list--items .list-row')]
    expect(rowNodes.map((node) => node.querySelector('.list-row__name')?.textContent)).toEqual([
      'Purse',
      'Cudgel',
    ])
    // `ItemsListView` marks the hand rather than restyling the row; the player never picks one.
    expect(rowNodes.map((node) => node.querySelector('.list-row__marker')?.textContent)).toEqual(['', '[R]'])
  })

  /** Both trailing lists carry a count footer natively; neither had one in the browser. */
  it('renders the Players and Items count footers', () => {
    const panels = new GamePanels(noopCallbacks(), catalogTables, 'en')

    panels.renderPlayers(['Greta', 'Tobi'])
    panels.renderItems([
      { slot: 0, category: 0, itemId: 0, extras: [], equippedHand: undefined },
      { slot: 1, category: 1, itemId: 0, extras: [], equippedHand: 0 },
      { slot: 2, category: 9, itemId: 9, extras: [], equippedHand: undefined },
    ])

    const footers = [...panels.root.querySelectorAll('.list-footer')].map((node) => node.textContent)
    expect(footers).toEqual(['Players: 2', 'Items: 3'])
  })

  /** The rule between scrollback and input has no counterpart in `chatPanel`. */
  it('puts no divider between the scrollback and the chat input', () => {
    const panels = new GamePanels(noopCallbacks(), catalogTables, 'en')
    expect(panels.root.querySelector('.chat-panel .fantasy-divider')).toBeNull()
  })

  /**
   * `ReturnSubmittingTextView` calls `makeFirstResponder(nil)` after `onSubmit`, and the blank case
   * takes the same path — the blur sits outside the guard. Without it the gameplay gate stays closed
   * on `isChatInputFocused` and WASD is dead after every line the player sends.
   */
  it.each([
    { label: 'a sent line', text: 'hallo', submits: ['hallo'] },
    { label: 'a blank line', text: '   ', submits: [] },
  ])('hands the keyboard back after Enter on $label', ({ text, submits }) => {
    const submitted: string[] = []
    const focusEvents: boolean[] = []
    const panels = new GamePanels(
      {
        ...noopCallbacks(),
        onSubmitChat: (line) => submitted.push(line),
        onChatFocusChange: (focused) => focusEvents.push(focused),
      },
      catalogTables,
      'en'
    )
    // `blur()` only fires the event when the element actually holds focus, so it has to be in the
    // document and focused first — a detached element would pass this vacuously.
    document.body.append(panels.root)
    panels.chatInput.focus()
    panels.chatInput.value = text

    panels.chatInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))

    expect(submitted).toEqual(submits)
    expect(panels.chatInput.value).toBe('')
    expect(focusEvents).toEqual([true, false])
    expect(document.activeElement).not.toBe(panels.chatInput)
    panels.root.remove()
  })

  it('swallows Shift-Enter rather than inserting a line break', () => {
    const submitted: string[] = []
    const panels = new GamePanels(
      { ...noopCallbacks(), onSubmitChat: (text) => submitted.push(text) },
      catalogTables,
      'en'
    )
    document.body.append(panels.root)
    panels.chatInput.focus()
    panels.chatInput.value = 'zwei'

    panels.chatInput.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true })
    )

    expect(submitted).toEqual([])
    // Focus is kept — the player is still composing — but the keystroke inserts nothing, because a
    // newline reaches no renderer: the bubble wrap tokenizes on spaces and canvas text drops it.
    expect(document.activeElement).toBe(panels.chatInput)
    expect(panels.chatInput.value).toBe('zwei')
    panels.root.remove()
  })

  it('reports chat focus so the caller can close the gameplay gate', () => {
    const focusEvents: boolean[] = []
    const panels = new GamePanels(
      { ...noopCallbacks(), onChatFocusChange: (focused) => focusEvents.push(focused) },
      catalogTables,
      'en'
    )

    panels.chatInput.dispatchEvent(new FocusEvent('focus'))
    panels.chatInput.dispatchEvent(new FocusEvent('blur'))

    expect(focusEvents).toEqual([true, false])
  })

  it('reports hover as an aggregate, so sliding between panels does not flicker', () => {
    const hovers: boolean[] = []
    const panels = new GamePanels(
      { ...noopCallbacks(), onFloatingHoverChange: (hovering) => hovers.push(hovering) },
      catalogTables,
      'en'
    )
    const [first, second] = [...panels.root.querySelectorAll('.floating')]

    // Enter the second before leaving the first — the reorder a real cursor produces.
    first?.dispatchEvent(new Event('pointerenter'))
    second?.dispatchEvent(new Event('pointerenter'))
    first?.dispatchEvent(new Event('pointerleave'))

    expect(hovers).toEqual([true])
  })
})

describe('overlays', () => {
  it('presents exactly one overlay at a time', () => {
    const overlays = new Overlays(overlayCallbacks())

    overlays.present({ kind: 'gameMenu' })

    const visible = [...overlays.root.querySelectorAll('.overlay-scrim')].filter(
      (node) => !node.classList.contains('hidden')
    )
    expect(visible).toHaveLength(1)
  })

  it('hides every overlay when none is presented', () => {
    const overlays = new Overlays(overlayCallbacks())
    overlays.present({ kind: 'login' })

    overlays.present(undefined)

    const visible = [...overlays.root.querySelectorAll('.overlay-scrim')].filter(
      (node) => !node.classList.contains('hidden')
    )
    expect(visible).toHaveLength(0)
  })

  it('uses a real password input with autocomplete tokens', () => {
    const overlays = new Overlays(overlayCallbacks())

    const password = overlays.root.querySelector('input[type="password"]')
    // The whole reason the login form is DOM rather than drawn in WebGL: a password manager has to
    // be able to recognize and fill it.
    expect(password).not.toBeNull()
    expect(password?.getAttribute('autocomplete')).toBe('current-password')
    expect(overlays.loginNickname.getAttribute('autocomplete')).toBe('username')
  })

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
    let attempts = 0
    const overlays = new Overlays({ ...overlayCallbacks(), onLogin: () => (attempts += 1) })
    overlays.present({ kind: 'login' })
    overlays.loginNickname.value = nickname
    ;(overlays.root.querySelector('input[type="password"]') as HTMLInputElement).value = password

    overlays.root.querySelector('form')?.dispatchEvent(new Event('submit', { cancelable: true }))

    expect(attempts).toBe(0)
    expect(overlays.root.querySelector('.form-error')?.classList.contains('hidden')).toBe(false)
  })

  it('passes a valid login through with the remember-me flag', () => {
    const logins: { nickname: string; rememberMe: boolean }[] = []
    const overlays = new Overlays({
      ...overlayCallbacks(),
      onLogin: (credentials) => logins.push(credentials),
    })
    overlays.present({ kind: 'login' })
    overlays.loginNickname.value = 'Tester'
    const password = overlays.root.querySelector('input[type="password"]') as HTMLInputElement
    password.value = 'hunter22'
    const remember = overlays.root.querySelector('input[type="checkbox"]') as HTMLInputElement
    remember.checked = true

    overlays.root.querySelector('form')?.dispatchEvent(new Event('submit', { cancelable: true }))

    expect(logins).toEqual([{ nickname: 'Tester', password: 'hunter22', rememberMe: true }])
  })

  it('words the version-skew message differently in each direction', () => {
    const overlays = new Overlays(overlayCallbacks())

    overlays.present({ kind: 'updateRequired', skew: 'clientOutdated' })
    const outdatedClient = overlays.root.textContent ?? ''
    overlays.present({ kind: 'updateRequired', skew: 'serverOutdated' })
    const outdatedServer = overlays.root.textContent ?? ''

    // Each direction against its own sentence, not merely against the other: asserting only that
    // the two differ holds with the arms swapped, which tells a player on an old client to wait for
    // a deploy that already finished, and a player mid-rollout to go and find an update that does
    // not exist. Those are the two wrong answers this branch exists to avoid.
    expect(outdatedClient).toContain('update your client')
    expect(outdatedServer).toContain('server is being updated')
    expect(outdatedClient).not.toContain('server is being updated')
    expect(outdatedServer).not.toContain('update your client')
  })

  it('offers no Sparkle update path', () => {
    const overlays = new Overlays(overlayCallbacks())

    // A browser client updates by reloading; a "Check for Updates..." button would do nothing.
    expect(overlays.root.textContent).not.toContain('Check for Updates')
  })

  it('names the titleless dialogs without giving them a visible heading', () => {
    const overlays = new Overlays(overlayCallbacks())

    // Registration and the credits are the two panels `FantasyPanel` builds with no `title:`. The
    // accessible name has to survive anyway, because a DOM dialog has no window to borrow one from.
    for (const name of ['Sign Up', 'About Somnio']) {
      const dialog = overlays.root.querySelector(`[aria-label="${name}"]`)
      expect(dialog, name).not.toBeNull()
      expect(dialog?.querySelector(':scope > .overlay-title')?.textContent ?? '').not.toBe(name)
    }
  })

  it('credits the asset packs in the native order under the credits heading', () => {
    const overlays = new Overlays(overlayCallbacks())
    const about = overlays.root.querySelector('[aria-label="About Somnio"]')

    expect(about?.querySelector('.overlay-title--large')?.textContent).toBe('Somnio')
    expect([...(about?.querySelectorAll('.about-credits p') ?? [])].map((node) => node.textContent)).toEqual([
      '3D characters and props by KayKit.',
      'Ghost model by Quaternius.',
      'Floor textures by ambientCG.',
      'UI borders by Kenney.',
    ])
  })

  it('carries the revival blurb resolved out of the catalog', () => {
    const overlays = new Overlays(overlayCallbacks())

    const blurb = overlays.root.querySelector('.about-blurb')?.textContent ?? ''
    // Asserting on the years rather than a sentence: they are the same in both catalog locales, so
    // this fails on a missing key (which renders as the bare key) without pinning the prose.
    expect(blurb).toContain('2003')
    expect(blurb).not.toBe('Thanks paragraph')
  })
})

describe('field helpers', () => {
  it('associates the label with its input', () => {
    const { row, input } = field('Nickname')

    const label = row.querySelector('label')
    expect(label?.getAttribute('for')).toBe(input.id)
    expect(input.id.length).toBeGreaterThan(0)
  })

  /**
   * Slugifying drops punctuation, so the registration form's "Password:" and "Password (*):"
   * collapse to the same slug. Sharing an id points both labels at the first input and leaves the
   * repeat field with no accessible name and no password-manager association at all.
   */
  it('gives labels that slugify identically their own ids', () => {
    const first = field('Password:')
    const second = field('Password (*):')

    expect(first.input.id).not.toBe(second.input.id)
    expect(first.row.querySelector('label')?.getAttribute('for')).toBe(first.input.id)
    expect(second.row.querySelector('label')?.getAttribute('for')).toBe(second.input.id)
  })
})

describe('the app shell in a host that cannot render', () => {
  let container: HTMLElement

  beforeEach(() => {
    container = element('div')
    document.body.append(container)
  })

  afterEach(() => {
    container.remove()
  })

  it('shows the WebGL notice and never a blank canvas', () => {
    new AppShell({ container, capabilities: { hasWebGL: false, isDesktop: true } })

    const notice = container.querySelector('.blocking-notice:not(.hidden)')
    expect(notice).not.toBeNull()
    expect(notice?.textContent).toContain('WebGL')
  })

  it('shows the desktop-only notice at a handheld viewport', () => {
    new AppShell({ container, capabilities: { hasWebGL: true, isDesktop: false } })

    const notice = container.querySelector('.blocking-notice:not(.hidden)')
    expect(notice?.textContent).toContain('keyboard')
  })

  it('prefers the mobile notice over the WebGL one when both apply', () => {
    // A phone with no WebGL is still first and foremost the wrong device; telling the player to try
    // a different browser would be advice they cannot act on.
    new AppShell({ container, capabilities: { hasWebGL: false, isDesktop: false } })

    const visible = [...container.querySelectorAll('.blocking-notice:not(.hidden)')]
    expect(visible).toHaveLength(1)
    expect(visible[0]?.textContent).toContain('keyboard')
  })

  it('builds no scene when the host cannot render one', () => {
    const shell = new AppShell({ container, capabilities: { hasWebGL: false, isDesktop: true } })

    // The controller falls back to the no-op surface, so nothing downstream has to null-check.
    expect(shell.scene).toBeUndefined()
    expect(shell.controller.connectionState).toBe('disconnected')
  })
})

/**
 * Driven from the socket rather than from the controller, because that is where the gap was: the
 * controller re-presented the login overlay correctly on a rejected password and the DOM never
 * heard about it, so `presentedOverlay` assertions passed while the dialog stayed shut.
 */
describe('the login overlay across an authentication attempt', () => {
  let container: HTMLElement

  beforeEach(() => {
    container = element('div')
    document.body.append(container)
  })

  afterEach(() => {
    container.remove()
  })

  function loginShell(): { shell: AppShell; socket: () => FakeSocket; dialogVisible: () => boolean } {
    const { factory, latest } = fakeSocketFactory()
    const shell = new AppShell({
      container,
      capabilities: { hasWebGL: true, isDesktop: true },
      startRendering: false,
      socketFactory: factory,
    })
    const dialogVisible = () => {
      const scrim = container.querySelector('[aria-label="Somnio"]')?.closest('.overlay-scrim')
      return scrim !== null && scrim !== undefined && !scrim.classList.contains('hidden')
    }
    return { shell, socket: latest, dialogVisible }
  }

  function submitLogin(shell: AppShell, container: HTMLElement): void {
    shell.overlays.loginNickname.value = 'Tester'
    const password = container.querySelector('input[type="password"]') as HTMLInputElement
    password.value = 'hunter22'
    container.querySelector('form')?.dispatchEvent(new Event('submit', { cancelable: true }))
  }

  it('keeps the dialog up while the login is still in flight', () => {
    const { shell, socket, dialogVisible } = loginShell()
    expect(dialogVisible()).toBe(true)

    submitLogin(shell, container)
    socket().open()
    socket().deliverText(
      encodeSomnioMessage({
        tag: 'hello',
        payload: { protocolVersion: SOMNIO_PROTOCOL_CONSTANTS.helloVersion },
      })
    )

    // `submitLogin` natively does not touch the overlay; dismissing on submit leaves a rejected
    // password with nothing on screen to return to.
    expect(shell.controller.connectionState).toBe('awaitingLoginResult')
    expect(dialogVisible()).toBe(true)
  })

  it('leaves the dialog open when the server rejects the credentials', () => {
    const { shell, socket, dialogVisible } = loginShell()
    submitLogin(shell, container)
    socket().open()
    socket().deliverText(
      encodeSomnioMessage({
        tag: 'hello',
        payload: { protocolVersion: SOMNIO_PROTOCOL_CONSTANTS.helloVersion },
      })
    )

    socket().deliverText(
      encodeSomnioMessage({ tag: 'loginResult', payload: { result: LOGIN_RESULT.badCredentials } })
    )

    expect(dialogVisible()).toBe(true)
    expect(shell.controller.connectionState).toBe('disconnected')
    // The reason goes to the chat scrollback rather than inline in the form, as natively — the
    // registration overlay is the only one that carries its error in the panel. So the scrollback
    // has to be *readable* behind the overlay, which is why the panels are not gated on the
    // connection: with the socket torn down, a state-gated panel would hide the explanation.
    const scrollback = container.querySelector('.chat-scrollback')
    expect(scrollback?.textContent ?? '').not.toBe('')
    expect(scrollback?.closest('.floating')?.classList.contains('hidden')).toBe(false)
    expect(shell.panels.root.classList.contains('hidden')).toBe(false)
  })

  it('replaces the dialog with the version notice on a skewed hello', () => {
    const { shell, socket, dialogVisible } = loginShell()
    submitLogin(shell, container)
    socket().open()

    socket().deliverText(
      encodeSomnioMessage({
        tag: 'hello',
        payload: { protocolVersion: SOMNIO_PROTOCOL_CONSTANTS.helloVersion + 1 },
      })
    )

    // The same unrendered-assignment bug: the skew overlay is presented from the hello handler,
    // which no chat line or session change follows.
    expect(dialogVisible()).toBe(false)
    expect(shell.controller.presentedOverlay?.kind).toBe('updateRequired')
    const notice = container.querySelector('[aria-label="Update required"]')?.closest('.overlay-scrim')
    expect(notice?.classList.contains('hidden')).toBe(false)
  })

  it('takes the dialog down once the world arrives', () => {
    const { shell, socket, dialogVisible } = loginShell()
    submitLogin(shell, container)
    socket().open()
    socket().deliverText(
      encodeSomnioMessage({
        tag: 'hello',
        payload: { protocolVersion: SOMNIO_PROTOCOL_CONSTANTS.helloVersion },
      })
    )
    socket().deliverText(encodeSomnioMessage({ tag: 'loginResult', payload: { result: LOGIN_RESULT.ok } }))
    expect(dialogVisible()).toBe(true)

    socket().deliverText(encodeSomnioMessage({ tag: 'enterSector', payload: { sector: loginWireSector() } }))

    expect(dialogVisible()).toBe(false)
    expect(shell.controller.presentedOverlay).toBeUndefined()
  })
})

describe('desktop detection', () => {
  const nativeWidth = window.innerWidth

  afterEach(() => {
    // happy-dom's navigator is shared across tests in the file, so the stub has to be undone or
    // every later `matchMedia('(pointer: coarse)')` keeps answering true.
    Object.defineProperty(window.navigator, 'maxTouchPoints', { value: 0, configurable: true })
    Object.defineProperty(window, 'innerWidth', { value: nativeWidth, configurable: true })
  })

  it('treats a wide viewport as desktop even with a coarse pointer', () => {
    // A touchscreen laptop has a coarse pointer and a real keyboard, so the pointer alone is not
    // enough to send the player away.
    //
    // The stub is what makes this test mean what its name says: happy-dom derives
    // `(pointer: coarse)` from `navigator.maxTouchPoints`, which defaults to 0, so without it the
    // coarse branch is never taken and the assertion would hold for `return true`.
    Object.defineProperty(window.navigator, 'maxTouchPoints', { value: 1, configurable: true })
    expect(window.matchMedia('(pointer: coarse)').matches).toBe(true)

    expect(detectDesktop()).toBe(true)
  })

  it('sends a coarse-pointer handheld to the desktop-only notice', () => {
    // The other half of the predicate. Without a case that asserts `false`, every assertion in
    // this block holds for `return true` — and so does inverting the query to `(pointer: fine)`,
    // which would send desktop players away and let phones in.
    Object.defineProperty(window.navigator, 'maxTouchPoints', { value: 1, configurable: true })
    Object.defineProperty(window, 'innerWidth', { value: 480, configurable: true })

    expect(detectDesktop()).toBe(false)
  })

  it('treats a narrow window with a fine pointer as desktop', () => {
    // A desktop browser dragged narrow is still a desktop: the viewport alone must not decide,
    // or a resized window loses its keyboard controls mid-session.
    Object.defineProperty(window, 'innerWidth', { value: 480, configurable: true })

    expect(window.matchMedia('(pointer: coarse)').matches).toBe(false)
    expect(detectDesktop()).toBe(true)
  })
})

describe('the registration form validates before it sends', () => {
  let container: HTMLElement

  beforeEach(() => {
    container = element('div')
    document.body.append(container)
  })

  afterEach(() => {
    container.remove()
  })

  interface RegistrationRig {
    fields: Record<'nickname' | 'password' | 'repeat' | 'email', HTMLInputElement>
    selects: Record<'characterClass' | 'gender', HTMLSelectElement>
    lastForm: () => RegistrationForm | undefined
    submit: () => void
    forms: number
    error: () => string
    shell: AppShell
  }

  function registrationRig(container: HTMLElement): RegistrationRig {
    let submissions = 0
    let lastForm: RegistrationForm | undefined
    const shell = new AppShell({
      container,
      capabilities: { hasWebGL: true, isDesktop: true },
      startRendering: false,
      socketFactory: fakeSocketFactory().factory,
    })
    shell.overlays.present({ kind: 'registration' })
    const rig = {
      shell,
      get forms() {
        return submissions
      },
    } as unknown as RegistrationRig

    // The registration card is the second dialog; its form carries six rows where login has two.
    const forms = [...container.querySelectorAll('form')]
    const form = forms.find((each) => each.querySelectorAll('input, select').length >= 6)
    if (form === undefined) throw new Error('registration form not found')
    const inputs = [...form.querySelectorAll('input')]
    const passwords = inputs.filter((each) => each.type === 'password')
    const texts = inputs.filter((each) => each.type !== 'password')
    const nickname = texts[0]
    const email = texts.at(-1)
    const password = passwords[0]
    const repeat = passwords[1]
    if (nickname === undefined || email === undefined || password === undefined || repeat === undefined) {
      throw new Error('registration fields not found')
    }

    shell.controller.register = (form) => {
      submissions += 1
      lastForm = form
    }

    const selectList = form.querySelectorAll('select')
    const characterClass = selectList[0]
    const gender = selectList[1]
    if (characterClass === undefined || gender === undefined) {
      throw new Error('registration selects not found')
    }

    return Object.assign(rig, {
      fields: { nickname, password, repeat, email },
      selects: { characterClass, gender },
      lastForm: () => lastForm,
      submit: () => form.dispatchEvent(new Event('submit', { cancelable: true })),
      error: () => form.parentElement?.querySelector('.form-error')?.textContent ?? '',
    })
  }

  function fill(rig: RegistrationRig, overrides: Partial<Record<string, string>> = {}): void {
    rig.fields.nickname.value = overrides['nickname'] ?? 'Tester'
    rig.fields.password.value = overrides['password'] ?? 'hunter22'
    rig.fields.repeat.value = overrides['repeat'] ?? 'hunter22'
    rig.fields.email.value = overrides['email'] ?? 'tester@example.com'
  }

  it('sends when every field is valid', () => {
    const rig = registrationRig(container)
    fill(rig)
    rig.submit()
    expect(rig.forms).toBe(1)
  })

  /**
   * The class and gender selects are the one pair a player can never correct afterwards —
   * `CharacterClass` is fixed at account creation — and they travel as opaque `Int16`s with no
   * downstream check, so a swap or a hard-coded value reaches the account silently. Asserting the
   * call happened is not enough: it fires either way.
   */
  it('carries the chosen class and gender through to the register call', () => {
    const rig = registrationRig(container)
    fill(rig)
    rig.selects.characterClass.value = String(CHARACTER_CLASS.mage)
    rig.selects.gender.value = String(GENDER.female)
    rig.submit()

    expect(rig.lastForm()?.characterClass).toBe(CHARACTER_CLASS.mage)
    expect(rig.lastForm()?.gender).toBe(GENDER.female)
  })

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
    const rig = registrationRig(container)
    fill(rig, overrides)
    rig.submit()
    expect(rig.forms).toBe(0)
    expect(rig.error()).not.toBe('')
  })

  /** A successful registration returns to a login form that is already filled in. */
  it('pre-fills the login form from the registration values', () => {
    const rig = registrationRig(container)
    fill(rig)
    rig.submit()
    expect(rig.shell.overlays.loginNickname.value).toBe('Tester')
  })
})

describe('leaving the game clears every credential surface', () => {
  let container: HTMLElement

  beforeEach(() => {
    container = element('div')
    document.body.append(container)
  })

  afterEach(() => {
    container.remove()
  })

  /**
   * Every credential-bearing field in the card, seeded so a clear is observable. Shared because the
   * cases below differ only in what triggers the clear: duplicating the sweep would mean a new
   * field type could be added to one copy and missed by the other, leaving the wiring cases green
   * while a plaintext password survived in the DOM.
   */
  function credentialRig(host: HTMLElement) {
    const { factory, latest } = fakeSocketFactory()
    const shell = new AppShell({ container: host, startRendering: false, socketFactory: factory })
    const inputs = [...host.querySelectorAll('input')]
    const filled = inputs.filter(
      (input) => input.type === 'text' || input.type === 'password' || input.type === 'email'
    )
    for (const input of filled) input.value = 'leaked-value'
    const remember = inputs.find((input) => input.type === 'checkbox')
    if (remember !== undefined) remember.checked = true
    return { shell, filled, remember, socket: latest }
  }

  function expectCleared(rig: ReturnType<typeof credentialRig>) {
    for (const input of rig.filled) expect(input.value).toBe('')
    if (rig.remember !== undefined) expect(rig.remember.checked).toBe(false)
  }

  /**
   * The registration form is reachable from the same card and holds a plaintext password, so an
   * abandoned sign-up must not survive the departing player either. Nothing else clears it: the
   * login form is wiped on this same path, but `submitRegistration` only ever writes.
   */
  it('empties the registration form too, not only the login form', () => {
    const rig = credentialRig(container)
    rig.shell.overlays.clearCredentialForms()
    expectCleared(rig)
  })

  /**
   * Drives the whole composition rather than `clearCredentialForms` directly. The controller tests
   * prove `endSessionIdentity` fires its callback and the test above proves the callback empties
   * both forms, but neither observes the wire between them — remove `onSessionIdentityEnded` from
   * `AppShell` and both still pass while a real Leave Game leaves two plaintext passwords in the DOM.
   */
  it('empties the forms through the real Leave Game wiring, not just the method', () => {
    const rig = credentialRig(container)
    rig.shell.controller.leaveGame()
    expectCleared(rig)
  })

  /**
   * The path the player does not choose. A dropped connection returns them to the login card with
   * no action on their part, so it has to empty the forms for the same reason Leave Game does —
   * otherwise a server restart is enough to leave one player's password in front of the next.
   */
  it('empties the forms when the connection drops, not only on an explicit leave', () => {
    const rig = credentialRig(container)
    rig.shell.controller.beginSession({
      kind: 'login',
      credentials: { nickname: 'Ida', password: 'hunter2-long', rememberMe: false },
    })
    rig.socket().open()
    // A peer close with nothing user-initiated behind it — a server restart is enough.
    rig.socket().deliverClose()
    expectCleared(rig)
  })
})

describe('overlay focus moves on entry, not on every repaint', () => {
  let container: HTMLElement

  beforeEach(() => {
    container = element('div')
    document.body.append(container)
  })

  afterEach(() => {
    container.remove()
  })

  /**
   * `AppShell` wires `onChatLinesChanged` to `render()`, and `render()` re-presents the current
   * overlay, so focusing on every call moves the caret to field one mid-keystroke: the rest of a
   * password being typed lands in the plaintext nickname box and Return submits it as the nickname.
   *
   * One `Overlays` across the whole case on purpose — each overlay is built once and shown or
   * hidden, so a fresh instance per assertion would prove nothing about a repaint.
   */
  it('leaves the caret alone when the login card is presented again', () => {
    const shell = new AppShell({ container, startRendering: false })
    shell.overlays.present({ kind: 'login' })

    const password = [...container.querySelectorAll('input')].find((input) => input.type === 'password')
    expect(password).toBeDefined()
    password!.focus()
    expect(document.activeElement).toBe(password)

    shell.overlays.present({ kind: 'login' })

    expect(document.activeElement).toBe(password)
  })

  it('focuses the first field on entering an overlay, including the registration card', () => {
    const shell = new AppShell({ container, startRendering: false })

    shell.overlays.present({ kind: 'login' })
    expect(document.activeElement).toBe(shell.overlays.loginNickname)

    shell.overlays.present({ kind: 'registration' })
    expect(document.activeElement).not.toBe(shell.overlays.loginNickname)
    expect((document.activeElement as HTMLInputElement | null)?.tagName).toBe('INPUT')
  })
})
