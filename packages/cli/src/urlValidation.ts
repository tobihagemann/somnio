export type SecureTransportValidationErrorKind = 'invalidURL' | 'unsupportedScheme' | 'insecureRemoteURL' | 'userinfoNotAllowed';

/** A candidate WebSocket URL that would carry the bearer over plaintext or otherwise fails the gate. */
export class SecureTransportValidationError extends Error {
  readonly kind: SecureTransportValidationErrorKind;

  constructor(kind: SecureTransportValidationErrorKind) {
    super(kind);
    this.name = 'SecureTransportValidationError';
    this.kind = kind;
  }
}

/**
 * Exact hostnames whose loopback semantics make plaintext `ws://` acceptable and the dev token
 * usable. No bracketed IPv6 form: `validate` rejects `[`/`]` in the authority outright.
 */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1']);

/** Whether a parseable `url` names a loopback host. */
export function isLoopbackURL(url: string): boolean {
  return LOOPBACK_HOSTS.has(new URL(url).hostname.toLowerCase());
}

/**
 * The URL gate applied before any admin dial: a lowercase `ws`/`wss` scheme only, `ws://`
 * only against the loopback set, no userinfo (a `ws://attacker@localhost/...` form is what a
 * parser disagreement turns into a credential leak), no bracketed IPv6 literal, and
 * `validateHostAgreement`, so one call is the whole gate.
 */
export function validate(url: string): void {
  // The scheme is checked on the raw text: `URL` lowercases it, and the dialer compares it
  // case-sensitively when deciding whether to enable TLS.
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(url)?.[1] ?? '';
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SecureTransportValidationError('invalidURL');
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw new SecureTransportValidationError('userinfoNotAllowed');
  }
  if (scheme !== 'ws' && scheme !== 'wss') throw new SecureTransportValidationError('unsupportedScheme');
  const authorityHost = rawAuthorityHost(url);
  if (authorityHost.includes('[') || authorityHost.includes(']')) {
    throw new SecureTransportValidationError('invalidURL');
  }
  if (scheme === 'ws' && !isLoopbackURL(url)) {
    throw new SecureTransportValidationError('insecureRemoteURL');
  }
  validateHostAgreement(url);
}

/**
 * Confirms the host a URI parser reads out of the raw authority is the host the URL parser
 * validated, so a percent-encoded or IDN spelling cannot pass `validate` and dial elsewhere; a
 * fragment is rejected outright. Ports are compared on neither side, and case is not: the URL
 * parser ASCII-lowercases a domain, so the raw side is lowered before the comparison.
 */
export function validateHostAgreement(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SecureTransportValidationError('invalidURL');
  }
  if (url.includes('#') || parsed.hash.length > 0) throw new SecureTransportValidationError('invalidURL');
  if (parsed.hostname !== rawAuthorityHost(url).toLowerCase()) throw new SecureTransportValidationError('invalidURL');
}

/** The host token of the raw authority: after `//` and any userinfo, before the port, path, query, or fragment. */
function rawAuthorityHost(url: string): string {
  const afterScheme = url.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//, '');
  const authority = afterScheme.split(/[/?#]/, 1)[0] ?? '';
  const withoutUserinfo = authority.slice(authority.lastIndexOf('@') + 1);
  if (withoutUserinfo.startsWith('[')) {
    const end = withoutUserinfo.indexOf(']');
    return end === -1 ? withoutUserinfo : withoutUserinfo.slice(0, end + 1);
  }
  return withoutUserinfo.split(':', 1)[0] ?? '';
}
