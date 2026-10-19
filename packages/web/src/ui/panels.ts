import { utf8ByteLength } from '@somnio/protocol';
import type { Energy, InventoryRowMessage, LucidityMessage } from '@somnio/protocol';
import { clamp, isTeachingId, practiceNeeded, roleLabelKey, teaching } from '@somnio/core';
import type { ItemId } from '@somnio/core';
import { chatLineCategory, taskIsDone } from '@/client';
import type { ChatLine } from '@/client';
import { itemName, renderChatLine, t } from '@/i18n';
import type { CatalogLocale, CatalogTables } from '@/i18n';
import { ICON_PATHS, element, floating, iconButton, isHidden, replaceChildren, setHidden, toggleHidden } from './dom';
import type { IconName } from './dom';
import { taskProgressText } from './servicePanel';

/**
 * The four floating panels from `MainWindowView` — HUD top-leading, chat bottom-leading, players
 * top-trailing, items bottom-trailing — as DOM overlays above the WebGL canvas rather than as
 * anything drawn in the scene. That is what makes them reachable to accessibility tooling and to
 * `agent-browser snapshot`, and it is why real `<input>` elements can carry the login form.
 */

export interface PanelCallbacks {
  onSubmitChat: (text: string) => void;
  onChatFocusChange: (focused: boolean) => void;
  onActivateItem: (row: InventoryRowMessage) => void;
  /** Reports whether the cursor sits over a panel, so a wheel event can scroll instead of zoom. */
  onFloatingHoverChange: (hovering: boolean) => void;
}

interface HUDBar {
  root: HTMLElement;
  fill: HTMLElement;
  label: string;
}

/**
 * An energy bar's usable span: the 150px track less one pixel of dark at each end.
 *
 * Set in pixels rather than as a percentage — a percentage resolves against the 150px containing
 * block, which would run the full bar one pixel past the track's trailing seam.
 */
const HUD_FILL_SPAN = 148;
/** The index of the balance bar among the three. */
const BALANCE_BAR = 1;

/**
 * Takes the **localized** label, not a catalog key. Every helper here does, so each key appears in a
 * literal `t('...')` at its call site — which is what lets the catalog test scan the sources and
 * fail on a rendered string that never reached the allowlist.
 *
 * The label is never rendered: the bar is a bare track with the name as its tooltip, and at the
 * panel's width a rendered label would clip the longest of the three to "Balanc".
 */
function hudBar(label: string, color: string): HUDBar {
  const fill = element('div', { className: 'hud-bar__fill' });
  fill.style.background = color;
  const track = element('div', {
    className: 'hud-bar__track',
    attributes: { title: label, 'aria-label': label, role: 'img' },
    children: [fill],
  });
  return { root: track, fill, label };
}

/**
 * The trailing cell of an item row: the purse's coin count, else the equip marker. `[L]`/`[R]` are
 * layout markers, not translatable text, and the player never picks a hand, so this only reflects
 * what the server says.
 */
function rowMarker(row: InventoryRowMessage): string {
  if (row.itemId === ('purse' satisfies ItemId)) return String(row.quantity);
  if (row.equippedHand === 'left') return '[L]';
  if (row.equippedHand === 'right') return '[R]';
  return '';
}

export class GamePanels {
  readonly root: HTMLElement;
  readonly chatInput: HTMLTextAreaElement;
  /** What covers the play field: each panel body and toggle, measuring nothing while it is hidden. */
  readonly occluders: readonly HTMLElement[];

  private readonly bars: HUDBar[];
  private readonly lucidity: HTMLElement;
  private readonly scrollback: HTMLElement;
  private readonly playersList: HTMLElement;
  private readonly itemsList: HTMLElement;
  private readonly playersFooter: HTMLElement;
  private readonly itemsFooter: HTMLElement;
  private shownItems: readonly InventoryRowMessage[] | undefined;
  private shownChat: { count: number; newest: ChatLine | undefined } | undefined;
  private chatAtNewestWhenHidden = true;
  private chatAtNewestWhenPanelsHidden = true;
  private readonly chatBody: HTMLElement;
  private readonly playersBody: HTMLElement;
  private readonly itemsBody: HTMLElement;
  private readonly callbacks: PanelCallbacks;
  private readonly hovered = new Set<string>();
  private readonly tables: CatalogTables;
  private readonly locale: CatalogLocale;

  constructor(callbacks: PanelCallbacks, tables: CatalogTables, locale: CatalogLocale) {
    this.callbacks = callbacks;
    this.tables = tables;
    this.locale = locale;

    this.bars = [hudBar(t('Health'), 'rgb(224 0 0)'), hudBar(t('Balance'), 'rgb(0 0 224)'), hudBar(t('Spirit'), 'rgb(0 224 0)')];
    this.lucidity = element('div', { className: 'hud-lucidity' });
    const hudPanel = element('div', {
      className: 'fantasy-panel hud-panel',
      children: [...this.bars.map((bar) => bar.root), this.lucidity],
    });

    this.scrollback = element('div', {
      className: 'chat-scrollback',
      attributes: { role: 'log', 'aria-live': 'polite', 'aria-label': t('Chat') },
    });
    // No `maxlength`: the attribute counts UTF-16 code units, while `PROTOCOL_BYTE_CAPS.say` is a
    // UTF-8 byte cap, so for non-ASCII text it is both too permissive (256 emoji are 1024 bytes) and
    // too restrictive (256 code units are 128 emoji). `submitChat` already truncates in bytes
    // through `truncateToUTF8Bytes`, which is the bound the server actually enforces; a second,
    // differently-counted bound at the field can only disagree with it.
    this.chatInput = element('textarea', {
      className: 'fantasy-field',
      attributes: { 'aria-label': t('Chat'), placeholder: t('Talk here. /w to whisper, /y to yell') },
    });
    this.chatInput.addEventListener('focus', () => this.callbacks.onChatFocusChange(true));
    this.chatInput.addEventListener('blur', () => this.callbacks.onChatFocusChange(false));
    this.chatInput.addEventListener('keydown', (event) => this.handleChatKeydown(event));
    // No rule between the scrollback and the input: `chatPanel` stacks the two directly, and the
    // divider strip is reserved for panel titles.
    this.chatBody = element('div', {
      className: 'fantasy-panel chat-panel',
      children: [this.scrollback, this.chatInput],
    });

    this.playersList = element('div', {
      className: 'trailing-list trailing-list--players',
      attributes: { role: 'list', 'aria-label': t('Players') },
    });
    this.playersFooter = element('div', { className: 'list-footer' });
    this.playersBody = element('div', {
      className: 'fantasy-panel',
      children: [
        element('div', {
          className: 'trailing-column',
          children: [this.playersList, this.playersFooter],
        }),
      ],
    });

    this.itemsList = element('div', {
      className: 'trailing-list trailing-list--items',
      attributes: { role: 'list', 'aria-label': t('Items') },
    });
    this.itemsFooter = element('div', { className: 'list-footer' });
    this.itemsBody = element('div', {
      className: 'fantasy-panel',
      children: [element('div', { className: 'trailing-column', children: [this.itemsList, this.itemsFooter] })],
    });

    const chatToggle = this.toggle(t('Chat'), 'chat', () => this.toggleChat());
    const playersToggle = this.toggle(t('Players'), 'players', () => toggleHidden(this.playersBody));
    const itemsToggle = this.toggle(t('Items'), 'items', () => toggleHidden(this.itemsBody));
    const chatColumn = this.floating('bottom-leading', 'chat', [this.chatBody, chatToggle]);
    const playersColumn = this.floating('top-trailing', 'players', [playersToggle, this.playersBody]);
    const itemsColumn = this.floating('bottom-trailing', 'items', [this.itemsBody, itemsToggle]);
    const hudColumn = this.floating('top-leading', 'hud', [hudPanel]);
    this.occluders = [hudPanel, this.chatBody, this.playersBody, this.itemsBody, chatToggle, playersToggle, itemsToggle];

    this.root = element('div', {
      children: [hudColumn, chatColumn, playersColumn, itemsColumn],
    });
  }

  /** A winded player's balance bar is marked, and says so, until the balance is back to where the slow gait ends. */
  renderEnergy(energy: Energy, winded: boolean): void {
    const pairs: [number, number][] = [
      [energy.healthCurrent, energy.healthMax],
      [energy.balanceCurrent, energy.balanceMax],
      [energy.spiritCurrent, energy.spiritMax],
    ];
    pairs.forEach(([current, max], index) => {
      const bar = this.bars[index];
      if (bar === undefined) return;
      // `max` arrives off the wire and a zero would divide to NaN, collapsing the bar silently.
      const fraction = max > 0 ? clamp(current / max, 0, 1) : 0;
      bar.fill.style.width = `${(fraction * HUD_FILL_SPAN).toFixed(2)}px`;
      // The reading lives in the tooltip and the accessible name, since the bar renders no text.
      const isWinded = winded && index === BALANCE_BAR;
      const reading = `${bar.label} ${current}/${max}${isWinded ? `, ${t('winded')}` : ''}`;
      bar.root.setAttribute('title', reading);
      bar.root.setAttribute('aria-label', reading);
      bar.root.classList.toggle('hud-bar__track--winded', isWinded);
    });
  }

  /** The role, the teaching studied with its practice, and the task held, under the bars. */
  renderLucidity(lucidity: LucidityMessage): void {
    const lines = [lucidity.role === undefined ? t('No role yet') : t(roleLabelKey(lucidity.role))];
    if (lucidity.study !== undefined && isTeachingId(lucidity.study)) {
      const held = lucidity.ranks.find((rank) => rank.teachingId === lucidity.study);
      const practice = String(Math.floor(held?.practice ?? 0));
      lines.push(t('Studying %1$@: %2$@ of %3$@', t(teaching(lucidity.study).labelKey), practice, String(practiceNeeded(held?.rank ?? 0))));
    } else if (lucidity.role !== undefined) {
      lines.push(t('Studying nothing'));
    }
    const task = lucidity.task;
    const progress = task === undefined ? undefined : taskProgressText(task);
    if (task !== undefined && progress !== undefined) lines.push(taskIsDone(task) ? t('Your task is done. Return to your master.') : t('Task: %@', progress));
    replaceChildren(
      this.lucidity,
      lines.map((line) => element('p', { className: 'hud-lucidity__line', text: line })),
    );
  }

  renderChat(lines: readonly ChatLine[]): void {
    // The shell renders on every `energy` frame, and replacing the lines takes a reader's text
    // selection with them. The history is appended to in place and trimmed at its cap, so its
    // newest line and its length say whether it changed.
    const newest = lines.at(-1);
    if (this.shownChat?.count === lines.length && this.shownChat.newest === newest) return;
    this.shownChat = { count: lines.length, newest };
    const atNewest = this.scrollbackAtNewest();
    // Synthesized at render time rather than stored, matching `ChatScrollbackView.renderedLines`
    // (`[.startupGreeting] + chatLines`). Prepending here keeps it out of the retained history, so
    // it can never be trimmed away by the scrollback cap or duplicated by a re-render.
    const withGreeting: readonly ChatLine[] = [{ kind: 'startupGreeting' }, ...lines];
    replaceChildren(
      this.scrollback,
      withGreeting.map((line) =>
        element('p', {
          className: `chat-line chat-line--${chatLineCategory(line)}`,
          text: renderChatLine(line, this.tables, this.locale),
        }),
      ),
    );
    // Only auto-scroll when the reader was already at the bottom, so scrolling back through
    // history is not yanked away by the next arriving line.
    if (atNewest) this.scrollToNewest();
  }

  renderPlayers(players: readonly string[]): void {
    replaceChildren(
      this.playersList,
      players.map((name) => element('div', { className: 'list-row', text: name, attributes: { role: 'listitem' } })),
    );
    this.playersFooter.textContent = t('Players: %@', String(players.length));
  }

  renderItems(rows: readonly InventoryRowMessage[]): void {
    // A row replaced between the two clicks of a double click, or while it holds the keyboard
    // focus, is never activated, and the shell renders on every `energy` frame.
    if (rows === this.shownItems) return;
    this.shownItems = rows;
    replaceChildren(
      this.itemsList,
      rows.map((row) => {
        const node = element('div', {
          className: 'list-row list-row--activatable',
          attributes: { role: 'listitem', tabindex: 0 },
          children: [
            element('span', { className: 'list-row__name', text: itemName(row.itemId, t) }),
            element('span', { className: 'list-row__marker', text: rowMarker(row) }),
          ],
        });
        // Double-click activates a row; Enter is the keyboard equivalent so the row is reachable
        // without a pointer.
        node.addEventListener('dblclick', () => this.callbacks.onActivateItem(row));
        node.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') this.callbacks.onActivateItem(row);
        });
        return node;
      }),
    );
    this.itemsFooter.textContent = t('Items: %@', String(rows.length));
  }

  /**
   * Hidden whole, the scrollback measures nothing, as a collapsed one does. So whether it sat at the
   * newest line is taken as the panels hide, the way `toggleChat` takes it.
   */
  setShown(shown: boolean): void {
    if (shown !== isHidden(this.root)) return;
    if (!shown) this.chatAtNewestWhenPanelsHidden = this.scrollbackAtNewest();
    setHidden(this.root, !shown);
    if (shown && this.chatAtNewestWhenPanelsHidden) this.scrollToNewest();
  }

  clearChatInput(): void {
    this.chatInput.value = '';
  }

  /**
   * Return submits and then hands the keyboard back to the world.
   *
   * The blur is unconditional, outside the empty-text guard, and it is not cosmetic. The gameplay
   * gate closes on `isChatInputFocused`, so a field that keeps focus after Return leaves WASD dead
   * until the player clicks the world, with nothing on screen saying why.
   */
  private handleChatKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter') return;
    // Always consumed, including with Shift held: canvas `fillText` drops `\n` outright, and
    // `wrapSpeech` tokenizes on spaces only, so a newline rides inside a "word" and
    // both the measured width and the `lines.length`-derived bubble height come out wrong.
    // Returning before `preventDefault` would let the textarea insert a break the renderer cannot
    // draw and the server would happily relay.
    event.preventDefault();
    if (event.shiftKey) return;
    const text = this.chatInput.value;
    this.chatInput.value = '';
    if (utf8ByteLength(text.trim()) > 0) this.callbacks.onSubmitChat(text);
    this.chatInput.blur();
  }

  private toggle(label: string, name: IconName, onClick: () => void): HTMLElement {
    return iconButton(label, ICON_PATHS[name], onClick, {
      className: 'fantasy-button fantasy-button--compact',
    });
  }

  /**
   * A collapsed scrollback measures nothing and takes no scroll. Lines that arrive while it is
   * collapsed therefore leave it at its old offset when it reopens, short of the newest line, and
   * it would stop following the lines after them too. So whether the reader was at the newest line
   * is taken as it collapses, not as a line arrives.
   */
  private toggleChat(): void {
    if (isHidden(this.chatBody)) {
      setHidden(this.chatBody, false);
      if (this.chatAtNewestWhenHidden) this.scrollToNewest();
    } else {
      this.chatAtNewestWhenHidden = this.scrollbackAtNewest();
      setHidden(this.chatBody, true);
    }
  }

  /** Within a line (24px) of the newest. */
  private scrollbackAtNewest(): boolean {
    return this.scrollback.scrollHeight - this.scrollback.scrollTop - this.scrollback.clientHeight < 24;
  }

  private scrollToNewest(): void {
    this.scrollback.scrollTop = this.scrollback.scrollHeight;
  }

  /**
   * Panels never overlap, but a cursor sliding straight from one to the next can report the enter
   * before the exit — tracking the hovered set rather than one flag keeps the aggregate stable
   * through that reorder.
   */
  private floating(position: string, id: string, children: readonly Node[]): HTMLElement {
    const node = floating(position, children);
    node.addEventListener('pointerenter', () => this.setHovered(id, true));
    node.addEventListener('pointerleave', () => this.setHovered(id, false));
    return node;
  }

  private setHovered(id: string, hovering: boolean): void {
    const wasHovering = this.hovered.size > 0;
    if (hovering) {
      this.hovered.add(id);
    } else {
      this.hovered.delete(id);
    }
    const isHovering = this.hovered.size > 0;
    if (wasHovering !== isHovering) this.callbacks.onFloatingHoverChange(isHovering);
  }
}
