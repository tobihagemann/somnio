/**
 * The gameplay endpoint.
 *
 * Production derives it from the page origin, which the same-origin hosting decision
 * guarantees: the client is served from the same host that terminates TLS in front of `/ws`.
 * That removes a whole class of problems — no CORS, no cross-origin WebSocket, and browser TLS
 * trust already covers the certificate, so nothing is pinned.
 *
 * Development does **not** share an origin (Vite serves the page, the server listens on
 * :17662), which is why `vite.config.ts` proxies `/ws`. Going through the proxy rather than
 * dialing :17662 directly keeps this resolver origin-relative in both environments.
 */
export function resolveGameplayURL(location: { protocol: string; host: string } = window.location): string {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${location.host}/ws`;
}
