import SwiftUI

/// Online-players list with a "Players: N" footer. The footer count goes through the
/// localization catalog explicitly because SwiftUI's `Text(_:)` treats string
/// arguments as localization keys and would not substitute a raw `%@` format.
public struct OnlinePlayersList: View {
    public let players: [String]
    public let locale: Locale?

    public init(players: [String], locale: Locale? = nil) {
        self.players = players
        self.locale = locale
    }

    public var body: some View {
        VStack(spacing: 0) {
            List(Array(players.enumerated()), id: \.offset) { _, name in
                Text(verbatim: name)
            }
            .listStyle(.plain)
            .frame(width: 150, height: 340)
            .border(Color.black, width: 1)
            Text(verbatim: String(format: L.string("Players: %@", locale: locale), String(players.count)))
                .frame(width: 150, height: 14, alignment: .leading)
        }
    }
}
