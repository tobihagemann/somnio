import { utf8ByteLength } from '@somnio/protocol';
import { chatLineCategory } from '@/client';
import type { ChatLine } from '@/client';
import { renderChatLine, t } from '@/i18n';
import type { CatalogLocale, CatalogTables } from '@/i18n';
import { element, iconButton, setHidden } from './dom';
import { HUD_ICONS, glyph } from './hudIcons';
import { setTip } from './hudTooltip';
import { windowHead } from './hudWindows';

/**
 * The chat, as Clan Lord's text pane. On a mouse its newest lines lie over the world's bottom left
 * corner with no panel round them, fading once nothing has been said for a while and coming back
 * while the pointer rests on them. Enter opens it: a panel with the whole history and the field.
 * On a finger the newest lines peek above a chat icon, which opens the same panel.
 */

/** How long the closed pane's lines stay after the last line arrived, or the pointer left them. */
export const CHAT_IDLE_MS = 8000;
/** How many of the newest lines peek above a finger's chat icon. */
const PEEK_LINES = 3;

export interface ChatPaneCallbacks {
  onSubmit: (text: string) => void;
  onFocusChange: (focused: boolean) => void;
}

export class ChatPane {
  /** What the HUD places: a mouse's pane, or a finger's peek, icon, and panel together. */
  readonly root: HTMLElement;
  readonly input: HTMLTextAreaElement;
  private readonly scrollback: HTMLElement;
  /** The panel round the history and the field while open: the pane itself on a mouse. */
  private readonly panel: HTMLElement;
  /** A finger's newest lines and the icon that opens the chat. */
  private readonly peek: HTMLElement | undefined;
  private readonly toggle: HTMLButtonElement | undefined;
  private readonly callbacks: ChatPaneCallbacks;
  private readonly tables: CatalogTables;
  private readonly locale: CatalogLocale;
  private readonly now: () => number;
  private open = false;
  private hovered = false;
  private idle = false;
  private activeAtMs = 0;
  private shownLines: { count: number; newest: ChatLine | undefined } | undefined;

  constructor(callbacks: ChatPaneCallbacks, tables: CatalogTables, locale: CatalogLocale, coarse: boolean, now: () => number) {
    this.callbacks = callbacks;
    this.tables = tables;
    this.locale = locale;
    this.now = now;
    this.scrollback = element('div', {
      className: 'chat-scrollback',
      attributes: { role: 'log', 'aria-live': 'polite', 'aria-label': t('Chat') },
    });
    // No `maxlength`: the attribute counts UTF-16 code units, while `PROTOCOL_BYTE_CAPS.say` is a
    // UTF-8 byte cap, so for non-ASCII text it is both too permissive and too restrictive.
    // `submitChat` truncates in bytes through `truncateToUTF8Bytes`, the bound the server enforces.
    this.input = element('textarea', {
      className: 'fantasy-field hud-chat__field',
      attributes: { 'aria-label': t('Chat'), placeholder: t('Talk here. /w to whisper, /y to yell'), rows: 1 },
    });
    this.input.addEventListener('focus', () => this.callbacks.onFocusChange(true));
    this.input.addEventListener('blur', () => this.callbacks.onFocusChange(false));
    this.input.addEventListener('keydown', (event) => this.handleKeydown(event));

    if (coarse) {
      this.peek = element('div', { className: 'hud-chat-peek', attributes: { 'aria-hidden': 'true' } });
      this.toggle = setTip(
        iconButton(t('Chat'), glyph(HUD_ICONS.chat), () => this.openChat(), {
          className: 'fantasy-button fantasy-button--compact hud-chat-toggle',
        }),
      );
      this.toggle.setAttribute('aria-expanded', 'false');
      this.panel = element('section', {
        className: 'fantasy-panel fantasy-panel--opaque hud-chat hud-chat--open hidden',
        attributes: { 'aria-label': t('Chat') },
        children: [windowHead(t('Chat'), () => this.closeChat()), this.scrollback, this.input],
      });
      this.root = element('div', { className: 'hud-chat-corner', children: [this.peek, this.toggle, this.panel] });
    } else {
      this.panel = element('div', { className: 'hud-chat', children: [this.scrollback, this.input] });
      setHidden(this.input, true);
      // A press on the closed pane's lines opens it, for a player with no keyboard at hand.
      this.scrollback.addEventListener('click', () => {
        if (!this.open) this.openChat();
      });
      this.panel.addEventListener('pointerenter', () => {
        this.hovered = true;
        this.showIdle(false);
      });
      this.panel.addEventListener('pointerleave', () => {
        this.hovered = false;
        this.activeAtMs = this.now();
      });
      this.root = this.panel;
    }
  }

  get isOpen(): boolean {
    return this.open;
  }

  /** What covers the play field: on a finger, the chat icon and the open panel. On a mouse, the pane unless its lines have faded. */
  get occluders(): HTMLElement[] {
    if (this.toggle !== undefined) return [this.toggle, this.panel];
    return this.idle ? [] : [this.panel];
  }

  renderLines(lines: readonly ChatLine[]): void {
    // The shell renders on every `energy` frame, and replacing the lines takes a reader's text
    // selection with them. The history is appended to in place and trimmed at its cap, so its
    // newest line and its length say whether it changed.
    const newest = lines.at(-1);
    if (this.shownLines?.count === lines.length && this.shownLines.newest === newest) return;
    this.shownLines = { count: lines.length, newest };
    const atNewest = !this.open || this.scrollbackAtNewest();
    // The greeting is synthesized here rather than stored, so the scrollback cap never trims it away.
    const withGreeting: readonly ChatLine[] = [{ kind: 'startupGreeting' }, ...lines];
    this.scrollback.replaceChildren(...withGreeting.map((line) => this.lineElement(line)));
    this.peek?.replaceChildren(...withGreeting.slice(-PEEK_LINES).map((line) => this.lineElement(line)));
    // Scrolled on to the newest line only when the reader was there already, so reading back is not yanked away.
    if (atNewest) this.scrollToNewest();
    this.activeAtMs = this.now();
    this.showIdle(false);
  }

  /** Opens the chat and gives the field the keyboard. */
  openChat(): void {
    if (!this.open) {
      this.open = true;
      this.showOpen();
      this.scrollToNewest();
    }
    this.input.focus({ preventScroll: true });
  }

  /**
   * Closes the chat and hands the keyboard back to the world, which also puts a phone's on-screen
   * keyboard away. A draft stays in the field for when it opens again.
   */
  closeChat(): void {
    this.input.blur();
    if (!this.open) return;
    this.open = false;
    this.showOpen();
    this.scrollToNewest();
    this.activeAtMs = this.now();
  }

  /** Fades the closed pane's lines once nothing has happened in them for a while. */
  tick(nowMs: number): void {
    this.showIdle(!this.open && !this.hovered && nowMs - this.activeAtMs > CHAT_IDLE_MS);
  }

  /** Brings back the faded lines of a mouse's pane when the pointer comes to rest over where they lie. */
  revealAt(x: number, y: number): void {
    if (!this.idle || this.peek !== undefined) return;
    const rect = this.scrollback.getBoundingClientRect();
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return;
    this.activeAtMs = this.now();
    this.showIdle(false);
  }

  /** As the HUD appears, its lines are as fresh as the arrival; as it goes, the chat closes. */
  setShown(shown: boolean): void {
    if (shown) {
      this.activeAtMs = this.now();
      this.showIdle(false);
      this.scrollToNewest();
    } else {
      this.closeChat();
    }
  }

  private showOpen(): void {
    if (this.toggle !== undefined) {
      setHidden(this.panel, !this.open);
      setHidden(this.toggle, this.open);
      if (this.peek !== undefined) setHidden(this.peek, this.open);
      this.toggle.setAttribute('aria-expanded', String(this.open));
      return;
    }
    this.panel.classList.toggle('hud-chat--open', this.open);
    this.panel.classList.toggle('fantasy-panel', this.open);
    this.panel.classList.toggle('fantasy-panel--opaque', this.open);
    setHidden(this.input, !this.open);
    if (this.open) this.showIdle(false);
  }

  private showIdle(idle: boolean): void {
    if (idle === this.idle) return;
    this.idle = idle;
    (this.peek ?? this.panel).classList.toggle('hud-chat--idle', idle);
  }

  private lineElement(line: ChatLine): HTMLElement {
    return element('p', { className: `chat-line chat-line--${chatLineCategory(line)}`, text: renderChatLine(line, this.tables, this.locale) });
  }

  /**
   * Enter sends the line, if it has any text, then closes the chat and hands the keyboard back to
   * the world.
   *
   * The close does not depend on the text: Shift toggles Run only while the field lacks the
   * keyboard, so a field that kept it would leave Shift toggling nothing.
   */
  private handleKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter') return;
    // Always consumed, including with Shift held: canvas `fillText` drops `\n`, and `wrapSpeech`
    // tokenizes on spaces only, so a newline the field took would ride inside a word, be measured
    // wrong in the bubble, and be relayed by the server all the same.
    event.preventDefault();
    if (event.shiftKey) return;
    const text = this.input.value;
    this.input.value = '';
    if (utf8ByteLength(text.trim()) > 0) this.callbacks.onSubmit(text);
    this.closeChat();
  }

  /** Within a line (24px) of the newest. */
  private scrollbackAtNewest(): boolean {
    return this.scrollback.scrollHeight - this.scrollback.scrollTop - this.scrollback.clientHeight < 24;
  }

  private scrollToNewest(): void {
    this.scrollback.scrollTop = this.scrollback.scrollHeight;
  }
}
