import { renderChatLine } from '@/i18n';
import { catalogTables, currentLocale } from '@/i18n';
import { inventoryMessage, questsMessage } from '@somnio/core';
import type { AbilityId, EffectId, EliteTraitId, EngageAction, Point, QuestMarker } from '@somnio/core';
import type { Energy, Held, InventoryMessage, LootContentsMessage, LucidityMessage, NightmareRank, QuestsMessage, TelegraphKind } from '@somnio/protocol';
import type { AppShell } from '@/ui/appShell';

/**
 * Read-only introspection surface for automated verification.
 *
 * It reads through `_`-prefixed test seams on `WorldScene` (`scene/worldScene.ts`) and adds
 * controller and session state the scene never sees — connection state, the space and sector, the
 * chat scrollback, the presented overlay, the zoom factor, the player's own pools, lucidity,
 * inventory, and quests, the quest markers in view, what the quest tracker says, where the
 * Character window draws their body, what each dreamer's hands hold, the walk under way, the
 * target, the belt's abilities with their cooldowns, the frames' effects, channels, and raises, the
 * fallen a Mystic senses, the telegraphs in view, and the drops lying for the player.
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
  /** Where the player is walking: a path's destination and the waypoints left, the point a held pointer steers toward, or where a leap ends. */
  walk(): { kind: 'path'; destination: Point; waypoints: Point[] } | { kind: 'steer'; toward: Point } | { kind: 'leap'; end: Point } | undefined;
  spaceId(): string | undefined;
  /** The sector the predicted position stands in. */
  sectorName(): string | undefined;
  /**
   * `held` is what a dreamer's hands hold, as base ids; absent for anything but a dreamer. `rank`
   * is an elite's or a boss's, and `trait` an elite's; absent for any other entity.
   */
  entities(): { id: string; kind: string; name: string; x: number; z: number; condition: string; held?: Held; rank?: NightmareRank; trait?: EliteTraitId }[];
  /** The player's own pools, as last sent. */
  energy(): Energy;
  lucidity(): LucidityMessage;
  /** What the player carries, as last sent, the bag at its places, without the items this build does not know. */
  inventory(): InventoryMessage;
  /**
   * The quests the player holds, with what they have done toward each objective, those they turned
   * in, and the world day's bounties, each with its definition, as the last `quests` frame said,
   * without the quests this build does not know.
   */
  quests(): QuestsMessage;
  /**
   * The marker each carrier in view shows the player, an NPC by its entity id and a fixture by its
   * carrier id, with where on the page the carrier is drawn, in CSS pixels, so a press can be aimed
   * at it; `screen` is `undefined` for one not drawn.
   */
  questMarkers(): { carrierId: string; marker: QuestMarker; screen: { x: number; y: number } | undefined }[];
  /**
   * What the quest tracker says, as drawn: whether it shows at all, whether its list shows under the
   * heading, and whether a finger's list is folded to its first quest, then each quest in its order
   * with its title and either how far each line has come or where to turn it in.
   */
  questTracker(): { shown: boolean; listShown: boolean; folded: boolean; quests: { questId: string; title: string; lines: string[]; returnTo?: string }[] };
  /**
   * Where the Character window draws the player's body on the page, in CSS pixels, and how far it
   * is turned from its usual view, in degrees; `undefined` while it is not shown.
   */
  characterBody(): { left: number; top: number; width: number; height: number; turnDegrees: number } | undefined;
  winded(): boolean;
  /** Whether Run is on. */
  running(): boolean;
  /** Whether slot 1 is on. */
  engaged(): boolean;
  /** What slot 1 does at the target, or `undefined` while it cannot be switched on. */
  engageAction(): EngageAction | undefined;
  /** The id of the carrier, an NPC or a fixture, whose service panel is open. */
  servicePanel(): string | undefined;
  /** The id of the entity the player has selected. */
  target(): string | undefined;
  /** Whether the player's facing is locked on the target, whatever the cursor does. */
  gazeLocked(): boolean;
  /** The share of its health the server last sent for the target, or from the player's own pools when that is themselves. */
  vitals(entityId: string): number | undefined;
  /**
   * The abilities on the belt's slots after slot 1, in its order: whether the server would act on
   * each now but for its cooldowns, and the seconds left on the cooldown its slot waits on, its own
   * or the global one, whichever ends later; 0 while none runs.
   */
  abilities(): { abilityId: AbilityId; usable: boolean; cooldownSeconds: number }[];
  /** The effects the server last sent of the player or of their target, with the seconds each has left; none of anyone else. */
  effects(entityId: string): { effectId: EffectId; seconds?: number }[];
  /** The channel the server last showed the entity has under way, with the seconds it has left; `undefined` while none runs. */
  channel(entityId: string): { abilityId: AbilityId; seconds: number } | undefined;
  /** The raise under way on the fallen dreamer, as its last snapshot states it: the Healers holding on, and the seconds left at their pace; `undefined` while none runs. */
  raise(entityId: string): { healerNames: string[]; seconds: number } | undefined;
  /** Where each fallen dreamer in the space lies, as the server last told a player who senses the fallen; none for anyone else. */
  sensed(): { name: string; x: number; z: number }[];
  /**
   * The circles a nightmare in view has telegraphed and not yet struck, with the seconds left before
   * each strikes; one whose caster was driven off or left view is gone.
   */
  telegraphs(): { id: string; kind: TelegraphKind; casterId: string; x: number; z: number; radius: number; seconds: number }[];
  /**
   * The drops lying on the ground for the player, as the server last said, each with what it is (an
   * item's base and rarity, or a trophy's kind), whether it is an item a dreamer dropped for anyone
   * (`shared`), and where on the page its name and its model are drawn, in CSS pixels, so a press
   * can be aimed at either; `undefined` for one not drawn, and `model` for one drawn without its
   * model.
   */
  loot(): (LootContentsMessage & {
    lootId: string;
    shared: boolean;
    x: number;
    z: number;
    label: { x: number; y: number } | undefined;
    model: { x: number; y: number } | undefined;
  })[];
  /** Where on the page an entity's body is drawn, in CSS pixels, so a click can be aimed at it. */
  screenPoint(entityId: string): { x: number; y: number } | undefined;
  /**
   * The fixtures of the sectors held, each by its carrier id with the service it carries, where it
   * stands in the space, and where on the page its model is drawn, in CSS pixels, so a press can be
   * aimed at it; `screen` is `undefined` for one not drawn.
   */
  fixtures(): { id: string; service: string; x: number; z: number; screen: { x: number; y: number } | undefined }[];
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

/** The seconds from now until a moment on the session's clock, which is the page's `performance.now()`. */
function secondsUntil(atMs: number): number {
  return Math.max(0, (atMs - performance.now()) / 1000);
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
      if (walk.kind === 'leap') return { kind: 'leap', end: { ...walk.end } };
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
        ...(entity.held === undefined ? {} : { held: { ...entity.held } }),
        ...(entity.rank === undefined ? {} : { rank: entity.rank }),
        ...(entity.trait === undefined ? {} : { trait: entity.trait }),
      })),
    energy: () => shell.session.energy,
    lucidity: () => shell.session.lucidity,
    inventory: () => inventoryMessage(shell.session.inventory),
    quests: () => questsMessage(shell.session.quests, shell.session.bounties),
    questMarkers: () => {
      const fixtures = new Set((shell.controller.world?.fixtures ?? []).map(({ id }) => id));
      return [...shell.session.questMarkers].flatMap(([carrierId, marker]) => {
        if (shell.controller.entities.has(carrierId)) return [{ carrierId, marker, screen: shell.pagePointOf(carrierId) }];
        return fixtures.has(carrierId) ? [{ carrierId, marker, screen: shell.pagePointOfFixture(carrierId) }] : [];
      });
    },
    questTracker: () => {
      const { quests, ...shown } = shell.hud.questTracker;
      return {
        ...shown,
        quests: quests.map(({ questId, title, lines, returnTo }) => ({
          questId,
          title,
          lines: lines.map(({ text, count }) => `${text} ${count}`),
          ...(returnTo === undefined ? {} : { returnTo }),
        })),
      };
    },
    characterBody: () => {
      const { left, top, width, height } = shell.hud.portraits.body.getBoundingClientRect();
      if (width === 0 || height === 0) return undefined;
      return { left, top, width, height, turnDegrees: (shell.hud.bodyTurn(performance.now()) * 180) / Math.PI };
    },
    winded: () => shell.session.winded,
    running: () => shell.session.running,
    engaged: () => shell.session.engaged,
    engageAction: () => shell.session.engageAction(),
    servicePanel: () => shell.session.servicePanel?.id,
    target: () => shell.session.target,
    gazeLocked: () => shell.session.gazeLocked,
    vitals: (entityId) => shell.session.vitalsOf(entityId),
    abilities: () =>
      shell.session.abilitySlots().map(({ abilityId, refusal, cooldown }) => ({
        abilityId,
        usable: refusal === undefined,
        cooldownSeconds: cooldown === undefined ? 0 : secondsUntil(cooldown.endsAtMs),
      })),
    effects: (entityId) =>
      shell.session.effectsOf(entityId).map(({ effectId, endsAtMs }) => ({ effectId, ...(endsAtMs === undefined ? {} : { seconds: secondsUntil(endsAtMs) }) })),
    channel: (entityId) => {
      const channel = shell.session.channelOf(entityId);
      return channel === undefined ? undefined : { abilityId: channel.abilityId, seconds: secondsUntil(channel.endsAtMs) };
    },
    raise: (entityId) => {
      const raise = shell.session.raiseOf(entityId);
      return raise === undefined ? undefined : { healerNames: [...raise.healerNames], seconds: secondsUntil(raise.endsAtMs) };
    },
    sensed: () => shell.session.sensed.map(({ name, x, z }) => ({ name, x, z })),
    telegraphs: () =>
      shell.session
        .telegraphsUnderWay()
        .map(({ id, kind, casterId, x, z, radius, endsAtMs }) => ({ id, kind, casterId, x, z, radius, seconds: secondsUntil(endsAtMs) })),
    loot: () =>
      [...shell.session.loot.values()].map(({ lootId, x, z, contents, shared }) => ({
        lootId,
        ...contents,
        shared: shared === true,
        x,
        z,
        label: shell.pagePointOfLoot(lootId, 'label'),
        model: shell.pagePointOfLoot(lootId, 'model'),
      })),
    screenPoint: (entityId) => shell.pagePointOf(entityId),
    fixtures: () =>
      (shell.controller.world?.fixtures ?? []).map(({ id, fixture, position }) => ({
        id,
        service: fixture.service,
        x: position.x,
        z: position.z,
        screen: shell.pagePointOfFixture(id),
      })),
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
