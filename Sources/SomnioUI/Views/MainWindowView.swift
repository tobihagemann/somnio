import SomnioCore
import SwiftUI

/// Fixed-size single-window layout matching the legacy `HauptFenster` Carbon control
/// inventory. Outer dimensions 1004 × 514. The play-field viewport is supplied as the
/// generic `PlayField` parameter so production code can pass a `WorldSceneView` and
/// unit-level previews can substitute `EmptyView`.
public struct MainWindowView<PlayField: View>: View {
    public let playField: PlayField
    public let energy: Energy
    public let players: [String]
    public let items: [InventoryRow]
    public let chatLines: [ChatLine]
    @Binding public var chatInput: String
    public let onSubmitChat: () -> Void
    public let locale: Locale?

    public init(
        playField: PlayField,
        energy: Energy,
        players: [String],
        items: [InventoryRow],
        chatLines: [ChatLine],
        chatInput: Binding<String>,
        onSubmitChat: @escaping () -> Void,
        locale: Locale? = nil
    ) {
        self.playField = playField
        self.energy = energy
        self.players = players
        self.items = items
        self.chatLines = chatLines
        self._chatInput = chatInput
        self.onSubmitChat = onSubmitChat
        self.locale = locale
    }

    public var body: some View {
        ZStack(alignment: .topLeading) {
            playField
                .frame(width: 640, height: 480)
                .offset(x: 182, y: 14)

            VStack(alignment: .leading, spacing: 3) {
                HUDBarPair(
                    current: energy.hpCurrent,
                    max: energy.hpMax,
                    foregroundColor: Color(red: 224 / 255, green: 0, blue: 0),
                    tooltip: L.resource("HP")
                )
                HUDBarPair(
                    current: energy.balanceCurrent,
                    max: energy.balanceMax,
                    foregroundColor: Color(red: 0, green: 0, blue: 224 / 255),
                    tooltip: L.resource("Balance")
                )
                HUDBarPair(
                    current: energy.manaCurrent,
                    max: energy.manaMax,
                    foregroundColor: Color(red: 0, green: 224 / 255, blue: 0),
                    tooltip: L.resource("Mana")
                )
            }
            .offset(x: 20, y: 14)

            ChatScrollbackView(chatLines: chatLines, locale: locale)
                .offset(x: 20, y: 61)

            ChatInputView(text: $chatInput, onSubmit: onSubmitChat)
                .offset(x: 20, y: 409)

            OnlinePlayersList(players: players, locale: locale)
                .offset(x: 834, y: 14)

            ItemsListView(items: items, locale: locale)
                .offset(x: 834, y: 380)
        }
        .frame(width: 1004, height: 514, alignment: .topLeading)
        .fixedSize()
    }
}
