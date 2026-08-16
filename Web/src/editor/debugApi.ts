import type { EditorShell } from './editorShell'

/**
 * Read-only introspection surface for automated verification, following
 * `src/debugApi.ts`'s shape: everything here is a getter over state the editor already
 * holds, because the WebGL canvas is opaque to a DOM-driving agent. Installed
 * unconditionally — the editor page exists only under `vite dev`, so there is no
 * production build to gate.
 */

export interface SomnioEditorDebugAPI {
  sectorName(): string
  /** Record counts per array — enough to assert a placement landed without dumping bodies. */
  body(): Record<string, number>
  selection(): { kind: string; index: number }[]
  tool(): string
  overlay(): string | undefined
  isDirty(): boolean
  undoDepth(): number
  placeholderObjectCount(): number
  cameraScale(): number
}

export function makeEditorDebugAPI(shell: EditorShell): SomnioEditorDebugAPI {
  return {
    sectorName: () => shell.document.sector.name,
    body: () => shell.recordCounts(),
    selection: () => shell.selection.map((entry) => ({ kind: entry.kind, index: entry.index })),
    tool: () => shell.tool,
    overlay: () => shell.presentedOverlay,
    isDirty: () => shell.document.isDirty,
    undoDepth: () => shell.document.undoDepth,
    placeholderObjectCount: () => shell.scene._placeholderObjectCount(),
    cameraScale: () => shell.camera.framing.scale,
  }
}

export function installEditorDebugAPI(shell: EditorShell): void {
  ;(window as unknown as { somnioEditor: SomnioEditorDebugAPI }).somnioEditor = makeEditorDebugAPI(shell)
}
