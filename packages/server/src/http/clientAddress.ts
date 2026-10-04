import type { IncomingMessage } from 'node:http';
import { SocketAddress, isIP } from 'node:net';

const MAPPED_IPV4_PREFIX = '::ffff:';

/**
 * The address a connection's pre-login attempts are counted against, or `undefined` when there is
 * none, as on a socket that is already destroyed. Behind a trusted proxy it is the last
 * `X-Forwarded-For` entry, the one the proxy appended itself: every entry before it is the
 * client's to choose. A last entry that is not an address falls back to the socket's.
 */
export function resolveClientAddress(request: IncomingMessage, trustProxy: boolean): string | undefined {
  return (trustProxy ? forwardedKey(request) : undefined) ?? addressKey(request.socket.remoteAddress);
}

function forwardedKey(request: IncomingMessage): string | undefined {
  const header = request.headers['x-forwarded-for'];
  return typeof header === 'string' ? addressKey(header.split(',').at(-1)!.trim()) : undefined;
}

/**
 * An IPv4 address is its own key, whether it arrived dotted or as an IPv4-mapped IPv6 address.
 * Every other IPv6 address is keyed on its /64, the smallest block a client is handed, so one
 * client cannot draw a budget per address. Anything else has no key.
 */
function addressKey(address: string | undefined): string | undefined {
  if (address === undefined) return undefined;
  const family = isIP(address);
  if (family === 0) return undefined;
  if (family === 4) return address;
  const canonical = canonicalIPv6(address);
  if (canonical === undefined) return undefined;
  if (canonical.startsWith(MAPPED_IPV4_PREFIX) && isIP(canonical.slice(MAPPED_IPV4_PREFIX.length)) === 4) {
    return canonical.slice(MAPPED_IPV4_PREFIX.length);
  }
  return `${leadingGroups(canonical).join(':')}::/64`;
}

/**
 * Node's own canonical text for an IPv6 address `net.isIP` accepted. The zone id is cut off first:
 * with one, the parser reads only the first 39 characters of the address, which turns a long
 * dotted tail into a different address or into one it throws on.
 */
function canonicalIPv6(address: string): string | undefined {
  try {
    return new SocketAddress({ address: address.split('%')[0]!, family: 'ipv6' }).address;
  } catch {
    // Not known to happen without a zone id. Uncaught, it would leave the `upgrade` listener and
    // exit the process.
    return undefined;
  }
}

/** The first four of an IPv6 address's eight groups, with its `::` expanded. */
function leadingGroups(canonical: string): string[] {
  const [head = '', tail] = canonical.split('::');
  const leading = head === '' ? [] : head.split(':');
  if (tail === undefined) return leading.slice(0, 4);
  const trailing = tail === '' ? [] : tail.split(':');
  // Node writes a dotted tail (`::1.2.3.4`) only when at least the first five groups are zero, so
  // counting it as one group instead of two cannot change the first four.
  const zeros = Array<string>(8 - leading.length - trailing.length).fill('0');
  return [...leading, ...zeros, ...trailing].slice(0, 4);
}
