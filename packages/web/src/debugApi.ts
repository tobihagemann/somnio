import { renderChatLine } from '@/i18n';
import { catalogTables, currentLocale } from '@/i18n';
import type { Energy, LucidityMessage } from '@somnio/protocol';
import type { AppShell } from '@/ui/appShell';

/**
 * Read-only introspection surface for automated verification.
 *
 * It reads through `_`-prefixed test seams on `WorldScene` (`scene/worldScene.ts`) and
 * adds controller and session state the scene never sees — connection state, the space and sector,
 * the chat scrollback, the presented overlay, the zoom factor, and the player's own pools and lucidity.
 *
 * It exists because a WebGL canvas is opaque to a DOM-driving agent: `agent-browser snapshot` can
 * see the panels and the chat input, but nothing about where the character stands, which sector
 * it is in, or whether a model resolved. Everything here is a getter over state the client already
 * holds; nothing mutates the session, so exposing it cannot change gameplay.
 */

export interface SomnioDebugAPI {
  connectionState(): string;
  /** `undefined` until the entity stream places the player. Metres, in the space's coordinates. */
  player(): { x: number; z: number; facing: number; gait: string; name: string } | undefined;
  spaceId(): string | undefined;
  /** The sector the predicted position stands in. */
  sectorName(): string | undefined;
  entities(): { id: string; kind: string; name: string; x: number; z: number; condition: string }[];
  /** The player's own pools, as last sent. */
  energy(): Energy;
  lucidity(): LucidityMessage;
  winded(): boolean;
  /** The id of the NPC whose service panel is open. */
  servicePanel(): string | undefined;
  /** The id of the dreamer the player tends. */
  tending(): string | undefined;
  /** Where on the page an entity's body is drawn, in CSS pixels, so a click can be aimed at it. */
  screenPoint(entityId: string): { x: number; y: number } | undefined;
  /** How many placed objects are still rendering a placeholder rather than a resolved model. */
  placeholderObjectCount(): number;
  /** The retained chat lines, localized as the chat panel renders them. The panel's greeting is not one of them. */
  chatHistory(): string[];
  cameraScale(): number | undefined;
  overlay(): string | undefined;
  zoomFactor(): number;
}

export function makeDebugAPI(shell: AppShell): SomnioDebugAPI {
  return {
    connectionState: () => shell.controller.connectionState,
    player: () => {
      const selfId = shell.controller.selfId;
      if (selfId === undefined) return undefined;
      const entity = shell.controller.entities.get(selfId);
      if (entity === undefined) return undefined;
      return {
        x: entity.position.x,
        z: entity.position.z,
        facing: entity.facing,
        gait: entity.gait,
        name: entity.name,
      };
    },
    spaceId: () => shell.controller.world?.spaceId,
    sectorName: () => shell.controller.world?.predictedSector,
    entities: () =>
      [...shell.controller.entities.values()].map((entity) => ({
        id: entity.id,
        kind: entity.kind,
        name: entity.name,
        x: entity.position.x,
        z: entity.position.z,
        condition: entity.condition,
      })),
    energy: () => shell.session.energy,
    lucidity: () => shell.session.lucidity,
    winded: () => shell.session.winded,
    servicePanel: () => shell.session.servicePanel?.id,
    tending: () => shell.session.tending,
    screenPoint: (entityId) => shell.pagePointOf(entityId),
    placeholderObjectCount: () => shell.scene?._placeholderObjectCount() ?? 0,
    chatHistory: () => shell.controller.chatHistory.map((line) => renderChatLine(line, catalogTables, currentLocale())),
    cameraScale: () => shell.scene?._cameraScale(),
    overlay: () => shell.controller.presentedOverlay?.kind,
    zoomFactor: () => shell.session.zoom.factor,
  };
}

/**
 * Installs the API on `window.somnio`.
 *
 * Gated rather than unconditional: a dev build always exposes it, while a production build requires
 * `?debug=1` on the URL. An always-on introspection surface in production would be a standing
 * information leak — `entities()` reports every peer's name and position, which is
 * more than the rendered view gives away.
 */
export function installDebugAPI(shell: AppShell, options: { isDevelopment: boolean; search?: string } = { isDevelopment: false }): boolean {
  const search = options.search ?? window.location.search;
  const requested = new URLSearchParams(search).get('debug') === '1';
  if (!options.isDevelopment && !requested) return false;
  (window as unknown as { somnio: SomnioDebugAPI }).somnio = makeDebugAPI(shell);
  return true;
}
