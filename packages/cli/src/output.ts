import type { AdminResponse } from '@somnio/protocol'
import type { CatalogLocale } from '@somnio/core/catalog'
import { localize } from './catalog.ts'

export interface WorldClockFields {
  year: string
  month: string
  day: string
  hour: string
  minute: string
  second: string
}

/**
 * Splits a wire-format `worldClock` payload (`Y;M;D;HH;MM;SS`) into its six text fields, verbatim,
 * or `undefined` when the field count is
 * wrong or a field is not an integer, so a malformed payload renders as an error line.
 */
export function parseWorldClock(text: string): WorldClockFields | undefined {
  const fields = text.split(';')
  if (fields.length !== 6 || fields.some((field) => !/^-?\d+$/.test(field))) return undefined
  const [year, month, day, hour, minute, second] = fields as [string, string, string, string, string, string]
  return { year, month, day, hour, minute, second }
}

/** The localized terminal line for a response; exhaustive so a new wire case is a type error. */
export function render(response: AdminResponse, locale: CatalogLocale = 'en'): string {
  switch (response.tag) {
    case 'logEmpty':
      return localize('Log file is empty or does not exist.', locale)
    case 'logRemoved':
      return localize('Log file deleted.', locale)
    case 'weblogEmpty':
      return localize('WebLog file is empty or does not exist.', locale)
    case 'weblogRemoved':
      return localize('WebLog file deleted.', locale)
    case 'unknownCommand':
      return localize('Unknown command.', locale)
    case 'logContents':
    case 'weblogContents':
      return response.payload
    case 'playerCount':
      return localize('Number of players on the server: %@', locale, response.payload)
    case 'worldClock': {
      const clock = parseWorldClock(response.payload)
      if (clock === undefined) return localize('The error %@ occurred.', locale, response.payload)
      return localize(
        'It is the year %1$@, the month %2$@, the day %3$@ and the time is %4$@:%5$@:%6$@.',
        locale,
        clock.year,
        clock.month,
        clock.day,
        clock.hour,
        clock.minute,
        clock.second
      )
    }
    case 'sayBroadcast':
      return localize('Broadcast message: %@', locale, response.payload)
    case 'kickedPlayer':
      return localize('%@ was kicked from the server.', locale, response.payload)
    case 'kickedPlayerNotFound':
      return localize('%@ could not be found on the server.', locale, response.payload)
    case 'versionString':
      return localize('The server is running version: %@', locale, response.payload)
  }
}
