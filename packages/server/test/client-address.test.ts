import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { resolveClientAddress } from '../src/http/clientAddress.ts';

const PROXY = '10.0.0.2';

function request(remoteAddress: string | undefined, forwardedFor?: string): IncomingMessage {
  return {
    headers: forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor },
    socket: { remoteAddress },
  } as unknown as IncomingMessage;
}

describe('resolveClientAddress', () => {
  /** Every entry but the last is the client's to write, so the first would let a client pick its own budget. */
  it('takes the last forwarded entry behind a trusted proxy', () => {
    expect(resolveClientAddress(request(PROXY, '198.51.100.7, 203.0.113.9'), true)).toBe('203.0.113.9');
  });

  it('ignores the header without a trusted proxy', () => {
    expect(resolveClientAddress(request(PROXY, '198.51.100.7, 203.0.113.9'), false)).toBe(PROXY);
  });

  it.each([
    ['a missing header', undefined],
    ['a last entry that is not an address', '203.0.113.9, unknown'],
    ['an empty last entry', '203.0.113.9,'],
  ])('falls back to the socket address on %s', (_case, forwardedFor) => {
    expect(resolveClientAddress(request(PROXY, forwardedFor), true)).toBe(PROXY);
  });

  it('has no address for a socket that is already destroyed', () => {
    expect(resolveClientAddress(request(undefined), false)).toBeUndefined();
  });

  /** A dual-stack listener reports an IPv4 client in the mapped form; both spellings are that client. */
  it.each(['::ffff:203.0.113.9', '::ffff:cb00:7109'])('keys the IPv4-mapped %s as its IPv4 address', (mapped) => {
    expect(resolveClientAddress(request(mapped), false)).toBe('203.0.113.9');
    expect(resolveClientAddress(request(PROXY, mapped), true)).toBe('203.0.113.9');
  });

  /** The second address compresses inside its first 64 bits, which splitting the text on `:` gets wrong. */
  it('keys two addresses of one /64 alike, and another /64 apart', () => {
    expect(resolveClientAddress(request('2001:db8::1'), false)).toBe('2001:db8:0:0::/64');
    expect(resolveClientAddress(request('2001:DB8:0:0:ffff::2'), false)).toBe('2001:db8:0:0::/64');
    expect(resolveClientAddress(request('2001:db8:0:1::1'), false)).toBe('2001:db8:0:1::/64');
  });

  it('keys an uncompressed address on its first four groups', () => {
    expect(resolveClientAddress(request('2001:db8:1:2:3:4:5:6'), false)).toBe('2001:db8:1:2::/64');
  });

  it('keys an address Node writes with a dotted tail', () => {
    expect(resolveClientAddress(request('::1.2.3.4'), false)).toBe('0:0:0:0::/64');
  });

  it('drops a zone id', () => {
    expect(resolveClientAddress(request('fe80::1%lo0'), false)).toBe('fe80:0:0:0::/64');
  });

  /** Given the zone id, Node's parser reads 39 characters of the address: the first comes back as 11.2.3.25, and it throws on the second. */
  it('keys a long address by all of it when a zone id follows', () => {
    expect(resolveClientAddress(request(PROXY, '0000:0000:0000:0000:0000:ffff:11.2.3.255%x'), true)).toBe('11.2.3.255');
    expect(resolveClientAddress(request(PROXY, '1111:2222:3333:4444:5555:6666:11.22.33.44%x'), true)).toBe('1111:2222:3333:4444::/64');
  });
});
