import { renderChatLine } from '@/i18n';
import { catalogTables, currentLocale } from '@/i18n';
import type { EngageAction, Point } from '@somnio/core';
import type { Energy, LucidityMessage } from '@somnio/protocol';
import type { AppShell } from '@/ui/appShell';

/**
 * Read-only introspection surface for automated verification.
 *
 * It reads through `_`-prefixed test seams on `WorldScene` (`scene/worldScene.ts`) and
 * adds controller and session state the scene never sees — connection state, the space and sector,
 * the chat scrollback, the presented overlay, the zoom factor, the player's own pools and lucidity, the
 * walk under way, and the target.
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
  /** Where the player is walking: a path's destination and the waypoints left, or the point a held pointer steers toward. */
  walk(): { kind: 'path'; destination: Point; waypoints: Point[] } | { kind: 'steer'; toward: Point } | undefined;
  spaceId(): string | undefined;
  /** The sector the predicted position stands in. */
  sectorName(): string | undefined;
  entities(): { id: string; kind: string; name: string; x: number; z: number; condition: string }[];
  /** The player's own pools, as last sent. */
  energy(): Energy;
  lucidity(): LucidityMessage;
  winded(): boolean;
  /** Whether Run is on. */
  running(): boolean;
  /** Whether slot 1 is on. */
  engaged(): boolean;
  /** What slot 1 does at the target, or `undefined` while it cannot be switched on. */
  engageAction(): EngageAction | undefined;
  /** The id of the NPC whose service panel is open. */
  servicePanel(): string | undefined;
  /** The id of the entity the player has selected. */
  target(): string | undefined;
  /** Whether the player's facing is locked on the target, whatever the cursor does. */
  gazeLocked(): boolean;
  /** The share of its health the server last sent for the target, or from the player's own pools when that is themselves. */
  vitals(entityId: string): number | undefined;
  /** Where on the page an entity's body is drawn, in CSS pixels, so a click can be aimed at it. */
  screenPoint(entityId: string): { x: number; y: number } | undefined;
  /** Where on the page a point of the space is drawn on the ground, in CSS pixels, so a tap can be aimed at it. */
  groundScreenPoint(x: number, z: number): { x: number; y: number } | undefined;
  /** How many placed objects are still rendering a placeholder rather than a resolved model. */
  placeholderObjectCount(): number;
  /** The retained chat lines, localized as the chat panel renders them. The panel's greeting is not one of them. */
  chatHistory(): string[];
  cameraScale(): number | undefined;
  overlay(): string | undefined;
  zoomFactor(): number;
  /** The id of the splash shot playing, or `undefined` while none is. */
  splashShot(): string | undefined;
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
    walk: () => {
      const walk = shell.session.predictor.walk;
      if (walk === undefined) return undefined;
      if (walk.kind === 'steer') return { kind: 'steer', toward: { ...walk.toward } };
      return { kind: 'path', destination: { ...walk.destination }, waypoints: walk.waypoints.map((point) => ({ ...point })) };
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
    running: () => shell.session.running,
    engaged: () => shell.session.engaged,
    engageAction: () => shell.session.engageAction(),
    servicePanel: () => shell.session.servicePanel?.id,
    target: () => shell.session.target,
    gazeLocked: () => shell.session.gazeLocked,
    vitals: (entityId) => shell.session.vitalsOf(entityId),
    screenPoint: (entityId) => shell.pagePointOf(entityId),
    groundScreenPoint: (x, z) => shell.pagePointOfGround({ x, z }),
    placeholderObjectCount: () => shell.scene?._placeholderObjectCount() ?? 0,
    chatHistory: () => shell.controller.chatHistory.map((line) => renderChatLine(line, catalogTables, currentLocale())),
    cameraScale: () => shell.scene?._cameraScale(),
    overlay: () => shell.controller.presentedOverlay?.kind,
    zoomFactor: () => shell.session.zoom.factor,
    splashShot: () => shell.splash?.currentShotId,
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
