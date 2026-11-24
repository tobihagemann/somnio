import { describe, expect, it } from 'vitest';
import { hashPassword, verifyAccountPassword, verifyPassword } from '../src/auth/passwordHasher.ts';

async function elapsed(run: () => Promise<unknown>): Promise<number> {
  const start = performance.now();
  await run();
  return performance.now() - start;
}

describe('password hasher', () => {
  it('hashes and verifies a round trip', async () => {
    const encoded = await hashPassword('hunter2');
    expect(await verifyPassword('hunter2', encoded)).toBe(true);
  });

  it('rejects a wrong password against a valid PHC string', async () => {
    const encoded = await hashPassword('hunter2');
    expect(await verifyPassword('hunter3', encoded)).toBe(false);
  });

  it('throws on a malformed PHC string', async () => {
    await expect(verifyPassword('hunter2', '$argon2id$not-a-real-hash')).rejects.toThrow();
  });

  it('encodes with the OWASP-tier parameters', async () => {
    const encoded = await hashPassword('hunter2');
    // segments: ["argon2id", "v=19", "<m,t,p in the library's order>", "<salt>", "<hash>"]
    const segments = encoded.split('$').filter((segment) => segment.length > 0);
    expect(segments).toHaveLength(5);
    expect(segments[0]).toBe('argon2id');
    expect(segments[1]).toBe('v=19');
    expect(new Set(segments[2]!.split(','))).toEqual(new Set(['m=19456', 't=2', 'p=1']));
  });

  it('salts every hash freshly', async () => {
    // A static or repeated salt would silently weaken every stored hash without changing any
    // other assertion in this suite.
    expect(await hashPassword('hunter2')).not.toBe(await hashPassword('hunter2'));
  });

  it('verifies an account password against its hash', async () => {
    const encoded = await hashPassword('hunter2');
    expect(await verifyAccountPassword('hunter2', encoded)).toBe(true);
  });

  it('pays comparable Argon2 cost for an unknown account', async () => {
    // The unknown-account branch exists to equalize timing; a regression that early-returns
    // `false` would turn `verifyAccountPassword` back into a username-existence oracle, telling an
    // unknown account from a known one given the wrong password. Wall-time assertions are jittery,
    // so the sentinel is "a non-trivial fraction of the known account's cost", taken on each
    // branch's fastest of several interleaved samples. Load on a busy machine only ever adds time,
    // so the minimum is the closest a sample gets to the branch's own cost.
    const encoded = await hashPassword('hunter2');
    expect(await verifyAccountPassword('anything', undefined)).toBe(false);
    const knownSamples: number[] = [];
    const unknownSamples: number[] = [];
    for (let sample = 0; sample < 5; sample += 1) {
      knownSamples.push(await elapsed(() => verifyAccountPassword('wrong', encoded)));
      unknownSamples.push(await elapsed(() => verifyAccountPassword('anything', undefined)));
    }

    expect(Math.min(...unknownSamples)).toBeGreaterThanOrEqual(Math.min(...knownSamples) / 2);
  });
});
