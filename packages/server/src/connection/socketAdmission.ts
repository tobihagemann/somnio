import type { Logger } from '../logging.ts';
import { LogThrottle } from './logThrottle.ts';

/** A gameplay socket's place among those not yet logged in, and then among those logged in but not yet in the world. */
export interface SocketReservation {
  /**
   * Trades the place among sockets not yet logged in for one among sockets choosing a character.
   * `false` when those are full, in total or for the socket's address; the place held so far is
   * kept until `release`.
   */
  authenticate(): boolean;
  /** Idempotent: a second release frees nothing more. */
  release(): void;
}

export type SocketRefusal = 'addressFull' | 'serverFull';

export interface SocketAdmissionOptions {
  /** Whether each address is capped as well as the server. */
  perAddressEnabled: boolean;
  perAddress: number;
  total: number;
  /** How many sockets one address may hold logged in but not yet in the world. */
  authenticatedPerAddress: number;
  /** How many sockets may be logged in but not yet in the world, whatever their address. */
  authenticated: number;
  logger: Logger;
  /** Monotonic milliseconds. */
  now?: () => number;
}

type AddressCount = { count: number; refusalLog: LogThrottle };

function countIn(counts: Map<string, AddressCount>, key: string): void {
  const entry = counts.get(key);
  if (entry !== undefined) entry.count += 1;
  else counts.set(key, { count: 1, refusalLog: new LogThrottle() });
}

function uncountIn(counts: Map<string, AddressCount>, key: string): void {
  const entry = counts.get(key)!;
  entry.count -= 1;
  if (entry.count === 0) counts.delete(key);
}

/**
 * Bounds the gameplay sockets that have not logged in, in total and per client address, so a
 * flood of idle sockets cannot hold unbounded actors and outboxes. A socket holds its slot from
 * its upgrade until it logs in or its connection has ended. A socket logged in but not yet in the
 * world holds a slot of a second count, in total and per address, because registration is open and
 * accounts can pile up.
 */
export class SocketAdmission {
  private readonly perAddressEnabled: boolean;
  private readonly perAddress: number;
  private readonly total: number;
  private readonly authenticatedPerAddress: number;
  private readonly authenticatedTotal: number;
  private readonly logger: Logger;
  private readonly now: () => number;
  /** Each address's reserved slots, and the throttle on its refusals, so a record's count is that address's own. */
  private readonly byAddress = new Map<string, AddressCount>();
  private readonly authenticatedByAddress = new Map<string, AddressCount>();
  private reserved = 0;
  private authenticated = 0;
  private readonly serverFullLog = new LogThrottle();
  private readonly authenticatedFullLog = new LogThrottle();

  constructor(options: SocketAdmissionOptions) {
    this.perAddressEnabled = options.perAddressEnabled;
    this.perAddress = options.perAddress;
    this.total = options.total;
    this.authenticatedPerAddress = options.authenticatedPerAddress;
    this.authenticatedTotal = options.authenticated;
    this.logger = options.logger;
    this.now = options.now ?? (() => performance.now());
  }

  /** A slot for a socket from `address`, or why there is none. The server's ceiling is checked first. */
  reserve(address: string | undefined): SocketReservation | SocketRefusal {
    const key = this.perAddressEnabled ? address : undefined;
    if (this.reserved >= this.total) return this.refuse('serverFull', this.serverFullLog, {});
    const entry = key === undefined ? undefined : this.byAddress.get(key);
    if (key !== undefined && entry !== undefined && entry.count >= this.perAddress) return this.refuse('addressFull', entry.refusalLog, { address: key });
    this.reserved += 1;
    if (key !== undefined) countIn(this.byAddress, key);
    let held: 'prelogin' | 'authenticated' | 'released' = 'prelogin';
    const releasePrelogin = () => {
      this.reserved -= 1;
      if (key !== undefined) uncountIn(this.byAddress, key);
    };
    return {
      authenticate: () => {
        if (held !== 'prelogin') return held === 'authenticated';
        if (this.authenticated >= this.authenticatedTotal) {
          this.refuse('authenticatedFull', this.authenticatedFullLog, {});
          return false;
        }
        const choosing = key === undefined ? undefined : this.authenticatedByAddress.get(key);
        if (key !== undefined && choosing !== undefined && choosing.count >= this.authenticatedPerAddress) {
          this.refuse('authenticatedAddressFull', choosing.refusalLog, { address: key });
          return false;
        }
        releasePrelogin();
        this.authenticated += 1;
        if (key !== undefined) countIn(this.authenticatedByAddress, key);
        held = 'authenticated';
        return true;
      },
      release: () => {
        if (held === 'prelogin') releasePrelogin();
        else if (held === 'authenticated') {
          this.authenticated -= 1;
          if (key !== undefined) uncountIn(this.authenticatedByAddress, key);
        }
        held = 'released';
      },
    };
  }

  private refuse<Reason extends SocketRefusal | 'authenticatedFull' | 'authenticatedAddressFull'>(
    reason: Reason,
    log: LogThrottle,
    fields: { address?: string },
  ): Reason {
    const suppressed = log.take(this.now());
    if (suppressed !== undefined) this.logger.warn({ ...fields, reason, suppressed_since_last: suppressed }, 'gameplay socket refused');
    return reason;
  }
}
