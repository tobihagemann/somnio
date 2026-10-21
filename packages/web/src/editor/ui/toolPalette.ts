import { SOMNIO_PROTOCOL_CONSTANTS } from '@somnio/protocol';
import { GROUND_MATERIAL_IDS } from '@/scene/groundMaterials';
import { element, iconButton, select, setHidden } from '@/ui/dom';
import { EDITOR_TOOLS } from '../canvasController';
import type { EditorTool } from '../canvasController';
import type { GroundBrush } from '../groundMarks';
import { millimetres } from '../preferences';
import { EDITOR_ICON_PATHS, numberField, setSelectValue } from './editorDom';

/**
 * The tool palette (top-leading): one icon button per tool in declaration order, the active
 * one outlined in the selection yellow. With the ground tool active it also carries the brush: the
 * material new marks are painted in, and a stroke's radius, capped at the widest the document takes.
 */

const TOOL_TITLES: Record<EditorTool, string> = {
  select: 'Select',
  placement: 'Model',
  blocker: 'Blocker',
  npc: 'NPC',
  monsterSpawn: 'Monster spawn',
  ground: 'Ground',
  spawn: 'Spawn point',
};

export class ToolPalette {
  readonly root: HTMLElement;

  private readonly buttons: Record<EditorTool, HTMLButtonElement>;
  private readonly brushRows: HTMLElement;
  private readonly materialInput: HTMLSelectElement;
  private readonly radiusInput: HTMLInputElement;
  /** The brush radius as last rendered, which an emptied radius field reverts to. */
  private shownRadius = 0;

  constructor(onSelectTool: (tool: EditorTool) => void, onBrushChange: (brush: Partial<GroundBrush>) => void) {
    const buttons = {} as Record<EditorTool, HTMLButtonElement>;
    for (const tool of EDITOR_TOOLS) {
      buttons[tool] = iconButton(TOOL_TITLES[tool], EDITOR_ICON_PATHS[tool], () => onSelectTool(tool), {
        className: 'fantasy-button fantasy-button--compact',
      });
    }
    this.buttons = buttons;
    const material = select(
      'Ground material',
      GROUND_MATERIAL_IDS.map((id) => ({ value: id, label: id })),
    );
    const radius = numberField('Stroke radius (m)', { min: 0, max: SOMNIO_PROTOCOL_CONSTANTS.maxMarkStrokeRadiusMetres, step: 0.1, value: 0 });
    this.materialInput = material.input;
    this.radiusInput = radius.input;
    this.materialInput.addEventListener('change', () => onBrushChange({ materialId: this.materialInput.value }));
    this.radiusInput.addEventListener('change', () => {
      // An emptied field reverts rather than coercing to 0 (`Number('')` is 0).
      if (this.radiusInput.value.trim() === '') {
        this.radiusInput.value = String(this.shownRadius);
        return;
      }
      const value = Number(this.radiusInput.value);
      if (Number.isFinite(value)) onBrushChange({ radius: millimetres(Math.min(Math.max(value, 0), Number(this.radiusInput.max))) });
    });
    this.brushRows = element('div', { className: 'editor-brush', children: [material.row, radius.row] });
    this.root = element('div', {
      className: 'fantasy-panel editor-tool-palette',
      children: [element('div', { className: 'editor-tool-buttons', children: EDITOR_TOOLS.map((tool) => buttons[tool]) }), this.brushRows],
    });
  }

  render(activeTool: EditorTool, brush: GroundBrush, maxRadius: number): void {
    for (const tool of EDITOR_TOOLS) {
      this.buttons[tool].classList.toggle('editor-tool--active', tool === activeTool);
      this.buttons[tool].setAttribute('aria-pressed', tool === activeTool ? 'true' : 'false');
    }
    setHidden(this.brushRows, activeTool !== 'ground');
    setSelectValue(this.materialInput, brush.materialId);
    this.radiusInput.max = String(maxRadius);
    this.shownRadius = Math.min(brush.radius, maxRadius);
    if (globalThis.document.activeElement !== this.radiusInput) this.radiusInput.value = String(this.shownRadius);
  }
}
