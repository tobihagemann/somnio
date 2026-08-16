import { element } from '@/ui/dom'
import type { Sector } from '@/core/sector'
import { selectionBounds } from '../selection'
import type { EditorSelection } from '../selection'

/**
 * The bottom-leading status strip: X/Y track the hovered sector pixel, W/H mirror the single
 * selection's bounds (a multi-selection has no one record size, so they clear), plus the
 * sector name.
 */
export class CursorReadout {
  readonly root: HTMLElement

  x = 0
  y = 0
  width = 0
  height = 0

  private readonly text = element('span')

  constructor() {
    this.root = element('div', {
      className: 'fantasy-panel editor-readout',
      children: [this.text],
    })
    this.render('')
  }

  /** W/H track a single selection only, and clear when nothing (or several) is selected. */
  applyBounds(selection: readonly EditorSelection[], sector: Sector): void {
    if (selection.length !== 1) {
      this.width = 0
      this.height = 0
      return
    }
    const bounds = selectionBounds(selection[0]!, sector)
    this.width = bounds?.size.width ?? 0
    this.height = bounds?.size.height ?? 0
  }

  render(sectorName: string): void {
    const name = sectorName === '' ? '' : `  ${sectorName}`
    this.text.textContent = `X: ${this.x}  Y: ${this.y}  W: ${this.width}  H: ${this.height}${name}`
  }
}
