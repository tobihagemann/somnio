import { utf8ByteLength } from '@/protocol'
import type { Energy } from '@/protocol'
import { clamp } from '@/core'
import { HAND, chatLineCategory } from '@/client'
import type { ChatLine, InventoryRow } from '@/client'
import { renderChatLine, t } from '@/i18n'
import type { CatalogLocale, CatalogTables } from '@/i18n'
import { element, iconButton, replaceChildren, setHidden } from './dom'
import type { IconName } from './dom'

/**
 * The four floating panels from `MainWindowView` — HUD top-leading, chat bottom-leading, players
 * top-trailing, items bottom-trailing — as DOM overlays above the WebGL canvas rather than as
 * anything drawn in the scene. That is what makes them reachable to accessibility tooling and to
 * `agent-browser snapshot`, and it is why real `<input>` elements can carry the login form.
 */

export interface PanelCallbacks {
  onSubmitChat: (text: string) => void
  onChatFocusChange: (focused: boolean) => void
  onActivateItem: (row: InventoryRow) => void
  /** Reports whether the cursor sits over a panel, so a wheel event can scroll instead of zoom. */
  onFloatingHoverChange: (hovering: boolean) => void
}

interface HUDBar {
  root: HTMLElement
  fill: HTMLElement
  label: string
}

/**
 * `HUDBarPair.foregroundWidth`'s usable span: the 150px track less one pixel of dark at each end.
 *
 * Set in pixels rather than as a percentage — a percentage resolves against the 150px containing
 * block, which would run the full bar one pixel past the track's trailing seam.
 */
const HUD_FILL_SPAN = 148

/**
 * Takes the **localized** label, not a catalog key. Every helper here does, so each key appears in a
 * literal `t('...')` at its call site — which is what lets the catalog test scan the sources and
 * fail on a rendered string that never reached the allowlist.
 *
 * The label is never rendered. `HUDBarPair` is a bare track with the name in `.help`, so drawing it
 * beside the bar both diverges from the native HUD and, at the panel's width, clips the longest of
 * the three to "Balanc".
 */
function hudBar(label: string, color: string): HUDBar {
  const fill = element('div', { className: 'hud-bar__fill' })
  fill.style.background = color
  const track = element('div', {
    className: 'hud-bar__track',
    attributes: { title: label, 'aria-label': label, role: 'img' },
    children: [fill],
  })
  return { root: track, fill, label }
}

/**
 * Display-only equip marker. `[L]`/`[R]` are hardcoded natively too — they are layout markers, not
 * translatable text — and the player never picks a hand, so this only reflects what the server says.
 */
function equipMarker(row: InventoryRow): string {
  if (row.equippedHand === HAND.left) return '[L]'
  if (row.equippedHand === HAND.right) return '[R]'
  return ''
}

export class GamePanels {
  readonly root: HTMLElement
  readonly chatInput: HTMLTextAreaElement

  private readonly bars: HUDBar[]
  private readonly scrollback: HTMLElement
  private readonly playersList: HTMLElement
  private readonly itemsList: HTMLElement
  private readonly playersFooter: HTMLElement
  private readonly itemsFooter: HTMLElement
  private readonly chatBody: HTMLElement
  private readonly playersBody: HTMLElement
  private readonly itemsBody: HTMLElement
  private readonly callbacks: PanelCallbacks
  private readonly hovered = new Set<string>()
  private readonly tables: CatalogTables
  private readonly locale: CatalogLocale

  constructor(callbacks: PanelCallbacks, tables: CatalogTables, locale: CatalogLocale) {
    this.callbacks = callbacks
    this.tables = tables
    this.locale = locale

    this.bars = [
      hudBar(t('HP'), 'rgb(224 0 0)'),
      hudBar(t('Balance'), 'rgb(0 0 224)'),
      hudBar(t('Mana'), 'rgb(0 224 0)'),
    ]
    const hudPanel = element('div', {
      className: 'fantasy-panel hud-panel',
      children: this.bars.map((bar) => bar.root),
    })

    this.scrollback = element('div', {
      className: 'chat-scrollback',
      attributes: { role: 'log', 'aria-live': 'polite', 'aria-label': t('Chat') },
    })
    // No `maxlength`: the attribute counts UTF-16 code units, while `PROTOCOL_BYTE_CAPS.say` is a
    // UTF-8 byte cap, so for non-ASCII text it is both too permissive (256 emoji are 1024 bytes) and
    // too restrictive (256 code units are 128 emoji). `submitChat` already truncates in bytes
    // through `truncateToUTF8Bytes`, which is the bound the server actually enforces; a second,
    // differently-counted bound at the field can only disagree with it.
    this.chatInput = element('textarea', {
      className: 'fantasy-field',
      attributes: { 'aria-label': t('Chat') },
    })
    this.chatInput.addEventListener('focus', () => this.callbacks.onChatFocusChange(true))
    this.chatInput.addEventListener('blur', () => this.callbacks.onChatFocusChange(false))
    this.chatInput.addEventListener('keydown', (event) => this.handleChatKeydown(event))
    // No rule between the scrollback and the input: `chatPanel` stacks the two directly, and the
    // divider strip is reserved for panel titles.
    this.chatBody = element('div', {
      className: 'fantasy-panel chat-panel',
      children: [this.scrollback, this.chatInput],
    })

    this.playersList = element('div', {
      className: 'trailing-list trailing-list--players',
      attributes: { role: 'list', 'aria-label': t('Players') },
    })
    this.playersFooter = element('div', { className: 'list-footer' })
    this.playersBody = element('div', {
      className: 'fantasy-panel',
      children: [
        element('div', {
          className: 'trailing-column',
          children: [this.playersList, this.playersFooter],
        }),
      ],
    })

    this.itemsList = element('div', {
      className: 'trailing-list trailing-list--items',
      attributes: { role: 'list', 'aria-label': t('Items') },
    })
    this.itemsFooter = element('div', { className: 'list-footer' })
    this.itemsBody = element('div', {
      className: 'fantasy-panel',
      children: [
        element('div', { className: 'trailing-column', children: [this.itemsList, this.itemsFooter] }),
      ],
    })

    const chatColumn = this.floating('bottom-leading', 'chat', [
      this.chatBody,
      this.toggle(t('Chat'), 'chat', this.chatBody),
    ])
    const playersColumn = this.floating('top-trailing', 'players', [
      this.toggle(t('Players'), 'players', this.playersBody),
      this.playersBody,
    ])
    const itemsColumn = this.floating('bottom-trailing', 'items', [
      this.itemsBody,
      this.toggle(t('Items'), 'items', this.itemsBody),
    ])
    const hudColumn = this.floating('top-leading', 'hud', [hudPanel])

    this.root = element('div', {
      children: [hudColumn, chatColumn, playersColumn, itemsColumn],
    })
  }

  renderEnergy(energy: Energy): void {
    const pairs: [number, number][] = [
      [energy.hpCurrent, energy.hpMax],
      [energy.balanceCurrent, energy.balanceMax],
      [energy.manaCurrent, energy.manaMax],
    ]
    pairs.forEach(([current, max], index) => {
      const bar = this.bars[index]
      if (bar === undefined) return
      // `max` arrives off the wire and a zero would divide to NaN, collapsing the bar silently.
      const fraction = max > 0 ? clamp(current / max, 0, 1) : 0
      bar.fill.style.width = `${(fraction * HUD_FILL_SPAN).toFixed(2)}px`
      // The reading lives in the tooltip and the accessible name, since the bar renders no text.
      bar.root.setAttribute('title', `${bar.label} ${current}/${max}`)
      bar.root.setAttribute('aria-label', `${bar.label} ${current}/${max}`)
    })
  }

  renderChat(lines: readonly ChatLine[]): void {
    const atBottom =
      this.scrollback.scrollHeight - this.scrollback.scrollTop - this.scrollback.clientHeight < 24
    // Synthesized at render time rather than stored, matching `ChatScrollbackView.renderedLines`
    // (`[.startupGreeting] + chatLines`). Prepending here keeps it out of the retained history, so
    // it can never be trimmed away by the scrollback cap or duplicated by a re-render.
    const withGreeting: readonly ChatLine[] = [{ kind: 'startupGreeting' }, ...lines]
    replaceChildren(
      this.scrollback,
      withGreeting.map((line) =>
        element('p', {
          className: `chat-line chat-line--${chatLineCategory(line)}`,
          text: renderChatLine(line, this.tables, this.locale),
        })
      )
    )
    // Only auto-scroll when the reader was already at the bottom, so scrolling back through
    // history is not yanked away by the next arriving line.
    if (atBottom) this.scrollback.scrollTop = this.scrollback.scrollHeight
  }

  renderPlayers(players: readonly string[]): void {
    replaceChildren(
      this.playersList,
      players.map((name) =>
        element('div', { className: 'list-row', text: name, attributes: { role: 'listitem' } })
      )
    )
    this.playersFooter.textContent = t('Players: %@', String(players.length))
  }

  renderItems(rows: readonly InventoryRow[]): void {
    replaceChildren(
      this.itemsList,
      rows.map((row) => {
        const node = element('div', {
          className: 'list-row list-row--activatable',
          attributes: { role: 'listitem', tabindex: 0 },
          children: [
            element('span', { className: 'list-row__name', text: this.itemLabel(row) }),
            element('span', { className: 'list-row__marker', text: equipMarker(row) }),
          ],
        })
        // Double-click, matching the native activation gesture; Enter is the keyboard equivalent so
        // the row is reachable without a pointer.
        node.addEventListener('dblclick', () => this.callbacks.onActivateItem(row))
        node.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') this.callbacks.onActivateItem(row)
        })
        return node
      })
    )
    this.itemsFooter.textContent = t('Items: %@', String(rows.length))
  }

  clearChatInput(): void {
    this.chatInput.value = ''
  }

  /** Display name for `(category, itemId)`, mirroring `ItemCatalog`'s two-entry MVP table. */
  private itemLabel(row: InventoryRow): string {
    if (row.category === 0 && row.itemId === 0) return t('Purse')
    if (row.category === 1 && row.itemId === 0) return t('Cudgel')
    // An unmapped pair renders as the empty string natively. Showing the raw pair instead means an
    // operator seeing a blank row in a screenshot can tell which item is missing from the table.
    return `${row.category}/${row.itemId}`
  }

  /**
   * Return submits and then hands the keyboard back, mirroring `ReturnSubmittingTextView`'s
   * `onSubmit?()` followed by `makeFirstResponder(nil)`.
   *
   * The blur is unconditional, outside the empty-text guard, exactly as natively — and it is not
   * cosmetic. The gameplay gate closes on `isChatInputFocused`, so a field that keeps focus after
   * Return leaves WASD dead until the player clicks the world, with nothing on screen saying why.
   */
  private handleChatKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter') return
    // Always consumed, including with Shift held. `ReturnSubmittingTextView.keyDown` swallows
    // Shift-Return natively for a reason that applies here more strongly: canvas `fillText` drops
    // `\n` outright, and `wrapSpeech` tokenizes on spaces only, so a newline rides inside one
    // unbreakable "word" and both the measured width and the `lines.length`-derived bubble height
    // come out wrong. Returning before `preventDefault` would let the textarea insert a break the
    // renderer cannot draw and the server would happily relay.
    event.preventDefault()
    if (event.shiftKey) return
    const text = this.chatInput.value
    this.chatInput.value = ''
    if (utf8ByteLength(text.trim()) > 0) this.callbacks.onSubmitChat(text)
    this.chatInput.blur()
  }

  private toggle(label: string, name: IconName, body: HTMLElement): HTMLElement {
    return iconButton(label, name, () => setHidden(body, !body.classList.contains('hidden')), {
      className: 'fantasy-button fantasy-button--compact',
    })
  }

  /**
   * Panels never overlap, but a cursor sliding straight from one to the next can report the enter
   * before the exit — tracking the hovered set rather than one flag keeps the aggregate stable
   * through that reorder, exactly as the native `hoveredPanels` set does.
   */
  private floating(position: string, id: string, children: readonly Node[]): HTMLElement {
    const node = element('div', { className: `floating floating--${position}`, children })
    node.addEventListener('pointerenter', () => this.setHovered(id, true))
    node.addEventListener('pointerleave', () => this.setHovered(id, false))
    return node
  }

  private setHovered(id: string, hovering: boolean): void {
    const wasHovering = this.hovered.size > 0
    if (hovering) {
      this.hovered.add(id)
    } else {
      this.hovered.delete(id)
    }
    const isHovering = this.hovered.size > 0
    if (wasHovering !== isHovering) this.callbacks.onFloatingHoverChange(isHovering)
  }
}
