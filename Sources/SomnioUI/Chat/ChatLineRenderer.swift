import Foundation

/// Renders a `ChatLine` into the localized string that the scrollback row displays.
/// Exhaustive on every `ChatLine` variant so a new case is a build-time error rather
/// than a silent fallthrough.
public enum ChatLineRenderer {
    public static func render(_ line: ChatLine, locale: Locale? = nil) -> String {
        switch line {
        case let .spokenByOwn(senderName, message),
             let .spokenByPeer(senderName, message),
             let .spokenByNPC(senderName, message):
            return renderSpoken(senderName: senderName, message: message, locale: locale)
        case let .adminBroadcast(message):
            return String(format: L.string("Broadcast message: %@", locale: locale), message)
        case .connectionLost:
            return L.string("The connection was lost.", locale: locale)
        case .serverUnreachable:
            return L.string("The server is currently not reachable. Try again later.", locale: locale)
        case let .errorCode(code):
            return String(format: L.string("Error %@ occurred.", locale: locale), code)
        case let .joined(playerName):
            return String(format: L.string("%@ entered the game.", locale: locale), playerName)
        case let .left(playerName):
            return String(format: L.string("%@ left the game.", locale: locale), playerName)
        case .startupGreeting:
            return L.string("Welcome to Somnio!", locale: locale)
        }
    }

    private static func renderSpoken(senderName: String, message: String, locale: Locale?) -> String {
        let template: String = switch ChatVerb.select(forMessage: message) {
        case .question:
            L.string("%1$@ asks, \"%2$@\"", locale: locale)
        case .exclamation:
            L.string("%1$@ exclaims, \"%2$@\"", locale: locale)
        case .statement:
            L.string("%1$@ says, \"%2$@\"", locale: locale)
        }
        return String(format: template, senderName, message)
    }
}
