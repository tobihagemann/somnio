import { element, iconButton } from '@/ui/dom'
import type { IconName } from '@/ui/dom'
import { EDITOR_TOOLS } from '../canvasController'
import type { EditorTool } from '../canvasController'

/**
 * The tool palette (top-leading): one icon button per tool in declaration order, the active
 * one outlined in the selection yellow.
 */

export const TOOL_TITLES: Record<EditorTool, string> = {
  select: 'Select',
  object: 'Object',
  mask: 'Mask',
  portal: 'Sector portal',
  npc: 'NPC',
  monster: 'Monster',
  floorPatch: 'Floor patch',
}

const TOOL_ICONS: Record<EditorTool, IconName> = {
  select: 'select',
  object: 'object',
  mask: 'mask',
  portal: 'portal',
  npc: 'npc',
  monster: 'monster',
  floorPatch: 'floorPatch',
}

export class ToolPalette {
  readonly root: HTMLElement

  private readonly buttons: Record<EditorTool, HTMLButtonElement>

  constructor(onSelectTool: (tool: EditorTool) => void) {
    const buttons = {} as Record<EditorTool, HTMLButtonElement>
    for (const tool of EDITOR_TOOLS) {
      buttons[tool] = iconButton(TOOL_TITLES[tool], TOOL_ICONS[tool], () => onSelectTool(tool), {
        className: 'fantasy-button fantasy-button--compact',
      })
    }
    this.buttons = buttons
    this.root = element('div', {
      className: 'fantasy-panel editor-tool-palette',
      children: EDITOR_TOOLS.map((tool) => buttons[tool]),
    })
  }

  render(activeTool: EditorTool): void {
    for (const tool of EDITOR_TOOLS) {
      this.buttons[tool].classList.toggle('editor-tool--active', tool === activeTool)
      this.buttons[tool].setAttribute('aria-pressed', tool === activeTool ? 'true' : 'false')
    }
  }
}
