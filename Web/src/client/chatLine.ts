/**
 * Port of `Sources/SomnioUI/Models/ChatLine.swift` and `ChatVerb.swift`.
 *
 * Structured rather than pre-rendered strings for the same reason the Swift enum is: the message
 * text and the sentence around it are localized separately, and the category drives the row's
 * colour. Appending a formatted string at the call site would bake one language into state the UI
 * has to re-render when the locale changes.
 */

export type ChatLine =
  | { kind: 'spokenByOwn'; senderName: string; message: string }
  | { kind: 'spokenByPeer'; senderName: string; message: string }
  | { kind: 'spokenByNPC'; senderName: string; message: string }
  | { kind: 'adminBroadcast'; message: string }
  | { kind: 'connectionLost' }
  | { kind: 'serverUnreachable' }
  | { kind: 'badCredentials' }
  | { kind: 'alreadyLoggedIn' }
  | { kind: 'errorCode'; code: string }
  | { kind: 'joined'; playerName: string }
  | { kind: 'left'; playerName: string }
  | { kind: 'startupGreeting' }
  | { kind: 'purseBalance'; coins: number }
  | { kind: 'credentialSaveFailed' }
  | { kind: 'sessionExpired' }
  | { kind: 'reconnecting' }

/**
 * The visual-treatment bucket that selects a line's colour and weight.
 *
 * `credentialSaveFailed` is shared with the native client, and the shape of the failure is the same
 * on both: the player ticked "Remember password", the credential write failed, and nothing else
 * would tell them. Natively that write is the Keychain; here it is `localStorage.setItem`, which
 * throws on `QuotaExceededError`, under a storage-blocking extension, and in an engine that permits
 * the read and rejects the write. `sessionExpired` and `reconnecting` are the two with no native
 * counterpart, because only the browser resumes from a token.
 */
export type ChatLineCategory =
  | 'ownMessage'
  | 'peerMessage'
  | 'npcMessage'
  | 'adminBroadcast'
  | 'error'
  | 'joinLeave'
  | 'startupGreeting'
  | 'itemInfo'

export function chatLineCategory(line: ChatLine): ChatLineCategory {
  switch (line.kind) {
    case 'spokenByOwn':
      return 'ownMessage'
    case 'spokenByPeer':
      return 'peerMessage'
    case 'spokenByNPC':
      return 'npcMessage'
    case 'adminBroadcast':
      return 'adminBroadcast'
    case 'connectionLost':
    case 'serverUnreachable':
    case 'badCredentials':
    case 'alreadyLoggedIn':
    case 'errorCode':
    case 'credentialSaveFailed':
    case 'sessionExpired':
    case 'reconnecting':
      return 'error'
    case 'joined':
    case 'left':
      return 'joinLeave'
    case 'startupGreeting':
      return 'startupGreeting'
    case 'purseBalance':
      return 'itemInfo'
  }
}

export type ChatVerb = 'question' | 'exclamation' | 'statement'

/** Trailing punctuation picks the framing verb; the empty string is a statement. */
export function chatVerb(text: string): ChatVerb {
  const last = [...text].at(-1)
  if (last === '?') return 'question'
  if (last === '!') return 'exclamation'
  return 'statement'
}
