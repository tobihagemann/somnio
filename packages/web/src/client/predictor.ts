import {
  MOVE_SUBSTEP,
  angularDistance,
  clamp,
  distance,
  doorContains,
  gaitMetresPerSecond,
  headingFromVector,
  isLegalMove,
  relativeDirection,
  resolveMove,
  speedMultiplier,
} from '@somnio/core';
import type { Body, Heading, Point } from '@somnio/core';
import { worldMovement } from '@/scene/cameraRig';
import type { ConnectionState, OverlayKind } from './connectionController';
import type { Gait, SomnioMessage } from '@somnio/protocol';
import type { ClientEntity, ClientWorld } from './clientWorld';
import type { RemoteInterpolation } from './remoteInterpolation';
import type { WorldRenderSurface } from './renderSurface';
import type { HeldKeys, KeyCaptureSink } from './input';

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

export interface Velocity {
  dx: number;
  dy: number;
}

/** Normalized eight-way screen direction from the held keys; zero when nothing is held. */
export function velocityFromHeld(held: HeldKeys): Velocity {
  let dx = 0;
  let dy = 0;
  if (held.d) dx += 1;
  if (held.a) dx -= 1;
  if (held.w) dy -= 1;
  if (held.s) dy += 1;
  if (dx === 0 && dy === 0) return { dx: 0, dy: 0 };
  const length = Math.sqrt(dx * dx + dy * dy);
  return { dx: dx / length, dy: dy / length };
}

export function gaitFromHeld(held: HeldKeys): Gait {
  if (held.leftShift) return 'run';
  if (held.leftOption) return 'walk';
  return 'jog';
}

export interface EntityBlockers {
  /** Block at contact, on the server too. Carry their id so a blocked step can bump the one it touched. */
  npcs: (Body & { id: string })[];
  /** Other players and monsters, which only this client stops at. */
  bodies: Body[];
}

/**
 * What stands in the local player's way, at the positions the client draws.
 *
 * Other players are always solid; monsters are *soft-solid* — a monster the player is clear of
 * blocks the step, but one already overlapping the player is dropped so the player can always
 * walk free. Monsters chase on the server's tick and can lag onto the player, and a block there
 * would hold them in place.
 */
export function entityBlockers(entities: Iterable<ClientEntity>, self: ClientEntity): EntityBlockers {
  const blockers: EntityBlockers = { npcs: [], bodies: [] };
  for (const entity of entities) {
    if (entity.id === self.id) continue;
    const body = { id: entity.id, x: entity.position.x, z: entity.position.z, radius: entity.radius };
    if (entity.kind === 'npc') {
      blockers.npcs.push(body);
      continue;
    }
    if (entity.kind === 'monster' && distance(self.position, body) < self.radius + body.radius) continue;
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
  readonly isChatInputFocused: boolean;
  readonly entities: Map<string, ClientEntity>;
  readonly selfId: string | undefined;
  readonly world: ClientWorld | undefined;
}

export interface PredictorOptions {
  session: PredictorSession;
  input: KeyCaptureSink;
  renderSurface: WorldRenderSurface;
  interpolation: RemoteInterpolation;
  send: (message: SomnioMessage) => void;
  /** Latest cursor-derived facing, or `undefined` before the pointer has been seen. */
  mouseFacing: () => Heading | undefined;
}

export class GameplayPredictor {
  private readonly session: PredictorSession;
  private readonly input: KeyCaptureSink;
  private readonly renderSurface: WorldRenderSurface;
  private readonly interpolation: RemoteInterpolation;
  private readonly send: (message: SomnioMessage) => void;
  private readonly mouseFacing: () => Heading | undefined;

  private lastTickMs: number | undefined;
  private lastReport: { position: Point; facing: Heading; gait: Gait } | undefined;
  private lastHeartbeatMs: number | undefined;
  /** Set from sending `useDoor` until the server answers it. */
  private awaitingDoor = false;
  /** The door whose trigger the last attempted step touched, so leaning on it fires once. */
  private touchedDoor: string | undefined;

  constructor(options: PredictorOptions) {
    this.session = options.session;
    this.input = options.input;
    this.renderSurface = options.renderSurface;
    this.interpolation = options.interpolation;
    this.send = options.send;
    this.mouseFacing = options.mouseFacing;
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
   * prediction outright, and it is what the next report is measured from.
   */
  correct(position: Point): void {
    const selfId = this.session.selfId;
    const entity = selfId === undefined ? undefined : this.session.entities.get(selfId);
    if (entity === undefined) return;
    this.session.entities.set(entity.id, { ...entity, position });
    if (this.lastReport !== undefined) this.lastReport = { ...this.lastReport, position };
    this.renderSurface.updatePosition(entity.id, position, entity.facing, undefined);
    this.session.world?.follow(position, this.renderSurface);
  }

  /**
   * The full gameplay-input gate, refreshed every tick so opening an overlay or focusing chat
   * releases the keys without an explicit notify path.
   */
  private gateIsOpen(): boolean {
    return this.session.connectionState === 'attached' && this.session.presentedOverlay === undefined && !this.session.isChatInputFocused;
  }

  runTick(nowMs: number): void {
    // Assigning the gate is what clears held keys when it closes: the sink drops its bitset on
    // deactivation, so an overlay opening mid-hold cannot leave the character walking.
    this.input.setGameplayActive(this.gateIsOpen());
    this.drawRemoteEntities(nowMs);
    if (this.session.isChatInputFocused) return;
    const selfId = this.session.selfId;
    const world = this.session.world;
    if (selfId === undefined || world === undefined) return;
    const existing = this.session.entities.get(selfId);
    if (existing === undefined) return;

    const selfEntity: ClientEntity = { ...existing };
    const held = this.input.snapshot();
    const gait = gaitFromHeld(held);

    // Refresh facing every tick regardless of velocity so a stationary player still tracks the
    // cursor.
    const facing = this.mouseFacing();
    if (facing !== undefined) selfEntity.facing = facing;

    // The lower bound guards a misbehaving injected timestamp; `performance.now()` is monotonic.
    const elapsedMs = this.lastTickMs === undefined ? 0 : clamp(nowMs - this.lastTickMs, 0, MAX_TICK_ELAPSED_MS);
    this.lastTickMs = nowMs;

    const velocity = velocityFromHeld(held);
    const moving = velocity.dx !== 0 || velocity.dy !== 0;
    selfEntity.gait = moving ? gait : 'jog';
    // Declared out here so it reaches the unconditional render update below; `undefined` on a
    // stationary tick preserves the renderer's held travel direction.
    let travel: Heading | undefined;
    if (moving && !this.awaitingDoor) {
      const direction = worldMovement(velocity.dx, velocity.dy);
      // Intended (pre-collision) travel: the multiplier below sizes the pre-resolution step, so
      // a wall-slide keeps clip and speed mutually consistent.
      travel = headingFromVector(direction.dx, direction.dz);
      const metres = gaitMetresPerSecond(gait) * (elapsedMs / 1000) * speedMultiplier(relativeDirection(travel, selfEntity.facing));
      selfEntity.position = this.walk(world, selfEntity, direction, metres);
    }

    this.session.entities.set(selfId, selfEntity);
    this.renderSurface.updateGait(selfId, selfEntity.gait);
    this.renderSurface.updatePosition(selfId, selfEntity.position, selfEntity.facing, travel);
    world.follow(selfEntity.position, this.renderSurface);

    // No report while a door is pending: the server answers `useDoor` by moving the player to
    // another space, and a trailing `move` would carry this space's coordinates into it.
    if (!this.awaitingDoor) this.reportIfChanged(selfEntity, nowMs);
  }

  /** Samples every gliding remote entity once a tick, before the local player steps, so that step collides with what this frame draws. */
  private drawRemoteEntities(nowMs: number): void {
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

  /**
   * Walks `metres` along `direction` in substeps, and returns where the player ends up.
   *
   * Each substep is taken through `resolveMove`, so it slides along what it cannot cross. Before a
   * substep is committed the segment from the last report to it is tested with `isLegalMove`,
   * which is the test the server will run on the next report; where it fails, the position just
   * before is reported first. That waypoint is what carries a slide round a corner: the straight
   * line between two timed reports would cut inside it.
   *
   * A blocked substep that touched an NPC bumps it, once a tick with no latch: the server ignores
   * a bump it is already answering. A substep that lands in a door's trigger is not taken; it
   * asks for the door and stops the player there until the server answers.
   */
  private walk(world: ClientWorld, self: ClientEntity, direction: { dx: number; dz: number }, metres: number): Point {
    const { npcs, bodies } = entityBlockers(this.session.entities.values(), self);
    let position = self.position;
    let bumped = false;
    const substeps = Math.ceil(metres / MOVE_SUBSTEP);
    const length = metres / substeps;
    for (let index = 0; index < substeps; index += 1) {
      const target = { x: position.x + direction.dx * length, z: position.z + direction.dz * length };
      const step = resolveMove(world.collision, position, target, self.radius, npcs, bodies);
      if (step.blocked && !bumped) {
        const npc = npcs.find((candidate) => distance(target, candidate) < self.radius + candidate.radius);
        if (npc !== undefined) {
          bumped = true;
          this.send({ tag: 'bump', payload: { targetId: npc.id } });
        }
      }
      const door = world.doors.find((candidate) => doorContains(candidate.resolved, step.position, 0));
      if (door !== undefined) {
        const key = `${door.sector}/${door.doorId}`;
        if (key !== this.touchedDoor) {
          this.touchedDoor = key;
          this.awaitingDoor = true;
          this.send({ tag: 'useDoor', payload: { sector: door.sector, doorId: door.doorId } });
        }
        break;
      }
      this.touchedDoor = undefined;
      if (step.position.x === position.x && step.position.z === position.z) break;
      if (!isLegalMove(world.collision, this.lastReport?.position ?? self.position, step.position, self.radius, npcs)) {
        this.report(position, self.facing, self.gait);
      }
      position = step.position;
    }
    return position;
  }

  /**
   * `nowMs` is the enclosing tick's single timestamp, so the movement step and the heartbeat gate
   * never see two slightly different instants within one tick.
   */
  private reportIfChanged(entity: ClientEntity, nowMs: number): void {
    const last = this.lastReport;
    if (
      last !== undefined &&
      last.position.x === entity.position.x &&
      last.position.z === entity.position.z &&
      Math.abs(angularDistance(last.facing, entity.facing)) <= FACING_EMIT_THRESHOLD_DEGREES &&
      last.gait === entity.gait
    ) {
      return;
    }
    // Heartbeat gate. The last report is deliberately left unchanged when throttled, so the next
    // tick past the interval still sees the move as pending and reports the final position rather
    // than dropping it.
    if (this.lastHeartbeatMs !== undefined && nowMs - this.lastHeartbeatMs < POSITION_HEARTBEAT_INTERVAL_MS) {
      return;
    }
    this.lastHeartbeatMs = nowMs;
    this.report(entity.position, entity.facing, entity.gait);
  }

  private report(position: Point, facing: Heading, gait: Gait): void {
    this.lastReport = { position, facing, gait };
    this.send({ tag: 'move', payload: { x: position.x, z: position.z, facing, gait } });
  }
}
