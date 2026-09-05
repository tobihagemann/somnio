import { describe, expect, it } from 'vitest';
import { DEV_ADMIN_TOKEN, DEV_ADMIN_URL, ValidationError, resolveAdminConnection } from '../src/resolver.ts';

describe('resolveAdminConnection', () => {
  it('the flag wins over the environment for the URL', () => {
    const resolved = resolveAdminConnection('wss://flag.example/admin', {
      SOMNIO_ADMIN_URL: 'wss://env.example/admin',
      SOMNIO_ADMIN_TOKEN: 'env-token',
    });
    expect(resolved).toEqual({ url: 'wss://flag.example/admin', token: 'env-token' });
  });

  it('the environment supplies both URL and token when no flag is set', () => {
    const resolved = resolveAdminConnection(undefined, {
      SOMNIO_ADMIN_URL: 'wss://env.example/admin',
      SOMNIO_ADMIN_TOKEN: 'env-token',
    });
    expect(resolved).toEqual({ url: 'wss://env.example/admin', token: 'env-token' });
  });

  it('wss URLs are accepted regardless of host', () => {
    expect(resolveAdminConnection('wss://prod.example/admin', { SOMNIO_ADMIN_TOKEN: 'tok' }).url).toBe('wss://prod.example/admin');
  });

  it('loopback plaintext URLs are accepted', () => {
    expect(resolveAdminConnection('ws://127.0.0.1:8080/admin', { SOMNIO_ADMIN_TOKEN: 'tok' }).url).toBe('ws://127.0.0.1:8080/admin');
  });

  it.each([
    ['userinfo', 'ws://attacker.example:80@localhost/admin', 'must not embed'],
    ['non-loopback plaintext', 'ws://prod.example/admin', 'plaintext ws://'],
    ['non-ws scheme', 'http://prod.example/admin', 'ws:// or wss://'],
    ['uppercase WSS scheme', 'WSS://prod.example/admin', 'lowercase'],
    ['uppercase WS scheme', 'WS://127.0.0.1:8080/admin', 'lowercase'],
    ['unparseable URL', '', 'not a valid URL'],
  ])('rejects a %s URL with a ValidationError', (_label, url, fragment) => {
    let caught: unknown;
    try {
      resolveAdminConnection(url, { SOMNIO_ADMIN_TOKEN: 'tok' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect((caught as Error).message).toContain(fragment);
  });

  it('falls back to the loopback dev defaults when the environment is empty', () => {
    expect(resolveAdminConnection(undefined, {})).toEqual({ url: DEV_ADMIN_URL, token: DEV_ADMIN_TOKEN });
  });

  it('refuses the dev token for a non-loopback URL', () => {
    let caught: unknown;
    try {
      resolveAdminConnection('wss://prod.example/admin', {});
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect((caught as Error).message).toBe('SOMNIO_ADMIN_TOKEN environment variable is required.');
  });

  it('falls back to the dev token for a loopback URL', () => {
    expect(resolveAdminConnection('ws://localhost:8080/admin', {}).token).toBe(DEV_ADMIN_TOKEN);
  });

  /** The server treats an empty `SOMNIO_ADMIN_TOKEN` as missing; the CLI reads it the same way. */
  it('an empty token counts as unset', () => {
    expect(resolveAdminConnection('ws://localhost:8080/admin', { SOMNIO_ADMIN_TOKEN: '' }).token).toBe(DEV_ADMIN_TOKEN);
    expect(() => resolveAdminConnection('wss://prod.example/admin', { SOMNIO_ADMIN_TOKEN: '' })).toThrow(
      'SOMNIO_ADMIN_TOKEN environment variable is required.',
    );
  });

  it('falls back to the dev URL when only the token is configured', () => {
    expect(resolveAdminConnection(undefined, { SOMNIO_ADMIN_TOKEN: 'tok' })).toEqual({
      url: DEV_ADMIN_URL,
      token: 'tok',
    });
  });
});
