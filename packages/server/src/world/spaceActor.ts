import { encodeSomnioMessage } from '@somnio/protocol';
import type { ClientSayMessage, EntityMessage, EntityMove, Gait, Hand, InventoryMessage, MoveMessage, SomnioMessage } from '@somnio/protocol';
import {
  SOMNIO_CONSTANTS,
  buildSpaceCollision,
  canStand,
  dialogLine,
  dialogSteps,
  distance,
  gaitMetresPerSecond,
  heading,
  headingFromCardinal,
  headingFromVector,
  isClear,
  isLegalMove,
  monsterKind,
  neighbourSectors,
  npcBodies,
  sectorAt,
  sectorPointInSpace,
  sectorView,
} from '@somnio/core';
import type {
  Body,
  Character,
  Heading,
  InventoryRow,
  MonsterKind,
  MonsterSpawn,
  NPCDialogState,
  Point,
  Sector,
  SectorNPC,
  Space,
  SpaceCollision,
} from '@somnio/core';
import { encodeOrWarn } from '../connection/encodeFrame.ts';
import type { ConnectionOutbox } from '../connection/outbox.ts';
import type { Logger } from '../logging.ts';
import type { LoadedWorld } from '../sectors/sectorCache.ts';
import { randomInRange, systemRandom } from './random.ts';
import type { RandomSource } from './random.ts';

interface PlayerSlot {
  character: Character;
  inventory: InventoryRow[];
  outbox: ConnectionOutbox;
  gait: Gait;
  /** The sector the player stands in, which decides what they are sent. */
  sector: string;
  /** The metres the player may still move, as of `allowanceAt`. */
  allowance: number;
  allowanceAt: number;
  rejectionLoggedAt: number | undefined;
  suppressedRejections: number;
}

interface NPCRuntime {
  id: string;
  sector: string;
  definition: SectorNPC;
  position: Point;
  targetingEntity: string | undefined;
  /** The parsed script, cached so a step does not parse it again. */
  dialogSteps: string[];
  /** No step is emitted before this moment. */
  readyAt: number;
  /** 0-based cursor into `dialogSteps`. Persisted as 1-based; translated at the seam. */
  scriptStepIndex: number;
}

interface MonsterRuntime {
  id: string;
  kind: MonsterKind;
  sector: string;
  position: Point;
  /** Turned toward the chase target while chasing. An idle monster keeps the facing it last had, south until its first chase. */
  facing: Heading;
}

/** Per-`MonsterSpawn` cadence: while fewer than `maxAlive` of its monsters live, it spawns one at `spawnAt`. */
interface MonsterSpawnTimer {
  sector: Sector;
  definition: MonsterSpawn;
  alive: number;
  spawnAt: number;
}

export interface PlayerCheckpoint {
  character: Character;
  inventory: InventoryRow[];
}

/** One step's persistence digest; the router applies it outside the actor so a failed write cannot corrupt in-process state. */
export interface TickDigest {
  dialogUpserts: NPCDialogState[];
  /** The NPCs whose dialog row is deleted: a reset persists a deletion, not a full state. */
  dialogResets: Pick<NPCDialogState, 'sectorName' | 'npcId'>[];
}

/** What a joining player and every NPC and monster start at; a player's own gait arrives with their first move. */
const DEFAULT_GAIT: Gait = 'jog';
/**
 * A player's movement budget accrues on the server's clock at running speed with a quarter to
 * spare, and holds two seconds' worth: the reports a stalled connection held back arrive together,
 * and a client that never outran its gait is not to be corrected for them.
 */
const ALLOWANCE_METRES_PER_SECOND = gaitMetresPerSecond('run') * 1.25;
const ALLOWANCE_CAP_METRES = ALLOWANCE_METRES_PER_SECOND * 2;
/** Minimum gap between rejected-move log lines per player; rejections in between are counted. */
const REJECTED_MOVE_LOG_INTERVAL_MS = 5000;
const PLACEMENT_ATTEMPTS = 64;

export interface SpaceActorOptions {
  logger: Logger;
  /** The persisted 1-based dialog cursors of the space's sectors. */
  initialDialogStates?: readonly NPCDialogState[];
  random?: RandomSource;
  /** Monotonic milliseconds, for the movement allowance and the dialog and spawn deadlines. */
  now?: () => number;
}

type NPCDialogAction = { kind: 'holdCooldown' } | { kind: 'resetTargeting' } | { kind: 'emit'; targetName: string } | { kind: 'clearTargetingNoEmit' };

export function inventoryMessage(rows: readonly InventoryRow[]): InventoryMessage {
  return {
    rows: rows.map(({ slot, itemId, quantity, equippedHand }) => ({ slot, itemId, quantity, ...(equippedHand === undefined ? {} : { equippedHand }) })),
  };
}

/**
 * One space's runtime: its player set, NPCs and monsters, and the broadcast stream that funnels
 * every peer-visible mutation through outboxes. A player is sent their own sector and its
 * neighbours, and the entities standing in them. Every method is synchronous, so Node's
 * run-to-completion supplies the isolation the name implies; persistence is dispatched by the
 * router outside the space.
 */
export class SpaceActor {
  private readonly space: Space<Sector>;
  private readonly collision: SpaceCollision;
  private readonly playerModel: string;
  /** Per sector, the names of the sectors a player standing in it is sent: itself, then its neighbours. */
  private readonly interest = new Map<string, ReadonlySet<string>>();
  private readonly players = new Map<string, PlayerSlot>();
  private readonly npcs = new Map<string, NPCRuntime>();
  private readonly npcBodies: Body[];
  private readonly monsters = new Map<string, MonsterRuntime>();
  private readonly spawnTimers: MonsterSpawnTimer[] = [];
  /** The entities that moved since the last flush, each with the sector it now stands in. */
  private readonly moved = new Map<string, { sector: string; move: EntityMove }>();
  private readonly random: RandomSource;
  private readonly now: () => number;
  private nextMonsterNumber = 1;
  private readonly logger: Logger;

  constructor(world: LoadedWorld, spaceId: string, options: SpaceActorOptions) {
    this.space = world.spaces.get(spaceId)!;
    this.collision = buildSpaceCollision(this.space, world.registry);
    this.playerModel = world.registry.playerModel;
    this.logger = options.logger;
    this.random = options.random ?? systemRandom;
    this.now = options.now ?? (() => performance.now());
    for (const sector of this.space.sectors) {
      this.interest.set(sector.name, new Set([sector.name, ...neighbourSectors(this.space, sector.name).map((neighbour) => neighbour.name)]));
      for (const definition of sector.monsterSpawns) {
        this.spawnTimers.push({ sector, definition, alive: 0, spawnAt: this.now() + monsterKind(definition.kind).respawnSeconds * 1000 });
      }
      for (const npc of sector.npcs) {
        const id = `npc:${sector.name}/${npc.id}`;
        const steps = dialogSteps(npc.dialogScript);
        const persisted = options.initialDialogStates?.find((state) => state.sectorName === sector.name && state.npcId === npc.id);
        this.npcs.set(id, {
          id,
          sector: sector.name,
          definition: npc,
          position: sectorPointInSpace(sector, npc),
          targetingEntity: undefined,
          dialogSteps: steps,
          readyAt: 0,
          scriptStepIndex: this.resolveSeedStepIndex(persisted?.scriptStep, steps.length, id),
        });
      }
    }
    this.npcBodies = npcBodies(this.space);
  }

  /**
   * Translates a persisted 1-based `script_step` into the 0-based cursor. Out-of-range values
   * clamp to 0 with a warning so a shortened script is visible rather than silently rewound.
   */
  private resolveSeedStepIndex(persisted: number | undefined, stepCount: number, npcId: string): number {
    if (persisted === undefined) return 0;
    if (stepCount === 0) {
      if (persisted !== 1) {
        this.logger.warn({ npc: npcId, persisted_step: persisted }, 'npc dialog cursor reset (script empty)');
      }
      return 0;
    }
    if (persisted < 1 || persisted > stepCount) {
      this.logger.warn({ npc: npcId, persisted_step: persisted, step_count: stepCount }, 'npc dialog cursor clamped (out of range)');
      return 0;
    }
    return persisted - 1;
  }

  /**
   * Creates the player's slot, streams the join sequence to the newcomer's outbox with
   * `enterSpace` first, and broadcasts one `entity` for the newcomer to the players who can see
   * them. The player's entity id is the character's. Throws when no sector holds the position
   * or the join sequence cannot be encoded; a throw leaves no slot and no frame behind.
   */
  attach(character: Character, inventory: InventoryRow[], outbox: ConnectionOutbox, worldSeconds: number): void {
    const sector = sectorAt(this.space, character.position);
    if (sector === undefined) throw new Error(`no sector of ${this.space.id} holds (${character.position.x}, ${character.position.z})`);
    const slot: PlayerSlot = {
      character,
      inventory,
      outbox,
      gait: DEFAULT_GAIT,
      sector: sector.name,
      allowance: ALLOWANCE_CAP_METRES,
      allowanceAt: this.now(),
      rejectionLoggedAt: undefined,
      suppressedRejections: 0,
    };
    const interest = this.interest.get(sector.name)!;
    const messages: SomnioMessage[] = [
      { tag: 'enterSpace', payload: { spaceId: this.space.id, selfId: character.id, worldSeconds } },
      ...[...interest].map((name) => this.sectorMessage(name)),
      { tag: 'entity', payload: this.playerEntity(slot) },
      { tag: 'inventory', payload: inventoryMessage(inventory) },
      { tag: 'energy', payload: character.energy },
    ];
    for (const other of this.entities()) {
      if (interest.has(other.sector)) messages.push({ tag: 'entity', payload: other.entity });
    }
    const frames = messages.map((message) => encodeSomnioMessage(message));
    for (const frame of frames) outbox.send(frame);

    this.players.set(character.id, slot);
    this.broadcast({ tag: 'entity', payload: this.playerEntity(slot) }, slot.sector, character.id);
  }

  /** `leftGame` is `true` for a disconnect and `false` for a door transfer. */
  detach(entityId: string, leftGame: boolean): void {
    const slot = this.players.get(entityId);
    if (slot === undefined) return;
    this.players.delete(entityId);
    this.moved.delete(entityId);
    this.broadcast({ tag: 'leave', payload: { entityId, leftGame } }, slot.sector);
  }

  /** Whether a player can stand at the point: clear of the world and of every NPC. */
  canStand(point: Point): boolean {
    return canStand(this.collision, point, this.npcBodies);
  }

  /**
   * Accepts a move the player's allowance covers and the shared movement rule allows, and answers
   * any other with a `correction` to the last accepted position.
   *
   * A move the allowance covers spends its length whether or not its path is legal, so a refused
   * path costs what walking it would have. A move longer than the allowance is refused and spends
   * nothing. A client corrected after a stall past the cap still has reports under way. Those are
   * measured from the last accepted position, where their path can be illegal, so they are
   * charged too.
   *
   * Other players and monsters are deliberately not checked. The mover saw them where they were a
   * moment ago, so that comparison would only ever correct an honest client.
   */
  handleMove(message: MoveMessage, entityId: string): void {
    const slot = this.players.get(entityId);
    if (slot === undefined) return;
    const now = this.now();
    slot.allowance = Math.min(ALLOWANCE_CAP_METRES, slot.allowance + ((now - slot.allowanceAt) / 1000) * ALLOWANCE_METRES_PER_SECOND);
    slot.allowanceAt = now;
    const from = slot.character.position;
    const to = { x: message.x, z: message.z };
    const length = distance(from, to);
    if (length > slot.allowance) {
      this.rejectMove(slot, to, now);
      return;
    }
    slot.allowance -= length;
    if (!isLegalMove(this.collision, from, to, SOMNIO_CONSTANTS.playerRadius, this.npcBodies)) {
      this.rejectMove(slot, to, now);
      return;
    }
    // Wrapped into `[0, 360)` once, so storage and the broadcast carry the same normalized value.
    const facing = heading(message.facing);
    slot.character = { ...slot.character, position: to, facing };
    slot.gait = message.gait;
    const previous = slot.sector;
    slot.sector = sectorAt(this.space, to)!.name;
    this.moved.set(entityId, { sector: slot.sector, move: { id: entityId, x: to.x, z: to.z, facing, gait: slot.gait } });
    if (slot.sector !== previous) this.playerChangedSector(slot, previous);
  }

  private rejectMove(slot: PlayerSlot, to: Point, now: number): void {
    this.snapBack(slot);
    if (slot.rejectionLoggedAt !== undefined && now - slot.rejectionLoggedAt < REJECTED_MOVE_LOG_INTERVAL_MS) {
      slot.suppressedRejections += 1;
      return;
    }
    const from = slot.character.position;
    this.logger.warn(
      { entity_id: slot.character.id, from: `${from.x},${from.z}`, to: `${to.x},${to.z}`, suppressed_since_last: slot.suppressedRejections },
      'move rejected',
    );
    slot.rejectionLoggedAt = now;
    slot.suppressedRejections = 0;
  }

  private snapBack(slot: PlayerSlot): void {
    slot.outbox.sendEncoded({ tag: 'correction', payload: { x: slot.character.position.x, z: slot.character.position.z } }, this.logger);
  }

  /** The player crossed into another sector: they are sent what entered their view, and everyone is told what they now see of each other. */
  private playerChangedSector(slot: PlayerSlot, from: string): void {
    const previous = this.interest.get(from)!;
    const current = this.interest.get(slot.sector)!;
    for (const name of current) {
      if (!previous.has(name)) slot.outbox.sendEncoded(this.sectorMessage(name), this.logger);
    }
    for (const other of this.entities(slot.character.id)) {
      if (current.has(other.sector) && !previous.has(other.sector)) {
        slot.outbox.sendEncoded({ tag: 'entity', payload: other.entity }, this.logger);
      } else if (previous.has(other.sector) && !current.has(other.sector)) {
        slot.outbox.sendEncoded({ tag: 'leave', payload: { entityId: other.entity.id, leftGame: false } }, this.logger);
      }
    }
    this.entityChangedSector(this.playerEntity(slot), from, slot.sector);
  }

  /** Tells every player whose view of the entity changed with its sector, including players standing still. */
  private entityChangedSector(entity: EntityMessage, from: string, to: string): void {
    for (const [id, viewer] of this.players) {
      if (id === entity.id) continue;
      const before = this.sees(viewer, from);
      const after = this.sees(viewer, to);
      if (after && !before) viewer.outbox.sendEncoded({ tag: 'entity', payload: entity }, this.logger);
      else if (before && !after) viewer.outbox.sendEncoded({ tag: 'leave', payload: { entityId: entity.id, leftGame: false } }, this.logger);
    }
  }

  /** Re-broadcasts a chat line to the players who can see the speaker; the originating client renders its own bubble. */
  handleSay(message: ClientSayMessage, entityId: string): void {
    const slot = this.players.get(entityId);
    if (slot === undefined) return;
    this.broadcast({ tag: 'serverSay', payload: { entityId, text: message.text } }, slot.sector, entityId);
  }

  /**
   * Per-row equip with an implicit unequip of any other row holding the same hand; returns the
   * post-mutation rows. Equip markers are per-player UI, so the result is re-emitted to the
   * originating connection and never broadcast.
   */
  handleEquipToggle(slot: number, hand: Hand | undefined, entityId: string): InventoryRow[] | undefined {
    const player = this.players.get(entityId);
    if (player === undefined) return undefined;
    const rowIndex = player.inventory.findIndex((row) => row.slot === slot);
    if (rowIndex === -1) return undefined;
    player.inventory = player.inventory.map((row, index) => {
      if (index === rowIndex) return { ...row, equippedHand: hand };
      if (hand !== undefined && row.equippedHand === hand) return { ...row, equippedHand: undefined };
      return row;
    });
    return player.inventory;
  }

  /**
   * Flips the NPC's targeting once. A second bump while already targeting is a no-op, so the
   * dialog is not retargeted mid-script. A bump at anything but an NPC, or from outside the dialog
   * radius, is dropped, so it cannot force per-call writes through the step's reset path.
   */
  handleBump(targetId: string, entityId: string): void {
    const player = this.players.get(entityId);
    const npc = this.npcs.get(targetId);
    if (player === undefined || npc === undefined) return;
    if (npc.targetingEntity !== undefined) return;
    if (!this.isWithinDialogRadius(npc, player)) return;
    npc.targetingEntity = entityId;
  }

  private isWithinDialogRadius(npc: NPCRuntime, player: PlayerSlot): boolean {
    return distance(npc.position, player.character.position) <= SOMNIO_CONSTANTS.npcInteractionRadius;
  }

  /** One simulation step: NPC dialog, monster spawns, monster chase. */
  step(elapsedSeconds: number): TickDigest {
    const digest: TickDigest = { dialogUpserts: [], dialogResets: [] };
    this.runNPCs(digest);
    this.runMonsterSpawns();
    this.runMonsters(elapsedSeconds);
    return digest;
  }

  /** One batched `moves` frame per player for everything that moved in their view since the last flush. */
  flushMoves(): void {
    if (this.moved.size === 0) return;
    for (const [id, viewer] of this.players) {
      const moves = [...this.moved.values()].filter((entry) => entry.move.id !== id && this.sees(viewer, entry.sector)).map((entry) => entry.move);
      if (moves.length > 0) viewer.outbox.sendEncoded({ tag: 'moves', payload: { moves } }, this.logger);
    }
    this.moved.clear();
  }

  private runMonsterSpawns(): void {
    const now = this.now();
    for (const timer of this.spawnTimers) {
      if (timer.alive >= timer.definition.maxAlive || now < timer.spawnAt) continue;
      // The deadline moves only once a monster materializes; a fully blocked area keeps the
      // timer due and retries next step rather than dropping a monster onto geometry.
      if (!this.spawnMonster(timer)) continue;
      timer.alive += 1;
      timer.spawnAt = now + monsterKind(timer.definition.kind).respawnSeconds * 1000;
    }
  }

  private spawnMonster(timer: MonsterSpawnTimer): boolean {
    const kind = monsterKind(timer.definition.kind);
    const position = this.randomFreePoint(timer.sector, timer.definition, kind.radius);
    if (position === undefined) return false;
    const monster: MonsterRuntime = {
      id: `monster:${this.nextMonsterNumber}`,
      kind,
      sector: sectorAt(this.space, position)!.name,
      position,
      facing: headingFromCardinal('south'),
    };
    this.nextMonsterNumber += 1;
    this.monsters.set(monster.id, monster);
    this.broadcast({ tag: 'entity', payload: this.monsterEntity(monster) }, monster.sector);
    return true;
  }

  /** Centimetre-grid sampling inside the spawn's area, validated against the world and live entities, up to the retry cap. */
  private randomFreePoint(sector: Sector, area: MonsterSpawn, radius: number): Point | undefined {
    for (let attempt = 0; attempt < PLACEMENT_ATTEMPTS; attempt += 1) {
      const candidate = sectorPointInSpace(sector, {
        x: area.x + randomInRange(this.random, 0, Math.round(area.width * 100)) / 100,
        z: area.z + randomInRange(this.random, 0, Math.round(area.depth * 100)) / 100,
      });
      if (isClear(this.collision, candidate, radius) && !this.overlapsEntity(candidate, radius)) return candidate;
    }
    return undefined;
  }

  private runNPCs(digest: TickDigest): void {
    for (const npc of this.npcs.values()) {
      const action = this.resolveDialogAction(npc);
      switch (action.kind) {
        case 'holdCooldown':
          break;
        case 'resetTargeting':
          this.resetTargeting(npc, digest);
          break;
        case 'clearTargetingNoEmit':
          npc.targetingEntity = undefined;
          break;
        case 'emit':
          this.emitDialogStep(npc, action.targetName, digest);
          break;
      }
    }
  }

  private resolveDialogAction(npc: NPCRuntime): NPCDialogAction {
    if (npc.targetingEntity === undefined) return { kind: 'holdCooldown' };
    const target = this.players.get(npc.targetingEntity);
    if (target === undefined) return { kind: 'resetTargeting' };
    if (!this.isWithinDialogRadius(npc, target)) return { kind: 'resetTargeting' };
    if (this.now() < npc.readyAt) return { kind: 'holdCooldown' };
    if (npc.dialogSteps.length === 0) return { kind: 'clearTargetingNoEmit' };
    return { kind: 'emit', targetName: target.character.name };
  }

  /** Emits the current step, restarts the cooldown, and advances the cursor, wrapping (and clearing targeting) at the last line. */
  private emitDialogStep(npc: NPCRuntime, targetName: string, digest: TickDigest): void {
    const step = npc.dialogSteps[npc.scriptStepIndex]!;
    this.broadcast({ tag: 'serverSay', payload: { entityId: npc.id, text: dialogLine(step, targetName) } }, npc.sector);
    npc.readyAt = this.now() + SOMNIO_CONSTANTS.npcDialogCooldownSeconds * 1000;
    const key = { sectorName: npc.sector, npcId: npc.definition.id };
    const nextIndex = npc.scriptStepIndex + 1;
    if (nextIndex >= npc.dialogSteps.length) {
      npc.scriptStepIndex = 0;
      npc.targetingEntity = undefined;
      digest.dialogResets.push(key);
    } else {
      npc.scriptStepIndex = nextIndex;
      digest.dialogUpserts.push({ ...key, scriptStep: nextIndex + 1 });
    }
  }

  private resetTargeting(npc: NPCRuntime, digest: TickDigest): void {
    npc.targetingEntity = undefined;
    npc.scriptStepIndex = 0;
    digest.dialogResets.push({ sectorName: npc.sector, npcId: npc.definition.id });
  }

  /** Each monster orients toward and chases the nearest player inside its aggro radius; the others idle. */
  private runMonsters(elapsedSeconds: number): void {
    for (const monster of this.monsters.values()) {
      let closest: { position: Point; distance: number } | undefined;
      for (const slot of this.players.values()) {
        const away = distance(monster.position, slot.character.position);
        if (away > monster.kind.aggroRadius) continue;
        if (closest !== undefined && away >= closest.distance) continue;
        closest = { position: slot.character.position, distance: away };
      }
      if (closest === undefined || closest.distance === 0) continue;
      const dx = closest.position.x - monster.position.x;
      const dz = closest.position.z - monster.position.z;
      monster.facing = headingFromVector(dx, dz);
      const reach = monster.kind.metresPerSecond * elapsedSeconds;
      const proposed = { x: monster.position.x + (dx * reach) / closest.distance, z: monster.position.z + (dz * reach) / closest.distance };
      if (
        isLegalMove(this.collision, monster.position, proposed, monster.kind.radius, this.npcBodies) &&
        !this.overlapsEntity(proposed, monster.kind.radius, monster)
      ) {
        const previous = monster.sector;
        monster.position = proposed;
        monster.sector = sectorAt(this.space, proposed)!.name;
        if (monster.sector !== previous) this.entityChangedSector(this.monsterEntity(monster), previous, monster.sector);
      }
      this.moved.set(monster.id, {
        sector: monster.sector,
        move: { id: monster.id, x: monster.position.x, z: monster.position.z, facing: monster.facing, gait: DEFAULT_GAIT },
      });
    }
  }

  /** One snapshot per player, bumping `lastSeen` so the `last_seen` guard can order it against a racing disconnect snapshot. */
  snapshotForCheckpoint(): PlayerCheckpoint[] {
    const now = new Date();
    const result: PlayerCheckpoint[] = [];
    for (const slot of this.players.values()) {
      slot.character = { ...slot.character, lastSeen: now };
      result.push({ character: slot.character, inventory: slot.inventory });
    }
    return result;
  }

  snapshotForPlayer(entityId: string): PlayerCheckpoint | undefined {
    const slot = this.players.get(entityId);
    if (slot === undefined) return undefined;
    slot.character = { ...slot.character, lastSeen: new Date() };
    return { character: slot.character, inventory: slot.inventory };
  }

  /** Whether a body of `radius` at the point would overlap a player, an NPC, or a monster other than `excluding`. */
  private overlapsEntity(point: Point, radius: number, excluding?: MonsterRuntime): boolean {
    for (const slot of this.players.values()) {
      if (distance(point, slot.character.position) < radius + SOMNIO_CONSTANTS.playerRadius) return true;
    }
    if (this.npcBodies.some((npc) => distance(point, npc) < radius + npc.radius)) return true;
    for (const monster of this.monsters.values()) {
      if (monster !== excluding && distance(point, monster.position) < radius + monster.kind.radius) return true;
    }
    return false;
  }

  private sees(viewer: PlayerSlot, sector: string): boolean {
    return this.interest.get(viewer.sector)!.has(sector);
  }

  /** Encode once and fan out to every player who can see `sector`, but for `excluding`. */
  private broadcast(message: SomnioMessage, sector: string, excluding?: string): void {
    const frame = encodeOrWarn(message, this.logger);
    if (frame === undefined) return;
    for (const [id, viewer] of this.players) {
      if (id !== excluding && this.sees(viewer, sector)) viewer.outbox.send(frame);
    }
  }

  private sectorMessage(name: string): SomnioMessage {
    return { tag: 'sector', payload: { sector: sectorView(this.space.sectors.find((sector) => sector.name === name)!) } };
  }

  /** Every entity but the player `excluding`, with the sector it stands in. */
  private entities(excluding?: string): { sector: string; entity: EntityMessage }[] {
    const result: { sector: string; entity: EntityMessage }[] = [];
    for (const [id, slot] of this.players) {
      if (id !== excluding) result.push({ sector: slot.sector, entity: this.playerEntity(slot) });
    }
    for (const npc of this.npcs.values()) result.push({ sector: npc.sector, entity: this.npcEntity(npc) });
    for (const monster of this.monsters.values()) result.push({ sector: monster.sector, entity: this.monsterEntity(monster) });
    return result;
  }

  private playerEntity(slot: PlayerSlot): EntityMessage {
    return {
      id: slot.character.id,
      kind: 'player',
      characterModelId: this.playerModel,
      name: slot.character.name,
      radius: SOMNIO_CONSTANTS.playerRadius,
      x: slot.character.position.x,
      z: slot.character.position.z,
      facing: slot.character.facing,
      gait: slot.gait,
    };
  }

  private npcEntity(npc: NPCRuntime): EntityMessage {
    return {
      id: npc.id,
      kind: 'npc',
      characterModelId: npc.definition.characterModelId,
      name: npc.definition.name,
      radius: SOMNIO_CONSTANTS.npcRadius,
      x: npc.position.x,
      z: npc.position.z,
      facing: npc.definition.facing,
      gait: DEFAULT_GAIT,
    };
  }

  private monsterEntity(monster: MonsterRuntime): EntityMessage {
    return {
      id: monster.id,
      kind: 'monster',
      characterModelId: monster.kind.characterModelId,
      name: monster.kind.name,
      radius: monster.kind.radius,
      x: monster.position.x,
      z: monster.position.z,
      facing: monster.facing,
      gait: DEFAULT_GAIT,
    };
  }
}
