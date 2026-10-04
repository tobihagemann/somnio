import { element } from '@/ui/dom';
import type { ModelRegistry, Sector } from '@somnio/core';
import { selectionFootprint } from '../selection';
import type { EditorSelection } from '../selection';

/**
 * The bottom-leading status strip: X/Z track the hovered ground point in the sector's metres,
 * W/D mirror the single selection's footprint (a multi-selection has no one record size, so they
 * clear), plus the sector name.
 */
export class CursorReadout {
  readonly root: HTMLElement;

  x = 0;
  z = 0;
  width = 0;
  depth = 0;

  private readonly text = element('span');

  constructor() {
    this.root = element('div', {
      className: 'fantasy-panel editor-readout',
      children: [this.text],
    });
    this.render('');
  }

  /** W/D track a single selection only, and clear when nothing (or several) is selected. */
  applyBounds(selection: readonly EditorSelection[], sector: Sector, registry: ModelRegistry): void {
    const rect = selection.length === 1 ? selectionFootprint(selection[0]!, sector, registry)?.rect : undefined;
    this.width = rect?.width ?? 0;
    this.depth = rect?.depth ?? 0;
  }

  render(sectorName: string): void {
    const name = sectorName === '' ? '' : `  ${sectorName}`;
    const metres = (value: number): string => value.toFixed(2);
    this.text.textContent = `X: ${metres(this.x)}  Z: ${metres(this.z)}  W: ${metres(this.width)}  D: ${metres(this.depth)}${name}`;
  }
}
