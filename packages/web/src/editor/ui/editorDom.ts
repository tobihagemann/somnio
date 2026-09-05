import { element, field } from '@/ui/dom'
import type { IconPath } from '@/ui/dom'
import type { EditorTool } from '../canvasController'

/**
 * The editor's own DOM helpers, kept out of `@/ui/dom` so the shipped client bundle carries none
 * of them: an object literal there is not tree-shaken, so the tool glyphs would ship to players.
 */

/** One glyph per editor tool, stroked on the same 24-unit grid as `ICON_PATHS`. */
export const EDITOR_ICON_PATHS = {
  select: 'M6.5 3.5v14l4-3.6 2.6 6 2.7-1.2-2.6-5.8h5.3z',
  object: 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12v9M12 12L4 7.5M12 12l8-4.5',
  mask: 'M4 4h4M10 4h4M16 4h4M4 4v4M4 10v4M4 16v4M20 4v4M20 10v4M20 16v4M4 20h4M10 20h4M16 20h4',
  portal: 'M5 21V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16M4 21h16M14 11.5h1.5',
  npc: 'M12 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM5 21v-1a7 7 0 0 1 14 0v1',
  monster:
    'M12 13c-3 0-5.5 2-5.5 4.5 0 1.5 1 2.5 2.5 2.5 1 0 2-.5 3-.5s2 .5 3 .5c1.5 0 2.5-1 2.5-2.5C17.5 15 15 13 12 13zM6.5 11a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM10.5 8a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM13.5 8a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM17.5 11a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z',
  floorPatch: 'M4 4h16v16H4zM4 12h16M12 4v16',
} as const satisfies Record<EditorTool, IconPath>

/** Bounded numeric row for the sector forms. */
export function numberField(
  labelText: string,
  options: { min: number; max: number; value: number; step?: number }
): { row: HTMLElement; input: HTMLInputElement } {
  return field(labelText, {
    type: 'number',
    min: options.min,
    max: options.max,
    step: options.step ?? 1,
    value: String(options.value),
  })
}

/**
 * Selects `value`, preserving it even when no option matches. A stored registry id the model pack
 * no longer maps is a supported state (it renders a placeholder rather than being rejected), but
 * assigning it to a `<select>` with no matching option leaves the control blank and reads back `''`
 * — so a later commit would silently wipe the authored id. Appending a marked option keeps the id
 * displayed and round-tripped verbatim.
 */
export function setSelectValue(input: HTMLSelectElement, value: string): void {
  input.value = value
  if (input.value === value) return
  input.append(element('option', { text: `${value} (unmapped)`, attributes: { value } }))
  input.value = value
}
