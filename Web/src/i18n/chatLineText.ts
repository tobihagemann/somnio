import { chatVerb } from '@/client/chatLine'
import type { ChatLine } from '@/client/chatLine'
import { lookupIn } from './xcstrings'
import type { CatalogLocale, CatalogTables } from './xcstrings'

/**
 * Port of `Sources/SomnioUI/Models/ChatLineRenderer.swift`. Exhaustive over every `ChatLine`
 * variant, so a new case is a compile error rather than a silently blank row.
 *
 * Takes the tables and locale as parameters instead of reaching for the module-level active locale,
 * which is what lets the catalog test render every line in both languages without mutating global
 * state between assertions.
 */
export function renderChatLine(line: ChatLine, tables: CatalogTables, locale: CatalogLocale): string {
  const lookup = (key: string, ...args: string[]): string => lookupIn(tables, locale, key, args)

  switch (line.kind) {
    case 'spokenByOwn':
    case 'spokenByPeer':
    case 'spokenByNPC':
      return renderSpoken(line.senderName, line.message, lookup)
    case 'adminBroadcast':
      return lookup('Broadcast message: %@', line.message)
    case 'connectionLost':
      return lookup('The connection was lost.')
    case 'serverUnreachable':
      return lookup('The server is currently not reachable. Try again later.')
    case 'badCredentials':
      return lookup('Bad credentials.')
    case 'alreadyLoggedIn':
      return lookup('Already logged in.')
    case 'errorCode':
      return lookup('Error %@ occurred.', line.code)
    case 'joined':
      return lookup('%@ entered the game.', line.playerName)
    case 'left':
      return lookup('%@ left the game.', line.playerName)
    case 'startupGreeting':
      return lookup('Welcome to Somnio!')
    case 'purseBalance':
      return lookup('You own %@c.', String(line.coins))
    case 'credentialSaveFailed':
      // The native string, read out of `Sources/SomnioUI/Resources/Localizable.xcstrings` through
      // the `@catalog/ui` alias rather than re-authored in the browser catalog: the failure is the
      // same one on both clients, so a second copy would be two translations of one sentence.
      return lookup('Your password could not be saved.')
    case 'sessionExpired':
      return lookup('Your session expired. Please log in again.')
    case 'reconnecting':
      return lookup('Reconnecting...')
  }
}

function renderSpoken(
  senderName: string,
  message: string,
  lookup: (key: string, ...args: string[]) => string
): string {
  switch (chatVerb(message)) {
    case 'question':
      return lookup('%1$@ asks, "%2$@"', senderName, message)
    case 'exclamation':
      return lookup('%1$@ exclaims, "%2$@"', senderName, message)
    case 'statement':
      return lookup('%1$@ says, "%2$@"', senderName, message)
  }
}
