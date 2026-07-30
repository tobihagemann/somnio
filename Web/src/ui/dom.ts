/**
 * DOM construction helpers.
 *
 * Every text-bearing helper here sets `textContent`, never `innerHTML`. Chat messages, player
 * names, and NPC dialog are all attacker-influenced — a peer picks their own name and types their
 * own chat — and this client stores a session token, so an injected script would be able to read
 * it out of `localStorage`. Keeping the escape-hatch out of the helpers means no call site has to
 * remember the rule.
 */

type Attributes = Record<string, string | number | boolean | undefined>

export function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: {
    className?: string
    text?: string
    attributes?: Attributes
    children?: readonly Node[]
  } = {}
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (options.className !== undefined) node.className = options.className
  if (options.text !== undefined) node.textContent = options.text
  for (const [name, value] of Object.entries(options.attributes ?? {})) {
    if (value === undefined || value === false) continue
    node.setAttribute(name, value === true ? '' : String(value))
  }
  for (const child of options.children ?? []) node.append(child)
  return node
}

export function button(
  label: string,
  onClick: () => void,
  options: { className?: string } = {}
): HTMLButtonElement {
  const node = element('button', {
    className: options.className ?? 'fantasy-button',
    text: label,
    attributes: { type: 'button' },
  })
  node.addEventListener('click', onClick)
  return node
}

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg'

let controlSequence = 0

/**
 * A DOM id for a labelled control.
 *
 * The label text alone is not unique enough: slugifying drops punctuation, so "Password:" and
 * "Password (*):" collapse to the same slug — both `<label for>`s then point at the first input,
 * and the second field is left with no accessible name at all. A counter keeps the slug readable
 * while guaranteeing the pairing is one-to-one.
 */
function controlIdentifier(kind: string, labelText: string): string {
  controlSequence += 1
  const slug = labelText
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
  return `somnio-${kind}-${slug}-${controlSequence}`
}

/**
 * Line-art stand-ins for the SF Symbols the native panel toggles use. They are drawn here rather
 * than loaded from the asset pack because the pack carries no glyphs, and a web font would be a
 * second network dependency for three shapes.
 *
 * Stroked in `currentColor` at a 24-unit grid, so they inherit the button's ink and scale with it
 * the way `Image(systemName:)` scales with the label font.
 */
export const ICON_PATHS = {
  /** `bubble.left` — rounded balloon with the tail on the lower left. */
  chat: 'M3.5 5.5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-9l-5 4v-4a2 2 0 0 1-1-2z',
  /** `person.2` — one figure in front, a second shouldered in behind it. */
  players:
    'M15 20.5v-1.5a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1.5M12.5 7.5a2.75 2.75 0 1 1-5.5 0 2.75 2.75 0 0 1 5.5 0M16.5 15.2a4 4 0 0 1 4.5 3.8v1.5M15.2 4.6a2.75 2.75 0 0 1 0 5.8',
  /** `bag` — body plus the handle arc. */
  items: 'M4.5 8h15l-1.1 11.6a1.6 1.6 0 0 1-1.6 1.4H7.2a1.6 1.6 0 0 1-1.6-1.4zM8.5 8V6.6a3.5 3.5 0 0 1 7 0V8',
} as const

export type IconName = keyof typeof ICON_PATHS

/** Decorative by construction: the accessible name lives on the button, not on the glyph. */
export function icon(name: IconName): SVGSVGElement {
  const svg = document.createElementNS(SVG_NAMESPACE, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.8')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  svg.classList.add('fantasy-icon')
  const path = document.createElementNS(SVG_NAMESPACE, 'path')
  path.setAttribute('d', ICON_PATHS[name])
  svg.append(path)
  return svg
}

/**
 * Icon-only button. The label never renders — it becomes the accessible name and the tooltip,
 * mirroring `panelToggle`'s `Image(systemName:)` plus `.help(tooltip)`. Keeping it on `aria-label`
 * is also what leaves the control findable by name in an accessibility snapshot.
 */
export function iconButton(
  label: string,
  name: IconName,
  onClick: () => void,
  options: { className?: string } = {}
): HTMLButtonElement {
  const node = element('button', {
    className: options.className ?? 'fantasy-button',
    attributes: { type: 'button', title: label, 'aria-label': label },
    children: [icon(name)],
  })
  node.addEventListener('click', onClick)
  return node
}

export interface FieldOptions {
  type?: string
  /** UTF-8 byte cap. Enforced in `maxlength` terms only as a coarse first pass — see below. */
  maxUTF8Bytes?: number
  autocomplete?: string
  value?: string
}

/**
 * A labelled input row.
 *
 * `maxlength` counts UTF-16 code units, so it cannot express a UTF-8 byte cap: 200 emoji satisfy
 * `maxlength="256"` and are then refused by the server. It is set anyway as a cheap upper bound,
 * and the real byte check happens in the form's own pre-validation before submit.
 */
export function field(
  labelText: string,
  options: FieldOptions = {}
): { row: HTMLElement; input: HTMLInputElement } {
  const input = element('input', {
    className: 'fantasy-field',
    attributes: {
      type: options.type ?? 'text',
      autocomplete: options.autocomplete,
      maxlength: options.maxUTF8Bytes,
      value: options.value,
    },
  })
  const label = element('label', { text: labelText })
  const identifier = controlIdentifier('field', labelText)
  input.id = identifier
  label.setAttribute('for', identifier)
  return { row: element('div', { className: 'form-row', children: [label, input] }), input }
}

export function checkbox(labelText: string, checked: boolean): { row: HTMLElement; input: HTMLInputElement } {
  const input = element('input', { attributes: { type: 'checkbox', checked } })
  const label = element('label', { text: labelText })
  const identifier = controlIdentifier('check', labelText)
  input.id = identifier
  label.setAttribute('for', identifier)
  return {
    row: element('div', { className: 'form-row form-row--checkbox', children: [input, label] }),
    input,
  }
}

export function select(
  labelText: string,
  options: readonly { value: string; label: string }[]
): { row: HTMLElement; input: HTMLSelectElement } {
  const input = element('select', { className: 'fantasy-field' })
  for (const option of options) {
    input.append(element('option', { text: option.label, attributes: { value: option.value } }))
  }
  const label = element('label', { text: labelText })
  const identifier = controlIdentifier('select', labelText)
  input.id = identifier
  label.setAttribute('for', identifier)
  return { row: element('div', { className: 'form-row', children: [label, input] }), input }
}

export function setHidden(node: HTMLElement, hidden: boolean): void {
  node.classList.toggle('hidden', hidden)
}

export function replaceChildren(node: HTMLElement, children: readonly Node[]): void {
  node.replaceChildren(...children)
}
