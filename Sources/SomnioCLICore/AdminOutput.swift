import Foundation
import SomnioProtocol

/// Renders an `AdminResponse` into the localized terminal string the operator sees.
/// Exhaustive on every `AdminResponse` variant so a future wire-layer addition is a
/// build-time error rather than a silent fallthrough.
enum AdminOutput {
    // swiftlint:disable cyclomatic_complexity
    /// Wire contract for `.worldClock.text`: six semicolon-delimited fields
    /// `"Y;M;D;HH;MM;SS"`. The server formatter pads HH/MM/SS to two digits; year/month/day
    /// are not zero-padded. Both sides of the protocol live by this format.
    static func render(_ response: AdminResponse, locale: Locale? = nil) -> String {
        switch response {
        case .logEmpty:
            return L.string("Log file is empty or does not exist.", locale: locale)
        case .logRemoved:
            return L.string("Log file deleted.", locale: locale)
        case .weblogEmpty:
            return L.string("WebLog file is empty or does not exist.", locale: locale)
        case .weblogRemoved:
            return L.string("WebLog file deleted.", locale: locale)
        case .unknownCommand:
            return L.string("Unknown command.", locale: locale)
        case let .logContents(text):
            return text
        case let .weblogContents(text):
            return text
        case let .playerCount(text):
            return String(format: L.string("Number of players on the server: %@", locale: locale), text)
        case let .worldClock(text):
            guard let parts = parseWorldClock(text) else {
                return String(format: L.string("The error %@ occurred.", locale: locale), text)
            }
            return String(
                format: L.string("It is the year %1$@, the month %2$@, the day %3$@ and the time is %4$@:%5$@:%6$@.", locale: locale),
                parts.year,
                parts.month,
                parts.day,
                parts.hour,
                parts.minute,
                parts.second
            )
        case let .sayBroadcast(text):
            return String(format: L.string("Broadcast message: %@", locale: locale), text)
        case let .kickedPlayer(text):
            return String(format: L.string("%@ was kicked from the server.", locale: locale), text)
        case let .kickedPlayerNotFound(text):
            return String(format: L.string("%@ could not be found on the server.", locale: locale), text)
        case let .versionString(text):
            return String(format: L.string("The server is running version: %@", locale: locale), text)
        }
    }

    // swiftlint:enable cyclomatic_complexity

    // swiftlint:disable large_tuple
    /// Splits a wire-format `worldClock` payload into its six text fields. Returns `nil`
    /// when the field count is wrong or any field fails to parse as an `Int`, so a
    /// malformed server payload surfaces as a localized error string rather than a crash.
    static func parseWorldClock(_ text: String) -> (year: String, month: String, day: String, hour: String, minute: String, second: String)? {
        let fields = text.split(separator: ";", omittingEmptySubsequences: false)
        guard fields.count == 6 else { return nil }
        for field in fields where Int(field) == nil {
            return nil
        }
        return (
            year: String(fields[0]),
            month: String(fields[1]),
            day: String(fields[2]),
            hour: String(fields[3]),
            minute: String(fields[4]),
            second: String(fields[5])
        )
    }
    // swiftlint:enable large_tuple
}
