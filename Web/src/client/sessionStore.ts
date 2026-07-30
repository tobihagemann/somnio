/**
 * Browser storage for the resumable session token.
 *
 * `localStorage` rather than `sessionStorage`, and gated on the login form's "remember me"
 * box. That mirrors the native client exactly: the Keychain credential is written only when
 * the user ticks "Remember password", so persistence across restarts stays an explicit choice
 * rather than something the browser client does silently. `sessionStorage` would survive a
 * refresh but not a reopened tab, which is not what the native affordance promises.
 *
 * The token is a bearer credential, so the DOM layer must never inject server- or
 * player-originated strings as HTML — an XSS on this origin reads the token straight out of
 * storage. That rule is enforced at the rendering surface, not here.
 */

import { PROTOCOL_BYTE_CAPS, utf8ByteLength } from '@/protocol'
const STORAGE_KEY = 'somnio.sessionToken'

export interface StoredSession {
  token: string
  /** Epoch milliseconds. Advisory only — the server is authoritative on expiry. */
  expiresAt: number
}

export interface SessionStorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export class SessionStore {
  private readonly storage: SessionStorageLike | undefined

  constructor(storage: SessionStorageLike | undefined = safeLocalStorage()) {
    this.storage = storage
  }

  load(): StoredSession | undefined {
    const raw = this.read()
    if (raw === null) return undefined
    try {
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed !== 'object' || parsed === null) return undefined
      const token = (parsed as Record<string, unknown>)['token']
      const expiresAt = (parsed as Record<string, unknown>)['expiresAt']
      if (typeof token !== 'string' || typeof expiresAt !== 'number') return undefined
      // The cap is enforced here, on the way *out* of storage, which is what both sides' constants
      // say it is for: "the browser can refuse a tampered or oversized stored token before spending
      // a round trip on it". Without it an over-cap value reaches `encodeSomnioMessage`, throws
      // `OversizedFrameError` inside `send`, is swallowed with a warning, and strands the client in
      // `awaitingLoginResult` with no overlay and no login form. Treated exactly like corrupt JSON,
      // so the store self-heals to the password path.
      if (utf8ByteLength(token) > PROTOCOL_BYTE_CAPS.sessionToken) {
        this.clear()
        return undefined
      }
      // A locally expired token is dropped rather than presented: the round trip would fail
      // anyway and the user would watch a pointless reconnect before the login form appeared.
      if (expiresAt <= Date.now()) {
        this.clear()
        return undefined
      }
      return { token, expiresAt }
    } catch {
      // Corrupt storage is indistinguishable from no session; clearing keeps it self-healing.
      this.clear()
      return undefined
    }
  }

  /**
   * Persists the token, reporting whether it landed.
   *
   * The Boolean is the browser's analogue of the native `CredentialStore.save` `do`/`catch`
   * (`ClientViewModel.handleLoginResult`), which logs and appends `.credentialSaveFailed` — "Your
   * password could not be saved." The player asked to be remembered by ticking the box, and a silent
   * no-op there is only discovered on the next visit, when they are asked to log in again with no
   * explanation. `false` also covers the no-store case: the constructor already degraded to
   * `undefined`, and "remembered nothing" is the same outcome to the player either way.
   */
  save(token: string, expiresInSeconds: number): boolean {
    const session: StoredSession = { token, expiresAt: Date.now() + expiresInSeconds * 1000 }
    const storage = this.storage
    if (storage === undefined) return false
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(session))
      return true
    } catch {
      return false
    }
  }

  clear(): void {
    // Swallowed rather than reported. Unlike a failed save there is nothing to tell the player —
    // they did not ask for anything — and this runs on the *synchronous* login-submit path
    // (`ConnectionController.connect` clears the store before opening the socket), so an escaping
    // throw aborts `connect` before the transport starts and the Log In button silently does
    // nothing, repeatably. `load`'s own recovery path calls this too, so an unguarded write here
    // would also turn corrupt storage into a thrown error out of `resumeStoredSession`, which runs
    // at module top level through `AppShell` and renders a blank page.
    try {
      this.storage?.removeItem(STORAGE_KEY)
    } catch {
      // Nothing actionable: the token stays until it expires, and the caller has already dropped
      // its in-memory copy.
    }
  }

  /**
   * Reads the stored value, treating an unreadable store as an absent one.
   *
   * The `try` cannot live only in `safeLocalStorage`: that one covers *construction*, and an engine
   * or extension may hand out the object and then reject the individual access — Safari's
   * "Prevent cross-site tracking" does exactly this inside a third-party frame.
   */
  private read(): string | null {
    try {
      return this.storage?.getItem(STORAGE_KEY) ?? null
    } catch {
      return null
    }
  }
}

/**
 * `localStorage` access throws in a sandboxed iframe and when the user blocks site data, so a
 * missing store degrades to "no session" instead of breaking the client at construction.
 *
 * This covers the property read alone. Every method call goes through its own guard above, because
 * `?.` protects against an absent store, not against a store whose `setItem` throws
 * `QuotaExceededError`.
 */
function safeLocalStorage(): SessionStorageLike | undefined {
  try {
    return globalThis.localStorage
  } catch {
    return undefined
  }
}
