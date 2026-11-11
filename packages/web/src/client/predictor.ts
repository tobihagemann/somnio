import {
  COMBAT,
  MOVE_SUBSTEP,
  angularDistance,
  clamp,
  distance,
  doorContains,
  gaitAllowed,
  gaitMetresPerSecond,
  headingFromVector,
  isLegalMove,
  relativeDirection,
  resolveMove,
  speedMultiplier,
} from '@somnio/core';
import type { Body, EffectId, Heading, Point, ResolvedDoor } from '@somnio/core';
import type { ConnectionState, OverlayKind } from './connectionController';
import type { Gait, SomnioMessage } from '@somnio/protocol';
import { drivenOff } from './clientWorld';
import type { ClientEntity, ClientWorld } from './clientWorld';
import type { RemoteInterpolation } from './remoteInterpolation';
import type { WorldRenderSurface } from './renderSurface';

/**
 * One client-predicted gameplay tick.
 *
 * The local player moves by client-side prediction at frame rate and reports to the server on a
 * 10 Hz heartbeat; the server checks each report with `isLegalMove` from `@somnio/core` over the
 * same sectors and registry. The rule that keeps a client whose reports arrive in time from being
 * corrected is that nothing is reported which this side's own `isLegalMove` refuses: every step is taken
 * through `resolveMove`, and the segment from the last report to each new position is tested
 * before the position is committed.
 *
 * Time is injected — `runTick` takes the timestamp rather than reading a clock — so the whole
 * tick is drivable from a test without a frame loop. That is the repo's testable-time
 * convention, and the deterministic tick suite is what it exists for.
 */

/** Upper bound on one tick's elapsed time, so a stall (or the first tick) cannot teleport. */
export const MAX_TICK_ELAPSED_MS = 100;
/** Position-report heartbeat, 10 Hz. */
export const POSITION_HEARTBEAT_INTERVAL_MS = 100;
/**
 * A facing change below this shortest-arc threshold does not by itself trigger an emit — a
 * cursor jittering by fractions of a degree (including across the 0/360 seam) would otherwise
 * report on every heartbeat.
 */
export const FACING_EMIT_THRESHOLD_DEGREES = 1;

/** How a walk follows its path, and gives it up. */
export const PATH_FOLLOWING = {
  /** How near a waypoint counts as there. */
  arrivalMetres: 0.02,
  /** How long a leg may bring the player no nearer its waypoint before the path is searched again. */
  stallMs: 250,
  /** How long a search that found no way waits before trying again. */
  retryMs: 250,
  /** How many times one destination is searched again, for a stall or for no way, before the walk ends. */
  maxReplans: 4,
} as const;

/** Within this distance of the point a held pointer steers toward, the player stands still, so a pointer resting on them does not turn them on the spot. */
const STEER_STANDS_WITHIN_METRES = 0.25;
/** How near the player a point is too near to face. */
const FACING_DEADZONE_METRES = 0.05;
/** Less than this nearer a waypoint in a tick is no progress. */
const PROGRESS_METRES = 1e-3;

/** What a walk does once the player stands within `within` metres of its destination, at most once. */
export interface Arrival {
  within: number;
  act: () => void;
}

/**
 * Where the player is walking. A path is followed waypoint by waypoint to a destination, and
 * searched again round what stops it. One with an arrival acts as it comes in range, there or short
 * of it. A steer heads straight for a point a held pointer moves. A leap heads straight for its end
 * at a speed of its own, and ends where it stops.
 */
export type Walk =
  | {
      kind: 'path';
      destination: Point;
      /** What is left to walk through, the next first. */
      waypoints: Point[];
      /** The edges the walk found unwalkable, which every search for it leaves out. */
      excludedEdges: Set<string>;
      /** How many searches the destination has had: the first, then each re-plan. */
      searches: number;
      /** When the next search is due; `undefined` while a path is being followed. */
      searchAtMs: number | undefined;
      /** When the leg under way last brought the player nearer its waypoint. */
      progressAtMs: number;
      arrive: Arrival | undefined;
    }
  | { kind: 'steer'; toward: Point }
  | { kind: 'leap'; end: Point; metresPerSecond: number };

/** The heading from `from` toward `to`, or `undefined` when there is no `to` or it is too near to face. */
function headingToward(from: Point, to: Point | undefined): Heading | undefined {
  if (to === undefined || distance(from, to) <= FACING_DEADZONE_METRES) return undefined;
  return headingFromVector(to.x - from.x, to.z - from.z);
}

export interface EntityBlockers {
  /** Block at contact, on the server too. */
  npcs: Body[];
  /** Other players and monsters, which only this client stops at. */
  bodies: Body[];
}

/**
 * What stands in the local player's way, at the positions the client draws.
 *
 * Other players are always solid; monsters are *soft-solid* — a monster the player is clear of
 * blocks the step, but one already overlapping the player is dropped so the player can always
 * walk free. Monsters chase on the server's tick and can lag onto the player, and a block there
 * would hold them in place. A fallen player still blocks; a nightmare driven off is fading and
 * blocks nothing.
 */
export function entityBlockers(entities: Iterable<ClientEntity>, self: ClientEntity): EntityBlockers {
  const blockers: EntityBlockers = { npcs: [], bodies: [] };
  for (const entity of entities) {
    if (entity.id === self.id) continue;
    const body = { x: entity.position.x, z: entity.position.z, radius: entity.radius };
    if (entity.kind === 'npc') {
      blockers.npcs.push(body);
      continue;
    }
    if (drivenOff(entity) || (entity.kind === 'monster' && distance(self.position, body) < self.radius + body.radius)) continue;
    blockers.bodies.push(body);
  }
  return blockers;
}

/** The live gameplay state the tick reads. Supplied by the connection controller. */
export interface PredictorSession {
  /**
   * Typed rather than `string`/`unknown`: the whole input gate is a comparison against this, and
   * a typo or a renamed state would compile clean against a widened type, leaving the gate silently
   * shut and the character unable to move with nothing objecting.
   */
  readonly connectionState: ConnectionState;
  readonly presentedOverlay: OverlayKind | undefined;
  readonly entities: Map<string, ClientEntity>;
  readonly selfId: string | undefined;
  readonly world: ClientWorld | undefined;
}

export interface PredictorOptions {
  session: PredictorSession;
  renderSurface: WorldRenderSurface;
  interpolation: RemoteInterpolation;
  send: (message: SomnioMessage) => void;
  /** The point the player faces, or `undefined` to face the way they walk. */
  lookAt: () => Point | undefined;
  /** Whether Run is on. */
  running: () => boolean;
  /** Whether the player's balance gave out: until it is back, only the slow gait moves them. */
  winded: () => boolean;
  /** The effects the player holds, which may hold them below a run. */
  effects: () => readonly EffectId[];
  /** Whether the player lies fallen, and so does not move or report. */
  fallen: () => boolean;
  /** Whether a swing is still slowing the player at `nowMs`. */
  slowed: (nowMs: number) => boolean;
  /** Whether the player's own channel holds them still: the walk under way waits, kept as it is, until it lands or breaks. */
  heldStill: () => boolean;
}

export class GameplayPredictor {
  private readonly session: PredictorSession;
  private readonly renderSurface: WorldRenderSurface;
  private readonly interpolation: RemoteInterpolation;
  private readonly send: (message: SomnioMessage) => void;
  private readonly lookAt: () => Point | undefined;
  private readonly running: () => boolean;
  private readonly winded: () => boolean;
  private readonly effects: () => readonly EffectId[];
  private readonly fallen: () => boolean;
  private readonly slowed: (nowMs: number) => boolean;
  private readonly heldStill: () => boolean;

  private lastTickMs: number | undefined;
  private lastReport: { position: Point; facing: Heading; gait: Gait } | undefined;
  private lastHeartbeatMs: number | undefined;
  private walking: Walk | undefined;
  /** Set from sending `useDoor` until the server answers it. */
  private awaitingDoor = false;
  /** The door last asked for, held until a step lands outside every trigger, so leaning on it asks once. */
  private touchedDoor: string | undefined;

  constructor(options: PredictorOptions) {
    this.session = options.session;
    this.renderSurface = options.renderSurface;
    this.interpolation = options.interpolation;
    this.send = options.send;
    this.lookAt = options.lookAt;
    this.running = options.running;
    this.winded = options.winded;
    this.effects = options.effects;
    this.fallen = options.fallen;
    this.slowed = options.slowed;
    this.heldStill = options.heldStill;
  }

  get walk(): Readonly<Walk> | undefined {
    return this.walking;
  }

  /**
   * Walks to `destination` along a path searched on the next tick, in place of any walk under way.
   * With `arrive`, the walk ends on the first tick the player stands within its range of the
   * destination, short of it or where the path stops, and `act` runs then, after the report that
   * brought them there. A walk that ends out of range, or that something else ends first, never acts.
   */
  walkTo(destination: Point, arrive?: Arrival): void {
    this.walking = {
      kind: 'path',
      destination,
      waypoints: [],
      excludedEdges: new Set(),
      searches: 0,
      searchAtMs: Number.NEGATIVE_INFINITY,
      progressAtMs: Number.NEGATIVE_INFINITY,
      arrive,
    };
  }

  /** The walk under way goes on, but does nothing on arriving. */
  dropArrival(): void {
    if (this.walking?.kind === 'path') this.walking.arrive = undefined;
  }

  /**
   * Heads straight for `point` from the next tick, in place of any path. A steer under way only
   * turns toward it. A leap under way runs on and the steer is dropped, so a held pointer, which
   * asks again each tick, steers once the leap ends.
   */
  steerToward(point: Point): void {
    if (this.walking?.kind === 'steer') this.walking.toward = point;
    else if (this.walking?.kind !== 'leap') this.walking = { kind: 'steer', toward: point };
  }

  /**
   * Leaps from the next tick toward the body until in contact with it, at most `metres`, in place
   * of any walk under way.
   */
  leapAt(target: Body, metres: number, metresPerSecond: number): void {
    const self = this.session.selfId === undefined ? undefined : this.session.entities.get(this.session.selfId);
    if (self === undefined) return;
    const from = self.position;
    const away = distance(from, target);
    const length = clamp(away - self.radius - target.radius, 0, metres);
    const end = away === 0 ? from : { x: from.x + ((target.x - from.x) / away) * length, z: from.z + ((target.z - from.z) / away) * length };
    this.walking = { kind: 'leap', end, metresPerSecond };
  }

  stop(): void {
    this.walking = undefined;
  }

  /**
   * Sends at once the report the heartbeat is holding back, if one is. A request the server judges
   * by where the player stands then follows the move that brought them there. Like every report it
   * is legal, and none goes out while a door is pending.
   */
  flush(): void {
    const selfId = this.session.selfId;
    const entity = selfId === undefined ? undefined : this.session.entities.get(selfId);
    if (entity === undefined || this.awaitingDoor || !this.changedSinceReport(entity)) return;
    this.report(entity.position, entity.facing, entity.gait);
  }

  /**
   * Clears the tick clock and what was last reported. It leaves a pending door alone: a blur must
   * not release a transfer the server is still answering.
   */
  reset(): void {
    this.lastTickMs = undefined;
    this.lastReport = undefined;
    this.lastHeartbeatMs = undefined;
  }

  /**
   * Ends the wait on a door. `rearm` is for a new space or a teardown; a refused door stays
   * touched, so the player still leaning on it does not ask again every round trip.
   */
  releaseDoor(rearm: boolean): void {
    this.awaitingDoor = false;
    if (rearm) this.touchedDoor = undefined;
  }

  /**
   * The server refused a move and answered with the last position it accepted. That replaces the
   * prediction outright, and it is what the next report is measured from. The walk ends there:
   * its path started from where the server says the player is not.
   */
  correct(position: Point): void {
    this.walking = undefined;
    const selfId = this.session.selfId;
    const entity = selfId === undefined ? undefined : this.session.entities.get(selfId);
    if (entity === undefined) return;
    this.session.entities.set(entity.id, { ...entity, position });
    if (this.lastReport !== undefined) this.lastReport = { ...this.lastReport, position };
    this.renderSurface.updatePosition(entity.id, position, entity.facing, undefined);
    this.session.world?.follow(position, this.renderSurface);
  }

  /** The gameplay-input gate, refreshed every tick so opening an overlay ends the walk without an explicit notify path. Typing in chat leaves it open, so a walk goes on. */
  gateIsOpen(): boolean {
    return this.session.connectionState === 'attached' && this.session.presentedOverlay === undefined;
  }

  runTick(nowMs: number): void {
    if (!this.gateIsOpen()) this.walking = undefined;
    // Before the local player steps, so that step collides with what this frame draws.
    this.drawRemoteEntities(nowMs);
    const selfId = this.session.selfId;
    const world = this.session.world;
    if (selfId === undefined || world === undefined) return;
    const existing = this.session.entities.get(selfId);
    if (existing === undefined) return;
    if (this.fallen()) {
      this.walking = undefined;
      return;
    }

    const walk = this.walking;
    const selfEntity: ClientEntity = { ...existing };
    const gait = this.winded() ? 'walk' : gaitAllowed(this.running() ? 'run' : 'jog', this.effects());

    // The lower bound guards a misbehaving injected timestamp; `performance.now()` is monotonic.
    const elapsedMs = this.lastTickMs === undefined ? 0 : clamp(nowMs - this.lastTickMs, 0, MAX_TICK_ELAPSED_MS);
    this.lastTickMs = nowMs;

    const heldStill = this.heldStill();
    // Standing still while held is no stall, so a path's leg is timed afresh from when it lets go.
    if (heldStill && walk?.kind === 'path') walk.progressAtMs = nowMs;
    const course = this.awaitingDoor || heldStill ? undefined : this.course(world, selfEntity, nowMs);
    // Intended (pre-collision) travel: the multiplier below sizes the pre-resolution step, so a
    // wall-slide keeps clip and speed mutually consistent. `undefined` on a stationary tick
    // preserves the renderer's held travel direction.
    const travel = course === undefined ? undefined : headingFromVector(course.x - selfEntity.position.x, course.z - selfEntity.position.z);
    // Refreshed every tick, so a player standing still keeps turning with the cursor.
    selfEntity.facing = headingToward(selfEntity.position, this.lookAt()) ?? travel ?? selfEntity.facing;
    selfEntity.gait = course === undefined ? 'jog' : gait;
    if (travel !== undefined) {
      const pace = speedMultiplier(relativeDirection(travel, selfEntity.facing)) * (this.slowed(nowMs) ? COMBAT.swingSlow.factor : 1);
      const metresPerSecond = this.walking?.kind === 'leap' ? this.walking.metresPerSecond : gaitMetresPerSecond(gait) * pace;
      selfEntity.position = this.follow(world, selfEntity, metresPerSecond * (elapsedMs / 1000), nowMs);
    }

    this.session.entities.set(selfId, selfEntity);
    this.renderSurface.updateGait(selfId, selfEntity.gait);
    this.renderSurface.updatePosition(selfId, selfEntity.position, selfEntity.facing, travel);
    world.follow(selfEntity.position, this.renderSurface);

    // No report while a door is pending: the server answers `useDoor` by moving the player to
    // another space, and a trailing `move` would carry this space's coordinates into it.
    if (!this.awaitingDoor) this.reportIfChanged(selfEntity, nowMs);
    if (walk?.kind === 'path') this.arriveIfInRange(walk, selfEntity.position);
  }

  /**
   * Acts on the walk's arrival once the player stands in range, while the walk goes on or has just
   * ended of itself. A door asked for ends it without acting, and so does anything that ended it
   * between ticks or replaced it.
   */
  private arriveIfInRange(walk: Extract<Walk, { kind: 'path' }>, position: Point): void {
    const arrive = walk.arrive;
    if (arrive === undefined || this.awaitingDoor || (this.walking !== walk && this.walking !== undefined)) return;
    if (distance(position, walk.destination) > arrive.within) return;
    walk.arrive = undefined;
    if (this.walking === walk) this.walking = undefined;
    this.flush();
    arrive.act();
  }

  /** Moves every gliding remote entity to where it stands at `nowMs`, in the session's entities and on the render surface. */
  drawRemoteEntities(nowMs: number): void {
    for (const entity of this.session.entities.values()) {
      const position = this.interpolation.positionAt(entity.id, nowMs);
      if (position === undefined) continue;
      const dx = position.x - entity.position.x;
      const dz = position.z - entity.position.z;
      const moved = dx !== 0 || dz !== 0;
      if (moved) this.session.entities.set(entity.id, { ...entity, position });
      this.renderSurface.updatePosition(entity.id, position, entity.facing, moved ? headingFromVector(dx, dz) : undefined);
    }
  }

  /** The point this tick heads for: the steer's, or the next waypoint once any search due has run. `undefined` stands the player still. */
  private course(world: ClientWorld, self: ClientEntity, nowMs: number): Point | undefined {
    const walking = this.walking;
    if (walking === undefined) return undefined;
    if (walking.kind === 'steer') return distance(self.position, walking.toward) > STEER_STANDS_WITHIN_METRES ? walking.toward : undefined;
    if (walking.kind === 'leap') {
      if (distance(self.position, walking.end) > PATH_FOLLOWING.arrivalMetres) return walking.end;
      this.walking = undefined;
      return undefined;
    }
    if (walking.searchAtMs !== undefined && nowMs >= walking.searchAtMs) this.search(world, self, walking, nowMs);
    if (this.walking !== walking) return undefined;
    while (walking.waypoints.length > 0 && distance(self.position, walking.waypoints[0]!) <= PATH_FOLLOWING.arrivalMetres) walking.waypoints.shift();
    if (walking.waypoints.length === 0 && walking.searchAtMs === undefined) this.walking = undefined;
    return walking.waypoints[0];
  }

  /**
   * Searches the path to the walk's destination round the bodies as they now stand. A search that
   * finds no way, as before the player's sector has its walk raster, waits and tries again. The
   * first search and `maxReplans` more are all one destination gets.
   */
  private search(world: ClientWorld, self: ClientEntity, walking: Extract<Walk, { kind: 'path' }>, nowMs: number): void {
    if (walking.searches > PATH_FOLLOWING.maxReplans) {
      this.walking = undefined;
      return;
    }
    walking.searches += 1;
    const { npcs, bodies } = entityBlockers(this.session.entities.values(), self);
    const found = world.findPath(self.position, walking.destination, [...npcs, ...bodies], walking.excludedEdges);
    walking.waypoints = found.waypoints;
    walking.progressAtMs = nowMs;
    if (found.waypoints.length > 0) walking.searchAtMs = undefined;
    else if (found.reached) this.walking = undefined;
    else walking.searchAtMs = nowMs + PATH_FOLLOWING.retryMs;
  }

  /**
   * Walks `metres` of the walk: straight for a steer's point or a leap's end, or through the path's
   * waypoints in turn, dropping each once there. A leg that brings the player no nearer its
   * waypoint for `stallMs`, as when a body steps into it, has the path searched again; a path
   * walked to its end ends the walk, and so does a leap that is stopped.
   */
  private follow(world: ClientWorld, self: ClientEntity, metres: number, nowMs: number): Point {
    const walking = this.walking!;
    if (walking.kind === 'steer') return this.stepToward(world, self, self.position, walking.toward, metres);
    if (walking.kind === 'leap') {
      const position = this.stepToward(world, self, self.position, walking.end, metres);
      if (metres > 0 && position.x === self.position.x && position.z === self.position.z) this.walking = undefined;
      return position;
    }
    const leg = walking.waypoints[0]!;
    const before = distance(self.position, leg);
    let position = self.position;
    let left = metres;
    while (left > 0 && this.walking === walking && walking.waypoints.length > 0) {
      const waypoint = walking.waypoints[0]!;
      const length = Math.min(left, distance(position, waypoint));
      position = this.stepToward(world, self, position, waypoint, length);
      left -= length;
      if (distance(position, waypoint) > PATH_FOLLOWING.arrivalMetres) break;
      walking.waypoints.shift();
    }
    if (this.walking !== walking) return position;
    if (walking.waypoints[0] !== leg || distance(position, leg) < before - PROGRESS_METRES) walking.progressAtMs = nowMs;
    else if (nowMs - walking.progressAtMs >= PATH_FOLLOWING.stallMs) walking.searchAtMs = nowMs;
    if (walking.waypoints.length === 0) this.walking = undefined;
    return position;
  }

  private stepToward(world: ClientWorld, self: ClientEntity, from: Point, to: Point, metres: number): Point {
    const away = distance(from, to);
    if (away === 0 || metres <= 0) return from;
    const length = Math.min(metres, away);
    return this.stepAlong(world, { ...self, position: from }, { dx: (to.x - from.x) / away, dz: (to.z - from.z) / away }, length);
  }

  /**
   * Walks `metres` along `direction` in substeps, and returns where the player ends up.
   *
   * Each substep is taken through `resolveMove`, so it slides along what it cannot cross. Before a
   * substep is committed the segment from the last report to it is tested with `isLegalMove`,
   * which is the test the server will run on the next report; where it fails, the position just
   * before is reported first. That waypoint is what carries a slide round a corner: the straight
   * line between two timed reports would cut inside it.
   *
   * A substep that lands in the trigger of a door the walk heads through is not taken; it asks for
   * the door, ends the walk, and stops the player there until the server answers. Any other substep
   * into a trigger is taken, so a path passing a door walks on through it. A door already asked for
   * is not asked for again until a substep has left its trigger.
   */
  private stepAlong(world: ClientWorld, self: ClientEntity, direction: { dx: number; dz: number }, metres: number): Point {
    const { npcs, bodies } = entityBlockers(this.session.entities.values(), self);
    let position = self.position;
    const substeps = Math.ceil(metres / MOVE_SUBSTEP);
    const length = metres / substeps;
    for (let index = 0; index < substeps; index += 1) {
      const target = { x: position.x + direction.dx * length, z: position.z + direction.dz * length };
      const step = resolveMove(world.collision, position, target, self.radius, npcs, bodies);
      const door = world.doors.find((candidate) => doorContains(candidate.resolved, step.position, 0));
      const doorKey = door === undefined ? undefined : `${door.sector}/${door.doorId}`;
      if (door === undefined) this.touchedDoor = undefined;
      else if (doorKey !== this.touchedDoor && this.headsThrough(door.resolved, position, step.position)) {
        this.touchedDoor = doorKey;
        this.awaitingDoor = true;
        this.walking = undefined;
        this.send({ tag: 'useDoor', payload: { sector: door.sector, doorId: door.doorId } });
        break;
      }
      if (step.position.x === position.x && step.position.z === position.z) break;
      if (!isLegalMove(world.collision, this.lastReport?.position ?? self.position, step.position, self.radius, npcs)) {
        this.report(position, self.facing, self.gait);
      }
      position = step.position;
    }
    return position;
  }

  /**
   * Whether a substep from `from` to `to`, which lands in the door's trigger, heads through the door.
   * A path does only where it ends, and a leap, which heads for a body, never does. A steer does on
   * entering the trigger, and within it only toward the doorway, so a player standing in a trigger a
   * path walked them into can steer back out.
   */
  private headsThrough(door: ResolvedDoor, from: Point, to: Point): boolean {
    const walking = this.walking;
    if (walking?.kind === 'leap') return false;
    if (walking?.kind === 'path') {
      const end = walking.waypoints.at(-1);
      return end !== undefined && doorContains(door, end, 0);
    }
    return !doorContains(door, from, 0) || distance(to, door.doorway) < distance(from, door.doorway);
  }

  /**
   * `nowMs` is the enclosing tick's single timestamp, so the movement step and the heartbeat gate
   * never see two slightly different instants within one tick.
   */
  private reportIfChanged(entity: ClientEntity, nowMs: number): void {
    if (!this.changedSinceReport(entity)) return;
    // Heartbeat gate. The last report is deliberately left unchanged when throttled, so the next
    // tick past the interval still sees the move as pending and reports the final position rather
    // than dropping it.
    if (this.lastHeartbeatMs !== undefined && nowMs - this.lastHeartbeatMs < POSITION_HEARTBEAT_INTERVAL_MS) {
      return;
    }
    this.lastHeartbeatMs = nowMs;
    this.report(entity.position, entity.facing, entity.gait);
  }

  private changedSinceReport(entity: ClientEntity): boolean {
    const last = this.lastReport;
    return (
      last === undefined ||
      last.position.x !== entity.position.x ||
      last.position.z !== entity.position.z ||
      Math.abs(angularDistance(last.facing, entity.facing)) > FACING_EMIT_THRESHOLD_DEGREES ||
      last.gait !== entity.gait
    );
  }

  private report(position: Point, facing: Heading, gait: Gait): void {
    this.lastReport = { position, facing, gait };
    this.send({ tag: 'move', payload: { x: position.x, z: position.z, facing, gait } });
  }
}
