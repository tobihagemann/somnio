import { NO_TRANSIENT, settledAfterSeconds } from './spaceActor.ts';
import type { PlayerTransient } from './spaceActor.ts';

interface Departure {
  transient: PlayerTransient;
  leftAt: number;
  /** When the dreamer would come back as a first join would, so the entry can go. */
  settledAt: number;
}

/**
 * What each dreamer carried as they left the world, by character id, so a reconnect resumes it
 * rather than starting afresh. One ledger serves every space. An entry goes when its dreamer
 * returns, or at the first departure after its dreamer would come back as a first join would, so
 * dreamers who never return do not pile up. A restart forgets them all.
 */
export class Departures {
  private readonly byCharacter = new Map<string, Departure>();
  private readonly now: () => number;

  constructor(now: () => number) {
    this.now = now;
  }

  leave(characterId: string, transient: PlayerTransient): void {
    const now = this.now();
    for (const [settled, departure] of this.byCharacter) if (departure.settledAt <= now) this.byCharacter.delete(settled);
    this.byCharacter.set(characterId, { transient, leftAt: now, settledAt: now + settledAfterSeconds(transient) * 1000 });
  }

  /**
   * What the dreamer left with, run on by the time away: every timer and effect is that much
   * shorter, and one run out is gone. A heal over time keeps when it next gives health, counted
   * from the return, so no tick that fell due while away is paid. The allowance and the pace credit
   * refill on arrival by `awaySeconds`.
   */
  takeReturning(characterId: string): PlayerTransient {
    const departure = this.byCharacter.get(characterId);
    if (departure === undefined) return NO_TRANSIENT;
    this.byCharacter.delete(characterId);
    const { transient } = departure;
    const away = (this.now() - departure.leftAt) / 1000;
    const left = (seconds: number): number => Math.max(0, seconds - away);
    return {
      effects: transient.effects.flatMap((held) => (held.seconds > away ? [{ ...held, seconds: held.seconds - away }] : [])),
      globalSeconds: left(transient.globalSeconds),
      cooldowns: transient.cooldowns.flatMap((cooldown) => (cooldown.seconds > away ? [{ ...cooldown, seconds: cooldown.seconds - away }] : [])),
      swingSeconds: left(transient.swingSeconds),
      mendSeconds: left(transient.mendSeconds),
      runningSeconds: left(transient.runningSeconds),
      allowance: transient.allowance,
      paceCredit: transient.paceCredit,
      awaySeconds: away,
    };
  }
}
