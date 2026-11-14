import { describe, expect, it } from 'vitest';
import { Departures } from '../src/world/departures.ts';
import { NO_TRANSIENT } from '../src/world/spaceActor.ts';
import type { PlayerTransient } from '../src/world/spaceActor.ts';

function ledger() {
  const clock = { ms: 0 };
  return { clock, departures: new Departures(() => clock.ms) };
}

describe('Departures', () => {
  it('gives a returning dreamer their timers shortened by the time away, none below nothing', () => {
    const { clock, departures } = ledger();
    departures.leave('dreamer', { ...NO_TRANSIENT, globalSeconds: 0.75, swingSeconds: 1, mendSeconds: 0.875, runningSeconds: 0.25 });
    clock.ms = 500;
    expect(departures.takeReturning('dreamer')).toEqual({
      ...NO_TRANSIENT,
      globalSeconds: 0.25,
      swingSeconds: 0.5,
      mendSeconds: 0.375,
      runningSeconds: 0,
      awaySeconds: 0.5,
    });
  });

  it('forgets, at a later departure, a dreamer who would come back as a first join would', () => {
    const { clock, departures } = ledger();
    departures.leave('settled', { ...NO_TRANSIENT, swingSeconds: 1 });
    departures.leave('waiting', { ...NO_TRANSIENT, swingSeconds: 2 });
    clock.ms = 1500;
    departures.leave('other', NO_TRANSIENT);
    expect(departures.takeReturning('settled')).toEqual(NO_TRANSIENT);
    expect(departures.takeReturning('waiting')).toEqual({ ...NO_TRANSIENT, swingSeconds: 0.5, awaySeconds: 1.5 });
  });

  /** Each leaves one thing running for 2 s or more: what a first join would not have. */
  const stillRunning: [string, Partial<PlayerTransient>][] = [
    ['an effect', { effects: [{ effectId: 'warded', seconds: 2, sourceId: 'healer', rank: 1, shield: 12 }] }],
    ['a cooldown', { cooldowns: [{ abilityId: 'brace', seconds: 2 }] }],
    ['the global cooldown', { globalSeconds: 2 }],
    ['the touch', { mendSeconds: 2 }],
    ['a running hold', { runningSeconds: 2 }],
    ['a spent allowance', { allowance: 0 }],
    ['a spent pace credit', { paceCredit: 0 }],
  ];

  it.each(stillRunning)('keeps, through a later departure, a dreamer who left %s running', (_, running) => {
    const { clock, departures } = ledger();
    departures.leave('dreamer', { ...NO_TRANSIENT, ...running });
    clock.ms = 1500;
    departures.leave('other', NO_TRANSIENT);
    expect(departures.takeReturning('dreamer').awaySeconds).toBe(1.5);
  });

  /** The time away refills a spent allowance in 2 s and a spent pace credit in 6 s, as `attach` refills them, and not before. */
  it.each([
    ['a spent allowance', { allowance: 0 }, 2000],
    ['a spent pace credit', { paceCredit: 0 }, 6000],
  ] as const)('forgets a dreamer who left %s only once the time away has refilled it', (_, spent, refilledMs) => {
    const { clock, departures } = ledger();
    departures.leave('early', { ...NO_TRANSIENT, ...spent });
    clock.ms = refilledMs - 100;
    departures.leave('other', NO_TRANSIENT);
    expect(departures.takeReturning('early').awaySeconds).toBe((refilledMs - 100) / 1000);
    departures.leave('late', { ...NO_TRANSIENT, ...spent });
    clock.ms += refilledMs + 100;
    departures.leave('other', NO_TRANSIENT);
    expect(departures.takeReturning('late')).toEqual(NO_TRANSIENT);
  });
});
