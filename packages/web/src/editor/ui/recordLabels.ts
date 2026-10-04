import { element, replaceChildren } from '@/ui/dom';
import type { Point } from '@somnio/core';
import type { OverlayLabel } from '../authoringOverlay';
import type { ScreenPoint } from '../picking';

/**
 * The authoring overlay's text labels, as real elements over the canvas: text drawn into the
 * WebGL scene would be invisible to `agent-browser snapshot` and to a screen reader. Rebuilt with
 * the overlay, so the labels follow every pan, zoom, and live drag.
 */
export class RecordLabels {
  readonly root = element('div', { className: 'editor-labels' });

  render(labels: readonly OverlayLabel[], project: (point: Point) => ScreenPoint): void {
    replaceChildren(
      this.root,
      labels.map((label) => {
        const node = element('span', { className: label.issue ? 'editor-label editor-label--issue' : 'editor-label', text: label.text });
        const at = project(label.at);
        node.style.left = `${at.x}px`;
        node.style.top = `${at.y}px`;
        return node;
      }),
    );
  }
}
