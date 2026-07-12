import SomnioCore
import SomnioTheme
import SwiftUI

/// Full-bleed game layout: the play-field viewport fills the whole window and the HUD
/// floats over it in `FantasyPanel`s — energy bars top-leading, chat bottom-leading,
/// online players and inventory as toggleable panels on the trailing edge. The viewport
/// is supplied as the generic `PlayField` parameter so production code can pass the
/// renderer's host view and unit-level previews can substitute `EmptyView`.
public struct MainWindowView<PlayField: View>: View {
    public let playField: PlayField
    public let energy: Energy
    public let players: [String]
    public let items: [InventoryRow]
    public let chatLines: [ChatLine]
    @Binding public var chatInput: String
    /// Chat focus is owned by the caller (a plain `Bool` binding, not `@FocusState`):
    /// `ChatInputView` syncs it to the text view's first-responder state, the play field's
    /// tap gesture blurs through it, and the view model drives it downward for Esc — the
    /// RealityKit host view never takes first responder, so this binding is the only blur path.
    @Binding public var chatFocused: Bool
    public let onSubmitChat: () -> Void
    public let onItemActivate: ((InventoryRow) -> Void)?
    /// Reports whether the cursor sits over any floating panel, so the caller's scroll
    /// handler can pass wheel events through to the panel (chat scrollback) instead of
    /// zooming the world underneath it.
    public let onFloatingUIHoverChange: ((Bool) -> Void)?
    public let locale: Locale?

    @State private var showChat = true
    @State private var showPlayers = true
    @State private var showItems = true
    @State private var hoveredPanels: Set<FloatingPanel> = []

    public init(
        playField: PlayField,
        energy: Energy,
        players: [String],
        items: [InventoryRow],
        chatLines: [ChatLine],
        chatInput: Binding<String>,
        chatFocused: Binding<Bool>,
        onSubmitChat: @escaping () -> Void,
        onItemActivate: ((InventoryRow) -> Void)? = nil,
        onFloatingUIHoverChange: ((Bool) -> Void)? = nil,
        locale: Locale? = nil
    ) {
        self.playField = playField
        self.energy = energy
        self.players = players
        self.items = items
        self.chatLines = chatLines
        self._chatInput = chatInput
        self._chatFocused = chatFocused
        self.onSubmitChat = onSubmitChat
        self.onItemActivate = onItemActivate
        self.onFloatingUIHoverChange = onFloatingUIHoverChange
        self.locale = locale
    }

    public var body: some View {
        playField
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .simultaneousGesture(TapGesture().onEnded { chatFocused = false })
            .overlay(alignment: .topLeading) {
                hudPanel.padding(MainWindowMetrics.edgePadding)
            }
            .overlay(alignment: .bottomLeading) {
                chatPanel.padding(MainWindowMetrics.edgePadding)
            }
            .overlay(alignment: .topTrailing) {
                playersPanel.padding(MainWindowMetrics.edgePadding)
            }
            .overlay(alignment: .bottomTrailing) {
                itemsPanel.padding(MainWindowMetrics.edgePadding)
            }
    }

    // MARK: - Floating panels

    private var hudPanel: some View {
        FantasyPanel(fillOpacity: 0.6) {
            VStack(alignment: .leading, spacing: 6) {
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
        }
        .onHover { setHovered(.hud, $0) }
    }

    private var chatPanel: some View {
        VStack(alignment: .leading, spacing: 8) {
            if showChat {
                FantasyPanel(fillOpacity: 0.6) {
                    VStack(spacing: 8) {
                        ChatScrollbackView(chatLines: chatLines, locale: locale)
                            .frame(height: 180)
                        ChatInputView(text: $chatInput, onSubmit: onSubmitChat, isFocused: $chatFocused)
                            .frame(height: 52)
                            .fantasyFieldChrome()
                    }
                }
                .frame(width: MainWindowMetrics.chatPanelWidth)
            }
            panelToggle(tooltip: L.resource("Chat"), systemImage: "bubble.left", isOn: $showChat)
        }
        .onHover { setHovered(.chat, $0) }
    }

    private var playersPanel: some View {
        VStack(alignment: .trailing, spacing: 8) {
            panelToggle(tooltip: L.resource("Players"), systemImage: "person.2", isOn: $showPlayers)
            if showPlayers {
                FantasyPanel(fillOpacity: 0.6) {
                    OnlinePlayersList(players: players, locale: locale)
                        .frame(width: MainWindowMetrics.trailingListWidth, height: 260)
                }
            }
        }
        .onHover { setHovered(.players, $0) }
    }

    private var itemsPanel: some View {
        VStack(alignment: .trailing, spacing: 8) {
            if showItems {
                FantasyPanel(fillOpacity: 0.6) {
                    ItemsListView(items: items, locale: locale, onItemActivate: onItemActivate)
                        .frame(width: MainWindowMetrics.trailingListWidth, height: 150)
                }
            }
            panelToggle(tooltip: L.resource("Items"), systemImage: "bag", isOn: $showItems)
        }
        .onHover { setHovered(.items, $0) }
    }

    private func panelToggle(tooltip: LocalizedStringResource, systemImage: String, isOn: Binding<Bool>) -> some View {
        Button {
            isOn.wrappedValue.toggle()
        } label: {
            Image(systemName: systemImage)
        }
        .buttonStyle(FantasyButtonStyle(compact: true))
        .help(Text(tooltip))
    }

    /// Panels never overlap, but a cursor sliding straight from one to the next can report
    /// the enter before the exit — tracking the hovered set instead of one flag keeps the
    /// aggregate stable through that reorder.
    private func setHovered(_ id: FloatingPanel, _ hovering: Bool) {
        let wasHovering = !hoveredPanels.isEmpty
        if hovering {
            hoveredPanels.insert(id)
        } else {
            hoveredPanels.remove(id)
        }
        let isHovering = !hoveredPanels.isEmpty
        if wasHovering != isHovering {
            onFloatingUIHoverChange?(isHovering)
        }
    }
}

private enum FloatingPanel: Hashable {
    case hud
    case chat
    case players
    case items
}

/// Layout constants hoisted out of the generic view (a generic type cannot hold static
/// stored properties).
private enum MainWindowMetrics {
    static let edgePadding: CGFloat = 12
    static let chatPanelWidth: CGFloat = 380
    static let trailingListWidth: CGFloat = 180
}
