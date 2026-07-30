import { renderChatLine } from '@/i18n'
import { catalogTables, currentLocale } from '@/i18n'
import type { AppShell } from '@/ui/appShell'

/**
 * Read-only introspection surface for automated verification, playing the part `WorldScene3D`'s
 * `_`-prefixed test seams play natively.
 *
 * Not a one-to-one port of those: the structural analogue is the seven `_`-prefixed methods on
 * `WorldScene` (`scene/worldScene.ts`), and this surface reads through two of them while adding
 * controller and session state the scene never sees — connection state, the sector name, the chat
 * scrollback, the presented overlay, the zoom factor.
 *
 * It exists because a WebGL canvas is opaque to a DOM-driving agent: `agent-browser snapshot` can
 * see the panels and the chat input, but nothing about where the character stands, which sector is
 * loaded, or whether a model resolved. Everything here is a getter over state the client already
 * holds; nothing mutates the session, so exposing it cannot change gameplay.
 */

export interface SomnioDebugAPI {
  connectionState(): string
  /** `undefined` until `mainCharacter` arrives and the entity stream places the player. */
  player(): { x: number; y: number; facing: number; tempo: number; name: string } | undefined
  sectorName(): string | undefined
  entities(): { id: number; kind: string; name: string; x: number; y: number }[]
  /** How many placed objects are still rendering a placeholder rather than a resolved model. */
  placeholderObjectCount(): number
  /** Localized scrollback, matching exactly what the chat panel shows. */
  chatHistory(): string[]
  cameraScale(): number | undefined
  overlay(): string | undefined
  zoomFactor(): number
}

export function makeDebugAPI(shell: AppShell): SomnioDebugAPI {
  return {
    connectionState: () => shell.controller.connectionState,
    player: () => {
      const index = shell.controller.selfEntityIndex
      if (index === undefined) return undefined
      const entity = shell.controller.entities.get(index)
      if (entity === undefined) return undefined
      return {
        x: entity.position.x,
        y: entity.position.y,
        facing: entity.facing,
        tempo: entity.tempo,
        name: entity.name,
      }
    },
    sectorName: () => shell.controller.currentSector?.name,
    entities: () =>
      [...shell.controller.entities.values()].map((entity) => ({
        id: entity.id,
        kind: entity.kind,
        name: entity.name,
        x: entity.position.x,
        y: entity.position.y,
      })),
    placeholderObjectCount: () => shell.scene?._placeholderObjectCount() ?? 0,
    chatHistory: () =>
      shell.controller.chatHistory.map((line) => renderChatLine(line, catalogTables, currentLocale())),
    cameraScale: () => shell.scene?._cameraScale(),
    overlay: () => shell.controller.presentedOverlay?.kind,
    zoomFactor: () => shell.session.zoom.factor,
  }
}

/**
 * Installs the API on `window.somnio`.
 *
 * Gated rather than unconditional: a dev build always exposes it, while a production build requires
 * `?debug=1` on the URL. An always-on introspection surface in production would be a standing
 * information leak — `entities()` reports every peer's name and position in the sector, which is
 * more than the rendered view gives away.
 */
export function installDebugAPI(
  shell: AppShell,
  options: { isDevelopment: boolean; search?: string } = { isDevelopment: false }
): boolean {
  const search = options.search ?? window.location.search
  const requested = new URLSearchParams(search).get('debug') === '1'
  if (!options.isDevelopment && !requested) return false
  ;(window as unknown as { somnio: SomnioDebugAPI }).somnio = makeDebugAPI(shell)
  return true
}
