/**
 * DOM construction helpers.
 *
 * Every text-bearing helper here sets `textContent`, never `innerHTML`. Chat messages, player
 * names, and NPC dialog are all attacker-influenced — a peer picks their own name and types their
 * own chat — and this client stores a session token, so an injected script would be able to read
 * it out of `localStorage`. Keeping the escape-hatch out of the helpers means no call site has to
 * remember the rule.
 */

type Attributes = Record<string, string | number | boolean | undefined>;

export function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: {
    className?: string;
    text?: string;
    attributes?: Attributes;
    children?: readonly Node[];
  } = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options.className !== undefined) node.className = options.className;
  if (options.text !== undefined) node.textContent = options.text;
  for (const [name, value] of Object.entries(options.attributes ?? {})) {
    if (value === undefined || value === false) continue;
    node.setAttribute(name, value === true ? '' : String(value));
  }
  for (const child of options.children ?? []) node.append(child);
  return node;
}

export function button(label: string, onClick: () => void, options: { className?: string } = {}): HTMLButtonElement {
  const node = element('button', {
    className: options.className ?? 'fantasy-button',
    text: label,
    attributes: { type: 'button' },
  });
  node.addEventListener('click', onClick);
  return node;
}

export const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

let controlSequence = 0;

/**
 * A DOM id for a labelled control.
 *
 * The label text alone is not unique enough: slugifying drops punctuation, so "Email" on the login
 * card and "Email:" on Sign Up collapse to the same slug — both `<label for>`s then point at the
 * first input, and the second field is left with no accessible name at all. A counter keeps the
 * slug readable while guaranteeing the pairing is one-to-one.
 */
function controlIdentifier(kind: string, labelText: string): string {
  controlSequence += 1;
  const slug = labelText
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
  return `somnio-${kind}-${slug}-${controlSequence}`;
}

/** A 24-unit path from the editor's table, rendered as a stroked glyph. */
export type IconPath = string;

/** Decorative by construction: the accessible name lives on the button, not on the glyph. */
function icon(path: IconPath): SVGSVGElement {
  const svg = document.createElementNS(SVG_NAMESPACE, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.classList.add('fantasy-icon');
  const node = document.createElementNS(SVG_NAMESPACE, 'path');
  node.setAttribute('d', path);
  svg.append(node);
  return svg;
}

/**
 * Icon-only button, showing a path from the editor's table or a glyph the HUD made. The label
 * never renders — it becomes the accessible name and the tooltip.
 * Keeping it on `aria-label` is also what leaves the control findable by name in an
 * accessibility snapshot.
 */
export function iconButton(label: string, art: IconPath | Element, onClick: () => void, options: { className?: string } = {}): HTMLButtonElement {
  const node = element('button', {
    className: options.className ?? 'fantasy-button',
    attributes: { type: 'button', title: label, 'aria-label': label },
    children: [typeof art === 'string' ? icon(art) : art],
  });
  node.addEventListener('click', onClick);
  return node;
}

export interface FieldOptions {
  type?: string;
  /** UTF-8 byte cap. Enforced in `maxlength` terms only as a coarse first pass — see below. */
  maxUTF8Bytes?: number;
  autocomplete?: string;
  value?: string;
  min?: number;
  max?: number;
  step?: number;
}

/**
 * A labelled input row.
 *
 * `maxlength` counts UTF-16 code units, so it cannot express a UTF-8 byte cap: 200 emoji satisfy
 * `maxlength="256"` and are then refused by the server. It is set anyway as a cheap upper bound,
 * and the real byte check happens in the form's own pre-validation before submit.
 */
export function field(labelText: string, options: FieldOptions = {}): { row: HTMLElement; input: HTMLInputElement } {
  const input = element('input', {
    className: 'fantasy-field',
    attributes: {
      type: options.type ?? 'text',
      autocomplete: options.autocomplete,
      maxlength: options.maxUTF8Bytes,
      value: options.value,
      min: options.min,
      max: options.max,
      step: options.step,
    },
  });
  const label = element('label', { text: labelText });
  const identifier = controlIdentifier('field', labelText);
  input.id = identifier;
  label.setAttribute('for', identifier);
  return { row: element('div', { className: 'form-row', children: [label, input] }), input };
}

export function checkbox(labelText: string, checked: boolean): { row: HTMLElement; input: HTMLInputElement } {
  const input = element('input', { attributes: { type: 'checkbox', checked } });
  const label = element('label', { text: labelText });
  const identifier = controlIdentifier('check', labelText);
  input.id = identifier;
  label.setAttribute('for', identifier);
  return {
    row: element('div', { className: 'form-row form-row--checkbox', children: [input, label] }),
    input,
  };
}

export function select(labelText: string, options: readonly { value: string; label: string }[]): { row: HTMLElement; input: HTMLSelectElement } {
  const input = element('select', { className: 'fantasy-field' });
  for (const option of options) {
    input.append(element('option', { text: option.label, attributes: { value: option.value } }));
  }
  const label = element('label', { text: labelText });
  const identifier = controlIdentifier('select', labelText);
  input.id = identifier;
  label.setAttribute('for', identifier);
  return { row: element('div', { className: 'form-row', children: [label, input] }), input };
}

/**
 * Overlay dialog card. Takes the localized title; `width` picks the panel's frame (the game
 * menu is a narrow column). `heading` covers panels that author their own
 * oversized title in the body — the title still reaches `aria-label`, so the dialog keeps an
 * accessible name either way.
 */
export function card(title: string, body: readonly Node[], width: 'default' | 'menu' = 'default', heading: 'shown' | 'accessibleOnly' = 'shown'): HTMLElement {
  const modifier = width === 'default' ? '' : ` overlay-card--${width}`;
  const titleNodes = heading === 'shown' ? [element('h1', { className: 'overlay-title', text: title })] : [];
  return element('div', {
    className: `fantasy-panel fantasy-panel--opaque overlay-card${modifier}`,
    attributes: { role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    children: [...titleNodes, ...body],
  });
}

export function scrim(cardNode: HTMLElement): HTMLElement {
  return element('div', { className: 'overlay-scrim hidden', children: [cardNode] });
}

/** Floating corner column, for the editor's corner panels. */
export function floating(children: readonly Node[]): HTMLElement {
  return element('div', { className: 'floating', children });
}

/** One side's floating columns, the first in the top corner and the last in the bottom one. */
export function floatingStack(side: 'leading' | 'trailing', columns: readonly HTMLElement[]): HTMLElement {
  return element('div', { className: `floating-stack floating-stack--${side}`, children: columns });
}

export function setHidden(node: HTMLElement, hidden: boolean): void {
  node.classList.toggle('hidden', hidden);
}

export function isHidden(node: HTMLElement): boolean {
  return node.classList.contains('hidden');
}

export function replaceChildren(node: HTMLElement, children: readonly Node[]): void {
  node.replaceChildren(...children);
}

/** Whether the player asked their system for reduced motion. */
export function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}
