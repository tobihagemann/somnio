import { setTimeout as delay } from 'node:timers/promises';
import { decodeSomnioMessage, SOMNIO_PROTOCOL_CONSTANTS } from '@somnio/protocol';
import type { SomnioMessage } from '@somnio/protocol';
import type { RawData, WebSocket } from 'ws';
import { PORTAL_LOST, handleBumpNPC, handleEnterPortal, handleEquipToggle, handlePosition, handleSay } from '../handlers/gameplay.ts';
import { handleLogin } from '../handlers/login.ts';
import { handleRegister } from '../handlers/register.ts';
import { handleRedeem, handleRevoke } from '../handlers/session.ts';
import type { Logger } from '../logging.ts';
import { persistPlayerCheckpoint } from '../world/checkpointWriter.ts';
import type { ConnectionDependencies } from './dependencies.ts';
import { ConnectionOutbox } from './outbox.ts';

export type ConnectionState = { kind: 'awaitingLogin' } | { kind: 'attached'; entityIndex: number; sectorName: string; accountId: string };

export type CloseDecision = { kind: 'keepOpen' } | { kind: 'close'; code: number; reason: string };

export const CLOSE_PROTOCOL_ERROR = 1002;
export const CLOSE_GOING_AWAY = 1001;
/** How long the exit path waits for the peer's close reply before terminating the socket. */
const SOCKET_CLOSE_GRACE_MS = 1000;
/** How long a shutdown drain waits for one connection's exit path; the whole shutdown is capped at 15 s. */
const SHUTDOWN_DRAIN_CAP_MS = 5000;
export const CLOSE_POLICY_VIOLATION = 1008;
export const FRAME_VALIDATION_FAILED = 'frame validation failed';

/** The narrow socket surface the actor drives, so tests can hand in a recording double. */
export interface ConnectionSocket {
  send(frame: string): Promise<void>;
  /** Starts the close handshake; a returned promise settles once the socket has closed (bounded). */
  close(code: number, reason: string): void | Promise<void>;
  pause(): void;
  resume(): void;
  onMessage(listener: (data: string | Uint8Array, isBinary: boolean) => void): void;
  onClose(listener: () => void): void;
}

/** `ws` hands a message as a Buffer, a Buffer list, or an ArrayBuffer depending on fragmentation. */
export function rawDataToBuffer(data: RawData): Buffer {
  return Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
}

export function socketFromWebSocket(ws: WebSocket): ConnectionSocket {
  return {
    send: (frame) =>
      new Promise<void>((resolve, reject) => {
        ws.send(frame, (error) => (error === undefined || error === null ? resolve() : reject(error)));
      }),
    close: (code, reason) => {
      // The close handshake needs the peer's reply frame read, so a paused socket resumes first.
      ws.resume();
      if (ws.readyState === ws.OPEN) ws.close(code, reason);
      // Resolve once the close frame has gone out and the socket closed; a peer that never answers
      // (or a backpressured write) is terminated after the grace so the exit path stays bounded.
      return new Promise<void>((resolve) => {
        if (ws.readyState === ws.CLOSED) {
          resolve();
          return;
        }
        // The terminate ends in the same `close` event, so the promise settles once the
        // socket really is closed rather than when the cut was requested.
        const timer = setTimeout(() => ws.terminate(), SOCKET_CLOSE_GRACE_MS);
        timer.unref();
        ws.once('close', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
    pause: () => ws.pause(),
    resume: () => ws.resume(),
    onMessage: (listener) =>
      ws.on('message', (data, isBinary) => {
        const bytes = rawDataToBuffer(data);
        listener(isBinary ? bytes : bytes.toString('utf8'), isBinary);
      }),
    onClose: (listener) => ws.on('close', listener),
  };
}

/**
 * One connection's lifecycle: `awaitingLogin` (hello already on the wire) → `attached` once a
 * login succeeds. Inbound frames are handled strictly one at a time — the socket is paused while
 * a handler runs and resumed after — so a handler that awaits Postgres never interleaves with the
 * next frame, and a client cannot accumulate frames server-side beyond what one TCP chunk holds.
 */
export class ConnectionActor {
  readonly outbox: ConnectionOutbox;
  state: ConnectionState = { kind: 'awaitingLogin' };
  private readonly dependencies: ConnectionDependencies;
  private readonly logger: Logger;
  private loopEnd: ((decision: CloseDecision | 'peerClosed') => void) | undefined;
  /** The drain running a handler right now; awaited before teardown so a close mid-login cannot outrun it. */
  private inflight: Promise<void> = Promise.resolve();
  /** Resolves once the exit path has finished, so a shutdown drain can wait for it. */
  private readonly exited: Promise<void>;
  private markExited: () => void = () => {};
  private started = false;

  constructor(dependencies: ConnectionDependencies) {
    this.dependencies = dependencies;
    this.logger = dependencies.logger;
    this.outbox = new ConnectionOutbox(dependencies.outboxHighWatermark);
    this.exited = new Promise((resolve) => {
      this.markExited = resolve;
    });
  }

  /** Drives one gameplay socket from accept to teardown; resolves once the socket is closed. */
  async runConnection(socket: ConnectionSocket): Promise<void> {
    this.started = true;
    try {
      await this.driveConnection(socket);
    } finally {
      this.markExited();
    }
  }

  private async driveConnection(socket: ConnectionSocket): Promise<void> {
    this.logger.info('connection opened');
    const writer = this.runWriter(socket);
    this.sendHello();
    const ended = await this.runInboundLoop(socket);
    // A peer close resolves the loop while a handler may still be awaiting Postgres; a login that
    // completed after cleanup would attach a phantom player nothing can detach.
    await this.inflight;
    const attachedAs = this.state.kind === 'attached' ? this.state.sectorName : undefined;
    await this.snapshotAndCleanup(true);
    this.outbox.finish();
    await writer;
    this.logger.info(
      {
        reason: ended === 'peerClosed' ? 'peer closed' : ended.kind === 'keepOpen' ? 'server closed' : ended.reason,
        sector: attachedAs,
      },
      'connection closed',
    );
    if (ended === 'peerClosed') return;
    if (ended.kind === 'keepOpen') await socket.close(CLOSE_GOING_AWAY, 'connection closed');
    else await socket.close(ended.code, ended.reason);
  }

  /**
   * Inbound sequencing. Frames `ws` already parsed from one chunk before the pause are held in
   * `pending` and drained in order under the same rule; the queue is discarded on close.
   */
  private runInboundLoop(socket: ConnectionSocket): Promise<CloseDecision | 'peerClosed'> {
    return new Promise((resolve) => {
      const pending: { data: string | Uint8Array; isBinary: boolean }[] = [];
      let draining = false;
      let ended = false;
      const end = (outcome: CloseDecision | 'peerClosed') => {
        if (ended) return;
        ended = true;
        pending.length = 0;
        this.loopEnd = undefined;
        resolve(outcome);
      };
      this.loopEnd = end;
      const drain = async () => {
        if (draining || ended) return;
        draining = true;
        socket.pause();
        while (!ended) {
          const next = pending.shift();
          if (next === undefined) break;
          const decision = await this.handleInbound(next.data, next.isBinary);
          if (decision.kind === 'close') {
            end(decision);
            break;
          }
        }
        draining = false;
        if (!ended) socket.resume();
      };
      socket.onMessage((data, isBinary) => {
        if (ended) return;
        pending.push({ data, isBinary });
        if (!draining) this.inflight = drain();
      });
      socket.onClose(() => end('peerClosed'));
    });
  }

  private async runWriter(socket: ConnectionSocket): Promise<void> {
    for await (const frame of this.outbox) {
      try {
        await socket.send(frame);
        this.outbox.recordWrite();
      } catch {
        // A rejected send (the peer gone mid-write, or the socket cut) ends the writer; the
        // inbound loop tears the connection down.
        break;
      }
    }
    if (this.outbox.overflowed) void socket.close(CLOSE_POLICY_VIOLATION, 'outbox overflow');
  }

  /** An admin kick releases the loop; teardown belongs to `runConnection`'s exit path. */
  disconnectForAdminKick(): void {
    this.loopEnd?.({ kind: 'keepOpen' });
  }

  /**
   * Shutdown drain: end the inbound loop and wait for the exit path — which snapshots after the
   * in-flight handler, broadcasts `leave`, flushes the outbox, and completes the 1001 close
   * handshake — so the server's terminate sweep right after finds nothing left to cut short. A
   * running connection is not snapshotted here: a snapshot taken before the loop ended could be
   * overtaken by a handler (a portal hop) that attaches the player elsewhere after it. The wait
   * is capped so a socket whose writes have stalled cannot hold shutdown short of the terminate
   * that frees it.
   */
  async drainForShutdown(capMs = SHUTDOWN_DRAIN_CAP_MS): Promise<void> {
    if (!this.started) {
      await this.snapshotAndCleanup(true);
      this.outbox.finish();
      return;
    }
    this.loopEnd?.({ kind: 'keepOpen' });
    await Promise.race([this.exited, delay(capMs, undefined, { ref: false })]);
  }

  private async handleInbound(data: string | Uint8Array, isBinary: boolean): Promise<CloseDecision> {
    if (isBinary) return this.protocolErrorClose('binary frames are not part of the wire protocol', 0);
    const text = data as string;
    let decoded: SomnioMessage;
    try {
      decoded = decodeSomnioMessage(text);
    } catch (error) {
      return this.protocolErrorClose(String(error), Buffer.byteLength(text, 'utf8'));
    }
    try {
      return await this.dispatch(decoded);
    } catch (error) {
      this.logger.warn({ error: String(error), frame_size: Buffer.byteLength(text, 'utf8') }, 'decoded frame handler threw');
      return { kind: 'close', code: CLOSE_PROTOCOL_ERROR, reason: FRAME_VALIDATION_FAILED };
    }
  }

  /** The reason can embed attacker-controlled data: the log gets a truncated copy, the wire a fixed one. */
  private protocolErrorClose(reason: string, frameSize: number): CloseDecision {
    this.logger.error({ error: reason.slice(0, 256), frame_size: frameSize }, FRAME_VALIDATION_FAILED);
    return { kind: 'close', code: CLOSE_PROTOCOL_ERROR, reason: FRAME_VALIDATION_FAILED };
  }

  /** The state table: which tags each state accepts; anything else closes 1002. */
  async dispatch(message: SomnioMessage): Promise<CloseDecision> {
    const state = this.state;
    if (state.kind === 'awaitingLogin') {
      switch (message.tag) {
        case 'login':
          await handleLogin(message.payload, this, this.dependencies);
          return { kind: 'keepOpen' };
        case 'register':
          await handleRegister(message.payload, this, this.dependencies);
          return { kind: 'keepOpen' };
        // Redemption is an alternative to a password login, so it is accepted only before login.
        case 'redeemSession':
          await handleRedeem(message.payload, this, this.dependencies);
          return { kind: 'keepOpen' };
        case 'clientPosition':
        case 'clientSay':
        case 'equipToggle':
        case 'bumpNPC':
        case 'enterPortal':
        case 'revokeSession':
        case 'hello':
        case 'loginResult':
        case 'registerResult':
        case 'enterSector':
        case 'mainCharacter':
        case 'entity':
        case 'serverPosition':
        case 'serverSay':
        case 'energy':
        case 'dateTick':
        case 'inventory':
        case 'leave':
        case 'adminSay':
        case 'sessionToken':
        case 'sessionRevoked':
          return this.protocolErrorClose('unexpected tag before login', 0);
      }
    }
    switch (message.tag) {
      case 'clientPosition':
        handlePosition(message.payload, state.entityIndex, state.sectorName, this.dependencies);
        return { kind: 'keepOpen' };
      case 'clientSay':
        handleSay(message.payload, state.entityIndex, state.sectorName, this.dependencies);
        return { kind: 'keepOpen' };
      case 'equipToggle':
        handleEquipToggle(message.payload, state.entityIndex, state.sectorName, this.outbox, this.dependencies);
        return { kind: 'keepOpen' };
      case 'bumpNPC':
        handleBumpNPC(message.payload, state.entityIndex, state.sectorName, this.dependencies);
        return { kind: 'keepOpen' };
      case 'enterPortal': {
        const outcome = handleEnterPortal(message.payload, state.entityIndex, state.sectorName, this, this.dependencies);
        if (outcome === PORTAL_LOST) {
          // Nothing to snapshot or detach: the player is in no sector, so the exit path must
          // not run against the released index.
          this.dependencies.worldRouter.unregister(state.accountId);
          this.state = { kind: 'awaitingLogin' };
          return { kind: 'close', code: CLOSE_GOING_AWAY, reason: 'connection closed' };
        }
        if (outcome !== undefined) this.setAttached(outcome.entityIndex, outcome.sectorName);
        return { kind: 'keepOpen' };
      }
      // Revocation is accepted only while attached; the connection's own account scopes the delete.
      case 'revokeSession':
        await handleRevoke(message.payload, state.accountId, this, this.dependencies);
        return { kind: 'keepOpen' };
      case 'login':
      case 'register':
      case 'redeemSession':
        return this.protocolErrorClose('login/register after attach', 0);
      case 'hello':
      case 'loginResult':
      case 'registerResult':
      case 'enterSector':
      case 'mainCharacter':
      case 'entity':
      case 'serverPosition':
      case 'serverSay':
      case 'energy':
      case 'dateTick':
      case 'inventory':
      case 'leave':
      case 'adminSay':
      case 'sessionToken':
      case 'sessionRevoked':
        return this.protocolErrorClose('server-only tag from client', 0);
    }
  }

  markAttached(entityIndex: number, sectorName: string, accountId: string): void {
    this.state = { kind: 'attached', entityIndex, sectorName, accountId };
  }

  /** After a portal hop the sector-local index must replace the source sector's. */
  setAttached(entityIndex: number, sectorName: string): void {
    if (this.state.kind === 'attached') {
      this.state = { kind: 'attached', entityIndex, sectorName, accountId: this.state.accountId };
    }
  }

  private sendHello(): void {
    this.outbox.sendEncoded({ tag: 'hello', payload: { protocolVersion: SOMNIO_PROTOCOL_CONSTANTS.helloVersion } }, this.logger);
  }

  private async snapshotAndCleanup(leftGame: boolean): Promise<void> {
    const state = this.state;
    if (state.kind !== 'attached') return;
    const sector = this.dependencies.worldRouter.sector(state.sectorName);
    if (sector !== undefined) {
      const snapshot = sector.snapshotForPlayer(state.entityIndex);
      if (snapshot !== undefined) {
        await persistPlayerCheckpoint(snapshot, this.dependencies.characters, this.logger, {
          origin: 'disconnect',
          sector: state.sectorName,
        });
      }
      sector.detach(state.entityIndex, leftGame);
    }
    this.dependencies.worldRouter.unregister(state.accountId);
    this.state = { kind: 'awaitingLogin' };
  }
}
