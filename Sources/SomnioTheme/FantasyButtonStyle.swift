import SwiftUI

/// Game-styled button chrome: the pack's simple border frame at rest, the double frame on
/// hover, and a brightened plate while pressed. `compact` drops the command-button minimum
/// width for small square controls like the HUD panel toggles. Hover state lives in the
/// body view — a `ButtonStyle` itself cannot hold `@State`.
public struct FantasyButtonStyle: ButtonStyle {
    private let compact: Bool

    public init(compact: Bool = false) {
        self.compact = compact
    }

    public func makeBody(configuration: Configuration) -> some View {
        FantasyButtonBody(configuration: configuration, compact: compact)
    }
}

private struct FantasyButtonBody: View {
    let configuration: ButtonStyle.Configuration
    let compact: Bool
    @Environment(\.isEnabled) private var isEnabled
    @State private var isHovering = false

    var body: some View {
        configuration.label
            .font(.body.weight(.medium))
            .foregroundStyle(.white)
            .padding(.horizontal, compact ? 10 : 18)
            .padding(.vertical, 8)
            .frame(minWidth: compact ? nil : 96)
            .background {
                FantasyChrome.background(
                    stem: isHovering ? FantasyPanelTextures.panelButtonHover : FantasyPanelTextures.panelButton,
                    fillOpacity: configuration.isPressed ? 0.55 : 0.8
                )
            }
            .contentShape(Rectangle())
            .opacity(isEnabled ? 1 : 0.4)
            .onHover { hovering in
                isHovering = hovering && isEnabled
            }
    }
}

/// Chrome for text inputs sitting on a `FantasyPanel`: a plain field over its own darker
/// inset plate, so the system's rounded-border bezel never clashes with the line art.
public extension View {
    func fantasyFieldChrome() -> some View {
        textFieldStyle(.plain)
            .foregroundStyle(.white)
            .padding(6)
            .background(.black.opacity(0.5))
            .overlay {
                Rectangle().stroke(.white.opacity(0.35), lineWidth: 1)
            }
    }
}
