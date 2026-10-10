import { encodeSomnioMessage } from '@somnio/protocol';
import type {
  ClientSayMessage,
  Condition,
  Energy,
  EntityMessage,
  EntityMove,
  Gait,
  Hand,
  InventoryMessage,
  LucidityMessage,
  MoveMessage,
  NPCService,
  RaisingState,
  SomnioMessage,
  SpeechKind,
} from '@somnio/protocol';
import {
  COMBAT,
  FIRST_TEACHING,
  PRACTICE,
  SOMNIO_CONSTANTS,
  SPEECH,
  balancePace,
  balancePerSecond,
  buildSpaceCollision,
  canStand,
  conditionOf,
  crumble,
  dialogLine,
  dialogSteps,
  distance,
  gaitMetresPerSecond,
  heading,
  headingFromCardinal,
  headingFromVector,
  isClear,
  isLegalMove,
  isTeachingId,
  itemInHand,
  maxPools,
  mendAmount,
  monsterKind,
  neighbourSectors,
  npcBodies,
  practiceNeeded,
  rankOf,
  reaches,
  resolveDoor,
  roleOfService,
  sectorAt,
  sectorPointInSpace,
  sectorView,
  speechClarity,
  strikeChance,
  swingAllowed,
  taskGoal,
  taskSpec,
  teaching,
  teachingStanding,
  windedAfter,
  windedOnJoin,
  withRank,
  withinSpeakingDistance,
} from '@somnio/core';
import type {
  Body,
  Character,
  Heading,
  InventoryRow,
  ItemId,
  Lucidity,
  MonsterKind,
  MonsterSpawn,
  NPCDialogState,
  Point,
  Sector,
  SectorNPC,
  Space,
  SpaceCollision,
  TaskSpec,
} from '@somnio/core';
import { encodeOrWarn } from '../connection/encodeFrame.ts';
import type { ConnectionOutbox } from '../connection/outbox.ts';
import type { Logger } from '../logging.ts';
import { counterpartOf } from '../sectors/sectorCache.ts';
import type { LoadedWorld } from '../sectors/sectorCache.ts';
import { randomInRange, randomUnit, systemRandom } from './random.ts';
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
  /**
   * What recovery and the running drain have not yet moved into `character.energy`, which holds
   * whole numbers only. Each is under one unit, and none is saved.
   */
  carry: { health: number; balance: number; spirit: number };
  /** Kept with `windedAfter` over every balance the dreamer is sent, as their client keeps it. */
  winded: boolean;
  /** When a move of non-zero length was last accepted, and at what gait. */
  lastMoveAt: number;
  lastGait: Gait;
  swingReadyAt: number;
  mendReadyAt: number;
  /** Nightmares leave the dreamer alone until this moment. */
  graceUntil: number;
  condition: Condition;
  /** The raise this fallen dreamer is being given. */
  raise: Raise | undefined;
  /** The dreamer a Heiler chose to tend: mended, or raised, whenever the Mondstein reaches them. */
  tending: string | undefined;
}

interface Raise {
  healerId: string;
  elapsed: number;
  /** The spirit the healer has paid toward the cost so far. */
  charged: number;
}

interface NPCRuntime {
  id: string;
  sector: string;
  definition: SectorNPC;
  position: Point;
  /** The dreamer who asked it to go on, while it says the lines after its greeting. */
  targetingEntity: string | undefined;
  /** The parsed script, cached so a step does not parse it again: the greeting, then what it says when asked. */
  dialogSteps: string[];
  /** No line after the greeting is spoken before this moment. */
  readyAt: number;
  /** No greeting is spoken before this moment. A dreamer who asks right after being greeted is answered at once. */
  greetReadyAt: number;
  /** 0-based cursor into `dialogSteps`. Persisted as 1-based; translated at the seam. */
  scriptStepIndex: number;
  /** The dreamers within speaking distance it has taken note of, so each is greeted once per approach. */
  near: Set<string>;
  /** When it last greeted each dreamer in the space. */
  greetedAt: Map<string, number>;
}

interface MonsterRuntime {
  id: string;
  kind: MonsterKind;
  sector: string;
  position: Point;
  /** Turned toward the chase target while chasing. An idle monster keeps the facing it last had, south until its first chase. */
  facing: Heading;
  health: number;
  condition: Condition;
  strikeReadyAt: number;
  /** The spawn keeping it alive, which its end frees a slot of. */
  timer: MonsterSpawnTimer;
  /** Set once it is driven off: it lingers until this moment and does nothing. */
  fadingUntil: number | undefined;
}

/** A live door of the space whose counterpart lies in another space: a yell near it is heard on the far side. */
interface Doorway {
  /** The door's own opening, in this space. */
  near: Point;
  spaceId: string;
  /** The counterpart's opening, in its space, where the voice comes out. */
  far: Point;
}

interface Voice {
  entityId: string;
  name: string;
  kind: SpeechKind;
  text: string;
}

/**
 * A line as said once. Every listener's crumble of it draws on the same `rolls`, each drawn when the
 * first listener needs it. So one who hears it less clearly misses every word a clearer one missed,
 * and listeners who pool what they heard learn no more than the clearest of them, except words a
 * cut to the say cap took from that one's end.
 */
interface Utterance {
  voice: Voice;
  rolls: number[];
}

/** Per-`MonsterSpawn` cadence: while fewer than `maxAlive` of its monsters live, it spawns one at `spawnAt`. */
interface MonsterSpawnTimer {
  sector: Sector;
  definition: MonsterSpawn;
  alive: number;
  spawnAt: number;
}

/** A yell's way into another space, through one door: it comes out at `source` already `baseMetres` along. */
export interface DoorVoice {
  spaceId: string;
  source: Point;
  baseMetres: number;
}

/** A yell spoken near doors, for the router to carry into the spaces beyond them. */
export interface YellThroughDoors {
  utterance: Utterance;
  voices: DoorVoice[];
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
/**
 * How long after an accepted move a dreamer still counts as moving. Reports come ten times a
 * second, so a walking dreamer never falls outside it, and one who stopped does a quarter of a
 * second later.
 */
const MOVING_WINDOW_MS = 250;
/**
 * How far ahead of the swing rhythm a swing may arrive. A client swinging on the rhythm sends at a
 * steady pace, but its frames do not arrive at one. A swing let in early does not bring the next
 * one forward, so no dreamer swings more often than the rhythm for it.
 */
const SWING_ARRIVAL_SLACK_MS = 150;

export interface SpaceActorOptions {
  logger: Logger;
  /** The persisted 1-based dialog cursors of the space's sectors. */
  initialDialogStates?: readonly NPCDialogState[];
  random?: RandomSource;
  /** Picks the words a listener misses; separate from `random`, so speech never shifts the rolls of combat and placement. */
  speechRandom?: RandomSource;
  /** Monotonic milliseconds, for the movement allowance and the dialog and spawn deadlines. */
  now?: () => number;
}

type NPCDialogAction = { kind: 'holdCooldown' } | { kind: 'resetTargeting' } | { kind: 'emit'; targetName: string };

function inventoryMessage(rows: readonly InventoryRow[]): InventoryMessage {
  return {
    rows: rows.map(({ slot, itemId, quantity, equippedHand }) => ({ slot, itemId, quantity, ...(equippedHand === undefined ? {} : { equippedHand }) })),
  };
}

function lucidityMessage({ role, ranks, study, task }: Lucidity): LucidityMessage {
  return {
    ...(role === undefined ? {} : { role }),
    ranks: ranks.map(({ teachingId, rank, practice }) => ({ teachingId, rank, practice })),
    ...(study === undefined ? {} : { study }),
    ...(task === undefined
      ? {}
      : { task: { role: task.role, ...(task.teachingId === undefined ? {} : { teachingId: task.teachingId }), progress: task.progress } }),
  };
}

function isFallen(slot: PlayerSlot): boolean {
  return slot.condition === 'fallen';
}

/**
 * One space's runtime: its player set, NPCs and monsters, and the broadcast stream that funnels
 * every peer-visible mutation through outboxes. A player is sent their own sector and its
 * neighbours, and the entities standing in them. Speech alone ignores sectors: each listener hears
 * a line by their distance from it. Every method is synchronous, so Node's
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
  private readonly doorways: Doorway[];
  private readonly random: RandomSource;
  private readonly speechRandom: RandomSource;
  private readonly now: () => number;
  private nextMonsterNumber = 1;
  private readonly logger: Logger;

  constructor(world: LoadedWorld, spaceId: string, options: SpaceActorOptions) {
    this.space = world.spaces.get(spaceId)!;
    this.collision = buildSpaceCollision(this.space, world.registry);
    this.playerModel = world.registry.playerModel;
    this.logger = options.logger;
    this.random = options.random ?? systemRandom;
    this.speechRandom = options.speechRandom ?? systemRandom;
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
          near: new Set(),
          greetedAt: new Map(),
          greetReadyAt: 0,
          dialogSteps: steps,
          readyAt: 0,
          scriptStepIndex: this.resolveSeedStepIndex(persisted?.scriptStep, steps.length, id),
        });
      }
    }
    this.npcBodies = npcBodies(this.space);
    this.doorways = doorwaysOut(world, this.space);
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
   *
   * The pools' maxima are what the character's ranks give, whatever the row held.
   */
  attach(character: Character, inventory: InventoryRow[], outbox: ConnectionOutbox, worldSeconds: number): void {
    const sector = sectorAt(this.space, character.position);
    if (sector === undefined) throw new Error(`no sector of ${this.space.id} holds (${character.position.x}, ${character.position.z})`);
    const maxima = maxPools(character.lucidity.ranks);
    const energy: Energy = {
      healthCurrent: Math.min(character.energy.healthCurrent, maxima.healthMax),
      balanceCurrent: Math.min(character.energy.balanceCurrent, maxima.balanceMax),
      spiritCurrent: Math.min(character.energy.spiritCurrent, maxima.spiritMax),
      ...maxima,
    };
    const slot: PlayerSlot = {
      character: { ...character, energy },
      inventory,
      outbox,
      gait: DEFAULT_GAIT,
      sector: sector.name,
      allowance: ALLOWANCE_CAP_METRES,
      allowanceAt: this.now(),
      rejectionLoggedAt: undefined,
      suppressedRejections: 0,
      carry: { health: 0, balance: 0, spirit: 0 },
      winded: windedOnJoin(energy.balanceCurrent),
      lastMoveAt: Number.NEGATIVE_INFINITY,
      lastGait: DEFAULT_GAIT,
      swingReadyAt: 0,
      mendReadyAt: 0,
      graceUntil: 0,
      condition: conditionOf(energy.healthCurrent, energy.healthMax),
      raise: undefined,
      tending: undefined,
    };
    const interest = this.interest.get(sector.name)!;
    const messages: SomnioMessage[] = [
      { tag: 'enterSpace', payload: { spaceId: this.space.id, selfId: character.id, worldSeconds } },
      ...[...interest].map((name) => this.sectorMessage(name)),
      { tag: 'entity', payload: this.playerEntity(slot) },
      { tag: 'inventory', payload: inventoryMessage(inventory) },
      { tag: 'energy', payload: energy },
      { tag: 'lucidity', payload: lucidityMessage(character.lucidity) },
    ];
    for (const other of this.entities()) {
      if (interest.has(other.sector)) messages.push({ tag: 'entity', payload: other.entity });
    }
    const frames = messages.map((message) => encodeSomnioMessage(message));
    for (const frame of frames) outbox.send(frame);

    this.players.set(character.id, slot);
    this.broadcast({ tag: 'entity', payload: this.playerEntity(slot) }, slot.sector, character.id);
  }

  /** `leftGame` is `true` for a disconnect and `false` for a transfer: a door, or waking. */
  detach(entityId: string, leftGame: boolean): void {
    const slot = this.players.get(entityId);
    if (slot === undefined) return;
    this.players.delete(entityId);
    this.moved.delete(entityId);
    for (const npc of this.npcs.values()) npc.greetedAt.delete(entityId);
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
   *
   * Running drains balance by the distance run. A winded dreamer's allowance is not shortened:
   * their client holds the slow gait, and running at empty buys nothing but staying empty, so a
   * late `energy` frame never gets an honest player corrected. A fallen dreamer does not move.
   */
  handleMove(message: MoveMessage, entityId: string): void {
    const slot = this.players.get(entityId);
    if (slot === undefined) return;
    if (isFallen(slot)) {
      this.snapBack(slot);
      return;
    }
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
    if (slot.sector !== previous) {
      this.playerChangedSector(slot, previous);
      this.advanceTask(
        slot,
        (spec) => spec.kind === 'reach' && spec.sector === slot.sector,
        (progress) => progress + 1,
      );
    }
    // A turn on the spot is reported as a move too, and must not count as moving.
    if (length === 0) return;
    slot.lastMoveAt = now;
    slot.lastGait = message.gait;
    if (message.gait === 'run') this.drainBalance(slot, length * (COMBAT.runDrainPerSecond / gaitMetresPerSecond('run')));
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

  /**
   * Says a line to everyone in the space within its reach, each hearing it as their distance from
   * the speaker allows; the speaker's own client renders its own bubble. A fallen dreamer speaks
   * too, which is how they call for help. A yell also goes to each door near enough that it is still
   * heard beyond it, and what comes back is for the router to carry through them.
   */
  handleSay(message: ClientSayMessage, entityId: string): YellThroughDoors | undefined {
    const slot = this.players.get(entityId);
    if (slot === undefined) return undefined;
    const { name, position } = slot.character;
    const utterance: Utterance = { voice: { entityId, name, kind: message.kind, text: message.text }, rolls: [] };
    this.speak(utterance, position, entityId);
    if (message.kind !== 'yell') return undefined;
    const voices = this.doorways.flatMap((doorway) => {
      const baseMetres = distance(position, doorway.near) + SPEECH.doorMuffleMetres;
      return baseMetres < SPEECH.yell.reachMetres ? [{ spaceId: doorway.spaceId, source: doorway.far, baseMetres }] : [];
    });
    return voices.length === 0 ? undefined : { utterance, voices };
  }

  /**
   * A yell from another space, coming out of this one's doors. Each listener hears it by the
   * shortest way, from that way's doorway. It is not relayed again.
   */
  hearThroughDoors(utterance: Utterance, voices: readonly DoorVoice[]): void {
    for (const listener of this.players.values()) {
      const position = listener.character.position;
      const ways = voices.map((door) => ({ source: door.source, metres: door.baseMetres + distance(position, door.source) }));
      const shortest = ways.reduce((best, way) => (way.metres < best.metres ? way : best));
      this.sayTo(listener, utterance, shortest.source, shortest.metres);
    }
  }

  /** Says a line from `source` to every player but `excluding`, each at their distance. Sector interest plays no part. */
  private speak(utterance: Utterance, source: Point, excluding?: string): void {
    for (const [id, listener] of this.players) {
      if (id !== excluding) this.sayTo(listener, utterance, source, distance(listener.character.position, source));
    }
  }

  /** The line as one listener `metres` along its way hears it; nothing past its reach. */
  private sayTo(listener: PlayerSlot, { voice, rolls }: Utterance, source: Point, metres: number): void {
    const clarity = speechClarity(voice.kind, metres);
    if (clarity === undefined) return;
    let next = 0;
    const text = crumble(voice.text, clarity, () => {
      if (next === rolls.length) rolls.push(randomUnit(this.speechRandom));
      return rolls[next++]!;
    });
    listener.outbox.sendEncoded(
      {
        tag: 'serverSay',
        payload: { ...voice, text, clarity, x: source.x, z: source.z },
      },
      this.logger,
    );
  }

  /**
   * Per-row equip with an implicit unequip of any other row holding the same hand. No one else is
   * shown what a dreamer holds, so the rows go back to the player alone and are never broadcast.
   */
  handleEquipToggle(slot: number, hand: Hand | undefined, entityId: string): void {
    const player = this.players.get(entityId);
    if (player === undefined) return;
    const rowIndex = player.inventory.findIndex((row) => row.slot === slot);
    if (rowIndex === -1) return;
    player.inventory = player.inventory.map((row, index) => {
      if (index === rowIndex) return { ...row, equippedHand: hand };
      if (hand !== undefined && row.equippedHand === hand) return { ...row, equippedHand: undefined };
      return row;
    });
    this.sendInventory(player);
  }

  /**
   * Asking an NPC to go on: it says the lines after its greeting to the dreamer who asked. Its
   * targeting flips once. A second `talk` while it is already targeting is a no-op, so it is not
   * retargeted mid-script. One from outside speaking distance or from a fallen dreamer is
   * dropped, so it cannot force per-call writes through the step's reset path. An NPC with
   * nothing beyond its greeting has nothing to go on with.
   */
  handleTalk(npcId: string, entityId: string): void {
    const player = this.players.get(entityId);
    const npc = this.npcs.get(npcId);
    if (player === undefined || npc === undefined || isFallen(player) || npc.dialogSteps.length < 2) return;
    if (npc.targetingEntity === undefined && this.inSpeakingDistance(npc, player)) npc.targetingEntity = entityId;
  }

  /** A standing dreamer's swing, at the nightmare their client picked or at the air. */
  handleSwing(targetId: string | undefined, entityId: string): void {
    const player = this.players.get(entityId);
    if (player === undefined || isFallen(player)) return;
    this.swing(player, targetId === undefined ? undefined : this.monsters.get(targetId));
  }

  /**
   * Chooses the dreamer a standing dreamer tends, or no one. Anyone may choose; it does something
   * only for a Heiler holding the Mondstein. Nothing tending does harms another dreamer.
   */
  handleTend(targetId: string | undefined, entityId: string): void {
    const player = this.players.get(entityId);
    if (player === undefined || isFallen(player)) return;
    player.tending = targetId !== undefined && targetId !== entityId && this.players.has(targetId) ? targetId : undefined;
  }

  /** Using the Mondstein from the inventory while it is in hand mends its holder. */
  handleUseItem(inventorySlot: number, entityId: string): void {
    const player = this.players.get(entityId);
    if (player === undefined) return;
    const row = player.inventory.find((candidate) => candidate.slot === inventorySlot);
    if (row?.itemId !== ('mondstein' satisfies ItemId) || row.equippedHand !== 'right') return;
    if (this.canMend(player)) this.mend(player, player);
  }

  private inSpeakingDistance(npc: NPCRuntime, player: PlayerSlot): boolean {
    return withinSpeakingDistance(player.character.position, npc.position);
  }

  step(elapsedSeconds: number): TickDigest {
    const digest: TickDigest = { dialogUpserts: [], dialogResets: [] };
    this.runNPCs(digest);
    this.runMonsterSpawns();
    this.runPlayers(elapsedSeconds);
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
      health: kind.health,
      condition: 'hale',
      strikeReadyAt: 0,
      timer,
      fadingUntil: undefined,
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
        case 'emit':
          this.emitDialogStep(npc, action.targetName, digest);
          break;
      }
      this.greetArrival(npc);
    }
  }

  /**
   * An NPC greets a dreamer who has come within speaking distance with the first line of its
   * script: once per approach, and not again within the greeting pause, so one who hovers at the
   * edge is not greeted over and over. While it is saying something else the arrivals wait, and
   * it greets one of them per line.
   */
  private greetArrival(npc: NPCRuntime): void {
    const greeting = npc.dialogSteps[0];
    if (greeting === undefined) return;
    for (const id of npc.near) {
      const slot = this.players.get(id);
      if (slot === undefined || !this.inSpeakingDistance(npc, slot)) npc.near.delete(id);
    }
    const now = this.now();
    if (npc.targetingEntity !== undefined || now < npc.readyAt || now < npc.greetReadyAt) return;
    for (const slot of this.players.values()) {
      const id = slot.character.id;
      if (npc.near.has(id) || !this.inSpeakingDistance(npc, slot)) continue;
      npc.near.add(id);
      const last = npc.greetedAt.get(id);
      if (last !== undefined && now - last < SOMNIO_CONSTANTS.npcGreetingPauseSeconds * 1000) continue;
      npc.greetedAt.set(id, now);
      this.speakAs(npc, dialogLine(greeting, slot.character.name));
      npc.greetReadyAt = now + SOMNIO_CONSTANTS.npcDialogCooldownSeconds * 1000;
      return;
    }
  }

  private resolveDialogAction(npc: NPCRuntime): NPCDialogAction {
    if (npc.targetingEntity === undefined) return { kind: 'holdCooldown' };
    const target = this.players.get(npc.targetingEntity);
    if (target === undefined) return { kind: 'resetTargeting' };
    if (!this.inSpeakingDistance(npc, target)) return { kind: 'resetTargeting' };
    if (this.now() < npc.readyAt) return { kind: 'holdCooldown' };
    return { kind: 'emit', targetName: target.character.name };
  }

  /**
   * Emits the current step, restarts the cooldown, and advances the cursor, wrapping (and clearing
   * targeting) at the last line. The first step is the greeting, so the cursor starts past it.
   */
  private emitDialogStep(npc: NPCRuntime, targetName: string, digest: TickDigest): void {
    const index = Math.max(npc.scriptStepIndex, 1);
    const step = npc.dialogSteps[index]!;
    this.speakAs(npc, dialogLine(step, targetName));
    npc.readyAt = this.now() + SOMNIO_CONSTANTS.npcDialogCooldownSeconds * 1000;
    const key = { sectorName: npc.sector, npcId: npc.definition.id };
    const nextIndex = index + 1;
    if (nextIndex >= npc.dialogSteps.length) {
      npc.scriptStepIndex = 0;
      npc.targetingEntity = undefined;
      digest.dialogResets.push(key);
    } else {
      npc.scriptStepIndex = nextIndex;
      digest.dialogUpserts.push({ ...key, scriptStep: nextIndex + 1 });
    }
  }

  /** An NPC talks like a dreamer: whoever it addresses stands within speaking distance and hears it whole, and bystanders by their distance. */
  private speakAs(npc: NPCRuntime, text: string): void {
    this.speak({ voice: { entityId: npc.id, name: npc.definition.name, kind: 'say', text }, rolls: [] }, npc.position);
  }

  private resetTargeting(npc: NPCRuntime, digest: TickDigest): void {
    npc.targetingEntity = undefined;
    npc.scriptStepIndex = 0;
    digest.dialogResets.push({ sectorName: npc.sector, npcId: npc.definition.id });
  }

  /**
   * Each monster orients toward and chases the nearest dreamer inside its aggro radius who stands
   * and is past the grace after a raise, and strikes on its own rhythm once it has reached them;
   * the others idle. One driven off does nothing more, and is gone once its fade is over.
   */
  private runMonsters(elapsedSeconds: number): void {
    const now = this.now();
    for (const monster of this.monsters.values()) {
      if (monster.fadingUntil !== undefined) {
        if (now < monster.fadingUntil) continue;
        this.monsters.delete(monster.id);
        this.broadcast({ tag: 'leave', payload: { entityId: monster.id, leftGame: false } }, monster.sector);
        continue;
      }
      let target: PlayerSlot | undefined;
      let away = Number.POSITIVE_INFINITY;
      for (const slot of this.players.values()) {
        if (isFallen(slot) || now < slot.graceUntil) continue;
        const candidate = distance(monster.position, slot.character.position);
        if (candidate > monster.kind.aggroRadius || candidate >= away) continue;
        target = slot;
        away = candidate;
      }
      if (target === undefined) continue;
      if (away > 0) this.chase(monster, target.character.position, away, elapsedSeconds);
      if (now >= monster.strikeReadyAt && reaches(target.character.position, { ...monster.position, radius: monster.kind.radius }))
        this.strike(monster, target);
    }
  }

  private chase(monster: MonsterRuntime, toward: Point, away: number, elapsedSeconds: number): void {
    const dx = toward.x - monster.position.x;
    const dz = toward.z - monster.position.z;
    monster.facing = headingFromVector(dx, dz);
    const reach = monster.kind.metresPerSecond * elapsedSeconds;
    const proposed = { x: monster.position.x + (dx * reach) / away, z: monster.position.z + (dz * reach) / away };
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

  /**
   * A nightmare's strike at a dreamer it has reached. A hit takes health and a little balance,
   * and one that takes the last of a dreamer's health is the only way a dreamer falls.
   */
  private strike(monster: MonsterRuntime, target: PlayerSlot): void {
    monster.strikeReadyAt = this.now() + monster.kind.strikeSeconds * 1000;
    const energy = target.character.energy;
    const hit = randomUnit(this.random) < strikeChance(monster.kind, energy.balanceCurrent, energy.balanceMax, target.character.lucidity.ranks);
    this.broadcast({ tag: 'blow', payload: { attackerId: monster.id, targetId: target.character.id, hit } }, target.sector);
    if (!hit) return;
    this.setEnergy(target, {
      ...energy,
      healthCurrent: Math.max(0, energy.healthCurrent - monster.kind.damage),
      balanceCurrent: Math.max(0, energy.balanceCurrent - monster.kind.balanceDamage),
    });
    if (!isFallen(target)) return;
    // Falling lets go of the dreamer tended, as their client does: nothing they send while fallen could.
    target.tending = undefined;
    this.advanceTask(
      target,
      (spec) => spec.kind === 'driveOff' && spec.withoutFalling === true,
      () => 0,
    );
    // Their client stops reporting at once and may have predicted a little past the last accepted position.
    this.snapBack(target);
  }

  /**
   * A dreamer's swing, at the swing rhythm, for the balance what they hold in hand costs, whether
   * or not it meets anything. It meets the nightmare named when that one is in reach and still
   * standing, and the air otherwise. With less balance than the cost, with something in hand that
   * does not swing, or while they hold a task that forbids striking, no swing happens.
   */
  private swing(player: PlayerSlot, monster: MonsterRuntime | undefined): void {
    const now = this.now();
    if (now < player.swingReadyAt - SWING_ARRIVAL_SLACK_MS) return;
    const { task, ranks } = player.character.lucidity;
    const energy = player.character.energy;
    const swing = swingAllowed(task === undefined ? undefined : taskSpec(task), itemInHand(player.inventory), ranks, energy.balanceCurrent);
    if (swing === undefined) return;
    player.swingReadyAt = Math.max(now, player.swingReadyAt) + swing.seconds * 1000;
    this.setEnergy(player, { ...energy, balanceCurrent: energy.balanceCurrent - swing.balanceCost });
    const reached =
      monster !== undefined && monster.fadingUntil === undefined && reaches(player.character.position, { ...monster.position, radius: monster.kind.radius });
    const met = reached ? monster : undefined;
    const hit = met !== undefined && randomUnit(this.random) < COMBAT.hitChance;
    this.broadcast({ tag: 'blow', payload: { attackerId: player.character.id, ...(met === undefined ? {} : { targetId: met.id }), hit } }, player.sector);
    if (met === undefined || !hit) return;
    met.health = Math.max(0, met.health - swing.damage);
    this.setCondition(met);
    if (met.health === 0) this.driveOff(met);
  }

  /**
   * The one place a nightmare ends. It fades where it stands, its spawn has a slot to refill after
   * the kind's respawn time, and the standing dreamers within the share radius split its bounty
   * and each earn the practice in full.
   */
  private driveOff(monster: MonsterRuntime): void {
    const now = this.now();
    monster.fadingUntil = now + COMBAT.fadeSeconds * 1000;
    monster.timer.alive -= 1;
    monster.timer.spawnAt = now + monster.kind.respawnSeconds * 1000;
    const near = [...this.players.values()].filter((slot) => !isFallen(slot) && distance(slot.character.position, monster.position) <= COMBAT.shareRadius);
    const share = Math.floor(monster.kind.bounty / near.length);
    for (const slot of near) {
      if (share > 0) this.giveItem(slot, 'purse', share);
      this.addPractice(slot, PRACTICE.nightmare);
      this.advanceTask(
        slot,
        (spec) => spec.kind === 'driveOff',
        (progress) => progress + 1,
      );
    }
  }

  /** A Heiler's Mondstein reaching another dreamer: a standing one is mended, a fallen one begins to be raised. */
  private touch(healer: PlayerSlot, target: PlayerSlot): void {
    if (!this.canMend(healer) || !this.touches(healer, target)) return;
    if (!isFallen(target)) {
      this.mend(healer, target);
      return;
    }
    // The whole cost has to be there at the start, so a raise once begun can be finished.
    if (target.raise !== undefined || rankOf(healer.character.lucidity.ranks, 'drawing-back') === 0) return;
    if (healer.character.energy.spiritCurrent < COMBAT.raise.spiritCost) return;
    target.raise = { healerId: healer.character.id, elapsed: 0, charged: 0 };
    this.broadcastRaising(target, healer.character.id, 'begun');
  }

  /** Whether the dreamer is a standing Heiler holding the Mondstein. */
  private wieldsMondstein(healer: PlayerSlot): boolean {
    return !isFallen(healer) && healer.character.lucidity.role === 'heiler' && itemInHand(healer.inventory) === ('mondstein' satisfies ItemId);
  }

  /** Whether the dreamer can use the Mondstein right now: they wield it, and the last touch is past. */
  private canMend(healer: PlayerSlot): boolean {
    return this.wieldsMondstein(healer) && this.now() >= healer.mendReadyAt;
  }

  /** Whether a Mondstein reaches from one dreamer to the other. */
  private touches(healer: PlayerSlot, target: PlayerSlot): boolean {
    return reaches(healer.character.position, { ...target.character.position, radius: SOMNIO_CONSTANTS.playerRadius });
  }

  /** Restores part of a standing dreamer's health for the healer's spirit. Mending oneself earns half the practice and no task progress. */
  private mend(healer: PlayerSlot, target: PlayerSlot): void {
    const amount = Math.min(mendAmount(healer.character.lucidity.ranks), target.character.energy.healthMax - target.character.energy.healthCurrent);
    if (amount <= 0 || healer.character.energy.spiritCurrent < COMBAT.mend.spiritCost) return;
    healer.mendReadyAt = this.now() + COMBAT.mend.seconds * 1000;
    this.setEnergy(healer, { ...healer.character.energy, spiritCurrent: healer.character.energy.spiritCurrent - COMBAT.mend.spiritCost });
    this.setEnergy(target, { ...target.character.energy, healthCurrent: target.character.energy.healthCurrent + amount });
    if (healer === target) {
      this.addPractice(healer, amount * PRACTICE.perHealthMended * PRACTICE.selfMendShare);
      return;
    }
    this.addPractice(healer, amount * PRACTICE.perHealthMended);
    this.advanceTask(
      healer,
      (spec) => spec.kind === 'mend',
      (progress) => progress + amount,
    );
  }

  /** Recovers each standing dreamer's pools, lets each reach the dreamer they tend, then advances the raises under way. */
  private runPlayers(elapsedSeconds: number): void {
    for (const slot of this.players.values()) {
      if (!isFallen(slot)) this.recover(slot, elapsedSeconds);
    }
    for (const slot of this.players.values()) {
      if (slot.tending === undefined) continue;
      const tended = this.players.get(slot.tending);
      if (tended === undefined) slot.tending = undefined;
      else this.touch(slot, tended);
    }
    for (const target of this.players.values()) {
      if (target.raise !== undefined) this.advanceRaise(target, target.raise, elapsedSeconds);
    }
  }

  private recover(slot: PlayerSlot, elapsedSeconds: number): void {
    const energy = slot.character.energy;
    const motion = this.now() - slot.lastMoveAt < MOVING_WINDOW_MS ? slot.lastGait : 'standing';
    const balance = balancePerSecond(slot.character.lucidity.ranks) * balancePace(motion, slot.winded);
    const recovered: Energy = {
      ...energy,
      healthCurrent: accrue(slot.carry, 'health', COMBAT.healthPerSecond * elapsedSeconds, energy.healthCurrent, energy.healthMax),
      balanceCurrent: accrue(slot.carry, 'balance', balance * elapsedSeconds, energy.balanceCurrent, energy.balanceMax),
      spiritCurrent: accrue(slot.carry, 'spirit', COMBAT.spiritPerSecond * elapsedSeconds, energy.spiritCurrent, energy.spiritMax),
    };
    if (
      recovered.healthCurrent !== energy.healthCurrent ||
      recovered.balanceCurrent !== energy.balanceCurrent ||
      recovered.spiritCurrent !== energy.spiritCurrent
    ) {
      this.setEnergy(slot, recovered);
    }
  }

  private drainBalance(slot: PlayerSlot, amount: number): void {
    slot.carry.balance -= amount;
    const whole = Math.floor(-slot.carry.balance);
    if (whole < 1) return;
    slot.carry.balance += whole;
    const energy = slot.character.energy;
    if (energy.balanceCurrent > 0) this.setEnergy(slot, { ...energy, balanceCurrent: Math.max(0, energy.balanceCurrent - whole) });
  }

  /**
   * The one place a raise breaks or completes. One whose fallen dreamer leaves the space goes
   * with their slot, unannounced. It holds only while the healer stays attached, tending the
   * dreamer, standing, holding the Mondstein, in reach, and with spirit left; otherwise it breaks
   * off and has to start over.
   * The cost is charged in whole units as the time passes, so a completed raise has cost exactly
   * the spirit cost. The raised dreamer is left alone by nightmares for the grace time. That is
   * slot state, so it ends when they leave the space, and nightmares do not follow through a door.
   */
  private advanceRaise(target: PlayerSlot, raise: Raise, elapsedSeconds: number): void {
    const healer = this.players.get(raise.healerId);
    if (
      healer === undefined ||
      healer.tending !== target.character.id ||
      !this.wieldsMondstein(healer) ||
      healer.character.energy.spiritCurrent <= 0 ||
      !this.touches(healer, target)
    ) {
      target.raise = undefined;
      this.broadcastRaising(target, raise.healerId, 'broken');
      return;
    }
    raise.elapsed += elapsedSeconds;
    const due = Math.floor(COMBAT.raise.spiritCost * Math.min(1, raise.elapsed / COMBAT.raise.seconds));
    if (due > raise.charged) {
      const spirit = healer.character.energy.spiritCurrent;
      this.setEnergy(healer, { ...healer.character.energy, spiritCurrent: Math.max(0, spirit - (due - raise.charged)) });
      raise.charged = due;
    }
    if (raise.elapsed < COMBAT.raise.seconds) return;
    target.raise = undefined;
    target.graceUntil = this.now() + COMBAT.raise.graceSeconds * 1000;
    const energy = target.character.energy;
    this.setEnergy(target, { ...energy, healthCurrent: Math.ceil(energy.healthMax * COMBAT.raise.healthFraction) });
    this.broadcastRaising(target, raise.healerId, 'done');
    this.addPractice(healer, PRACTICE.raise);
  }

  private broadcastRaising(target: PlayerSlot, healerId: string, state: RaisingState): void {
    const seconds = state === 'begun' ? COMBAT.raise.seconds : 0;
    this.broadcast({ tag: 'raising', payload: { healerId, targetId: target.character.id, state, seconds } }, target.sector);
  }

  /**
   * Every change to a dreamer's pools. `character.energy` is their only representation, so a
   * snapshot taken right after returns them. The dreamer is told, and anyone who sees them is told
   * when their condition changed band. Winded is folded over each balance sent, as the client
   * folds it over each `energy` frame, so both sides agree on it. Checking once a step after
   * recovery would miss a swing or a hit that took balance to exactly zero.
   */
  private setEnergy(slot: PlayerSlot, energy: Energy): void {
    slot.character = { ...slot.character, energy };
    slot.winded = windedAfter(slot.winded, energy.balanceCurrent);
    slot.outbox.sendEncoded({ tag: 'energy', payload: energy }, this.logger);
    this.setCondition(slot);
  }

  /** Announces an entity's condition when its health crossed into another band. This is all another player learns of anyone's health. */
  private setCondition(entity: PlayerSlot | MonsterRuntime): void {
    const [id, current, max] =
      'character' in entity
        ? [entity.character.id, entity.character.energy.healthCurrent, entity.character.energy.healthMax]
        : [entity.id, entity.health, entity.kind.health];
    const condition = conditionOf(current, max);
    if (condition === entity.condition) return;
    entity.condition = condition;
    this.broadcast({ tag: 'condition', payload: { entityId: id, condition } }, entity.sector);
  }

  /** Whether the player lies fallen; `false` for anyone not in this space. */
  isFallen(entityId: string): boolean {
    const slot = this.players.get(entityId);
    return slot !== undefined && isFallen(slot);
  }

  /**
   * Replaces what the dreamer has grown into, and tells them. A new rank can raise a pool's
   * maximum, which then takes effect where the rank was earned.
   */
  private updateLucidity(slot: PlayerSlot, lucidity: Lucidity): void {
    slot.character = { ...slot.character, lucidity };
    slot.outbox.sendEncoded({ tag: 'lucidity', payload: lucidityMessage(lucidity) }, this.logger);
    const energy = slot.character.energy;
    const maxima = maxPools(slot.character.lucidity.ranks);
    if (maxima.healthMax !== energy.healthMax || maxima.balanceMax !== energy.balanceMax || maxima.spiritMax !== energy.spiritMax) {
      this.setEnergy(slot, { ...energy, ...maxima });
    }
  }

  /** Adds practice toward the next rank of the teaching studied, carrying over into further ranks. Nothing accrues with no teaching studied. */
  private addPractice(slot: PlayerSlot, amount: number): void {
    const lucidity = slot.character.lucidity;
    const study = lucidity.study;
    if (study === undefined) return;
    let rank = rankOf(lucidity.ranks, study);
    let practice = (lucidity.ranks.find((held) => held.teachingId === study)?.practice ?? 0) + amount;
    let mastered = false;
    while (!mastered && practice >= practiceNeeded(rank)) {
      practice -= practiceNeeded(rank);
      rank += 1;
      mastered = rank >= teaching(study).maxRank;
    }
    this.updateLucidity(slot, {
      ...lucidity,
      ranks: withRank(lucidity.ranks, { teachingId: study, rank, practice: mastered ? 0 : practice }),
      study: mastered ? undefined : study,
    });
  }

  /** Moves the held task's progress to what `next` makes of it, no further than its goal, when the task is one `counts` accepts. */
  private advanceTask(slot: PlayerSlot, counts: (spec: TaskSpec) => boolean, next: (progress: number) => number): void {
    const lucidity = slot.character.lucidity;
    const task = lucidity.task;
    if (task === undefined) return;
    const spec = taskSpec(task);
    if (spec === undefined || !counts(spec)) return;
    const progress = Math.min(taskGoal(spec), next(task.progress));
    if (progress !== task.progress) this.updateLucidity(slot, { ...lucidity, task: { ...task, progress } });
  }

  /** Adds to the dreamer's row of the item, or puts a new row in the first free slot, and sends them their inventory. */
  private giveItem(slot: PlayerSlot, itemId: ItemId, quantity: number): void {
    if (slot.inventory.some((row) => row.itemId === itemId)) {
      slot.inventory = slot.inventory.map((row) => (row.itemId === itemId ? { ...row, quantity: row.quantity + quantity } : row));
    } else {
      let free = 0;
      while (slot.inventory.some((row) => row.slot === free)) free += 1;
      slot.inventory = [...slot.inventory, { slot: free, itemId, quantity, equippedHand: undefined }];
    }
    this.sendInventory(slot);
  }

  private sendInventory(slot: PlayerSlot): void {
    slot.outbox.sendEncoded({ tag: 'inventory', payload: inventoryMessage(slot.inventory) }, this.logger);
  }

  /**
   * The service the named NPC offers a dreamer who stands within speaking distance of it. Anything
   * else (no such NPC, no service, too far, a fallen dreamer) is dropped silently, as a `talk` is.
   */
  private serviceFor(npcId: string, entityId: string): { player: PlayerSlot; service: NPCService } | undefined {
    const player = this.players.get(entityId);
    const npc = this.npcs.get(npcId);
    const service = npc?.definition.service;
    if (player === undefined || npc === undefined || service === undefined) return undefined;
    if (isFallen(player) || !this.inSpeakingDistance(npc, player)) return undefined;
    return { player, service };
  }

  /**
   * A master sets a task for a dreamer who holds none: their trial for one without a role, or the
   * task gating a teaching of the dreamer's own role, at rank 0 and with its needs met.
   */
  handleAskTask(npcId: string, teachingId: string | undefined, entityId: string): void {
    const asked = this.serviceFor(npcId, entityId);
    if (asked === undefined) return;
    const role = roleOfService(asked.service);
    const lucidity = asked.player.character.lucidity;
    if (lucidity.task !== undefined) return;
    if (teachingId === undefined) {
      if (lucidity.role === undefined) this.updateLucidity(asked.player, { ...lucidity, task: { role, teachingId: undefined, progress: 0 } });
      return;
    }
    if (!isTeachingId(teachingId) || lucidity.role !== role) return;
    if (teaching(teachingId).role !== role || teachingStanding(lucidity.ranks, teachingId) !== 'task') return;
    this.updateLucidity(asked.player, { ...lucidity, task: { role, teachingId, progress: 0 } });
  }

  /**
   * The master who set a task takes it as done once it is at its goal. A trial makes the dreamer
   * the role for good, teaches the role's first teaching and sets them to study it, and gives a
   * Heiler their Mondstein. A gate teaches the first rank of its teaching.
   */
  handleCompleteTask(npcId: string, entityId: string): void {
    const asked = this.serviceFor(npcId, entityId);
    if (asked === undefined) return;
    const lucidity = asked.player.character.lucidity;
    const task = lucidity.task;
    if (task === undefined || task.role !== roleOfService(asked.service)) return;
    const spec = taskSpec(task);
    if (spec === undefined || task.progress < taskGoal(spec)) return;
    const learned = task.teachingId ?? FIRST_TEACHING[task.role];
    this.updateLucidity(asked.player, {
      role: task.role,
      ranks: withRank(lucidity.ranks, { teachingId: learned, rank: 1, practice: 0 }),
      study: task.teachingId === undefined ? learned : lucidity.study,
      task: undefined,
    });
    if (task.teachingId === undefined && task.role === 'heiler') this.giveItem(asked.player, 'mondstein', 1);
  }

  /** Clears the task held, wherever the dreamer is. */
  handleAbandonTask(entityId: string): void {
    const player = this.players.get(entityId);
    if (player?.character.lucidity.task === undefined) return;
    this.updateLucidity(player, { ...player.character.lucidity, task: undefined });
  }

  /** A master sets a dreamer of their role to study a teaching they may build on: its needs met, below its last rank, and past its gate if it has one. */
  handleStudy(npcId: string, teachingId: string, entityId: string): void {
    const asked = this.serviceFor(npcId, entityId);
    if (asked === undefined || !isTeachingId(teachingId)) return;
    const lucidity = asked.player.character.lucidity;
    if (lucidity.role === undefined || lucidity.role !== roleOfService(asked.service) || teaching(teachingId).role !== lucidity.role) return;
    if (teachingStanding(lucidity.ranks, teachingId) !== 'open') return;
    this.updateLucidity(asked.player, { ...lucidity, study: teachingId });
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

  /** Whether a body of `radius` at the point would overlap a player, an NPC, or a monster other than `excluding`. A fallen body still counts; a fading monster does not. */
  private overlapsEntity(point: Point, radius: number, excluding?: MonsterRuntime): boolean {
    for (const slot of this.players.values()) {
      if (distance(point, slot.character.position) < radius + SOMNIO_CONSTANTS.playerRadius) return true;
    }
    if (this.npcBodies.some((npc) => distance(point, npc) < radius + npc.radius)) return true;
    for (const monster of this.monsters.values()) {
      if (monster === excluding || monster.fadingUntil !== undefined) continue;
      if (distance(point, monster.position) < radius + monster.kind.radius) return true;
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
      condition: slot.condition,
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
      condition: 'hale',
      ...(npc.definition.service === undefined ? {} : { service: npc.definition.service }),
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
      condition: monster.condition,
    };
  }
}

/** The space's live doors whose counterparts lie in other spaces, with both openings. A pair within one space carries no voice: it is already heard there. */
function doorwaysOut(world: LoadedWorld, space: Space<Sector>): Doorway[] {
  const doorways: Doorway[] = [];
  for (const sector of space.sectors) {
    for (const door of sector.doors) {
      const counterpart = counterpartOf(world, door);
      if (counterpart.spaceId === space.id) continue;
      doorways.push({ near: resolveDoor(sector, door, world.registry)!.doorway, spaceId: counterpart.spaceId, far: counterpart.resolved.doorway });
    }
  }
  return doorways;
}

/**
 * Adds `amount` to a pool's carry and returns the pool with the whole units moved into it, up to
 * `max`. At the maximum the units are dropped, so nothing banks up there.
 */
function accrue(carry: PlayerSlot['carry'], pool: keyof PlayerSlot['carry'], amount: number, current: number, max: number): number {
  carry[pool] += amount;
  const whole = Math.floor(carry[pool]);
  if (whole < 1) return current;
  carry[pool] -= whole;
  return Math.min(max, current + whole);
}
