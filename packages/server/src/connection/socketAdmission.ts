import type { Logger } from '../logging.ts';
import { LogThrottle } from './logThrottle.ts';

/** A gameplay socket's place among those not yet logged in. */
export interface SocketReservation {
  /** Idempotent: a second release frees nothing more. */
  release(): void;
}

export type SocketRefusal = 'addressFull' | 'serverFull';

export interface SocketAdmissionOptions {
  /** Whether each address is capped as well as the server. */
  perAddressEnabled: boolean;
  perAddress: number;
  total: number;
  logger: Logger;
  /** Monotonic milliseconds. */
  now?: () => number;
}

/**
 * Bounds the gameplay sockets that have not logged in, in total and per client address, so a
 * flood of idle sockets cannot hold unbounded actors and outboxes. A socket holds its slot from
 * its upgrade until it logs in or its connection has ended.
 */
export class SocketAdmission {
  private readonly perAddressEnabled: boolean;
  private readonly perAddress: number;
  private readonly total: number;
  private readonly logger: Logger;
  private readonly now: () => number;
  /** Each address's reserved slots, and the throttle on its refusals, so a record's count is that address's own. */
  private readonly byAddress = new Map<string, { count: number; refusalLog: LogThrottle }>();
  private reserved = 0;
  private readonly serverFullLog = new LogThrottle();

  constructor(options: SocketAdmissionOptions) {
    this.perAddressEnabled = options.perAddressEnabled;
    this.perAddress = options.perAddress;
    this.total = options.total;
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
    if (entry !== undefined) entry.count += 1;
    else if (key !== undefined) this.byAddress.set(key, { count: 1, refusalLog: new LogThrottle() });
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.reserved -= 1;
        if (key === undefined) return;
        const held = this.byAddress.get(key)!;
        held.count -= 1;
        if (held.count === 0) this.byAddress.delete(key);
      },
    };
  }

  private refuse(reason: SocketRefusal, log: LogThrottle, fields: { address?: string }): SocketRefusal {
    const suppressed = log.take(this.now());
    if (suppressed !== undefined) this.logger.warn({ ...fields, reason, suppressed_since_last: suppressed }, 'gameplay upgrade refused');
    return reason;
  }
}
