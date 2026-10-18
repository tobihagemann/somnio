import { describe, expect, it } from 'vitest';
import { SocketAdmission } from '../src/connection/socketAdmission.ts';
import type { SocketRefusal, SocketReservation } from '../src/connection/socketAdmission.ts';
import { recordingLogger } from './support/logger.ts';

const ADDRESS = '203.0.113.7';
const OTHER = '203.0.113.8';
const SECOND = 1000;

function makeAdmission(perAddress = 2, total = 3) {
  const clock = { ms: 0 };
  const { logger, records } = recordingLogger();
  const admission = new SocketAdmission({ perAddressEnabled: true, perAddress, total, logger, now: () => clock.ms });
  return { admission, clock, records };
}

function reserved(outcome: SocketReservation | SocketRefusal): SocketReservation {
  if (typeof outcome === 'string') throw new Error(`refused: ${outcome}`);
  return outcome;
}

describe('SocketAdmission slots', () => {
  it('refuses an address at its share and the server at its total', () => {
    const { admission } = makeAdmission();
    reserved(admission.reserve(ADDRESS));
    reserved(admission.reserve(ADDRESS));
    expect(admission.reserve(ADDRESS)).toBe('addressFull');
    reserved(admission.reserve(OTHER));
    expect(admission.reserve(OTHER)).toBe('serverFull');
  });

  /** A slot is released on attach and again when the connection ends; counting both would lift both caps. */
  it('frees one slot however often a reservation is released', () => {
    const { admission } = makeAdmission();
    const first = reserved(admission.reserve(ADDRESS));
    reserved(admission.reserve(ADDRESS));
    first.release();
    first.release();
    reserved(admission.reserve(ADDRESS));
    expect(admission.reserve(ADDRESS)).toBe('addressFull');
    reserved(admission.reserve(OTHER));
    expect(admission.reserve(OTHER)).toBe('serverFull');
  });

  it('gives an address back one slot per release, not its whole share', () => {
    const { admission } = makeAdmission(2, 8);
    const first = reserved(admission.reserve(ADDRESS));
    reserved(admission.reserve(ADDRESS));
    first.release();
    reserved(admission.reserve(ADDRESS));
    expect(admission.reserve(ADDRESS)).toBe('addressFull');
  });

  it('counts only the total with per-address counting off', () => {
    const { logger } = recordingLogger();
    const admission = new SocketAdmission({ perAddressEnabled: false, perAddress: 1, total: 2, logger });
    reserved(admission.reserve(ADDRESS));
    reserved(admission.reserve(ADDRESS));
    expect(admission.reserve(ADDRESS)).toBe('serverFull');
  });
});

describe('SocketAdmission refusal records', () => {
  function refusals(records: Record<string, unknown>[]) {
    return records.filter((record) => record['msg'] === 'gameplay upgrade refused');
  }

  it('logs each reason at most once a minute, naming the address only for a full address', () => {
    const { admission, clock, records } = makeAdmission(1, 2);
    reserved(admission.reserve(ADDRESS));
    for (let attempt = 0; attempt < 5; attempt += 1) admission.reserve(ADDRESS);
    reserved(admission.reserve(OTHER));
    for (let attempt = 0; attempt < 3; attempt += 1) admission.reserve('203.0.113.9');
    expect(refusals(records)).toMatchObject([
      { level: 40, reason: 'addressFull', address: ADDRESS, suppressed_since_last: 0 },
      { level: 40, reason: 'serverFull', suppressed_since_last: 0 },
    ]);
    expect(refusals(records)[1]).not.toHaveProperty('address');

    clock.ms = 61 * SECOND;
    admission.reserve('203.0.113.9');
    expect(refusals(records).at(-1)).toMatchObject({ reason: 'serverFull', suppressed_since_last: 2 });
  });

  /** A shared window would name whichever address opened it next with every other address's count. */
  it('counts the refusals of each address against that address alone', () => {
    const { admission, clock, records } = makeAdmission(1, 8);
    reserved(admission.reserve(ADDRESS));
    reserved(admission.reserve(OTHER));
    for (let attempt = 0; attempt < 5; attempt += 1) admission.reserve(ADDRESS);
    admission.reserve(OTHER);
    clock.ms = 61 * SECOND;
    admission.reserve(ADDRESS);
    expect(refusals(records)).toMatchObject([
      { address: ADDRESS, suppressed_since_last: 0 },
      { address: OTHER, suppressed_since_last: 0 },
      { address: ADDRESS, suppressed_since_last: 4 },
    ]);
  });
});
