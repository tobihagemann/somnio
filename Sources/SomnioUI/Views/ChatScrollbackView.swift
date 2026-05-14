import SwiftUI

/// Scrollable read-only chat history. Always prepends the localized startup-greeting
/// line as the first row so the player sees `"Welcome to Somnio!"` before any wire
/// message arrives — this view is the single owner of the prepend, callers do not
/// seed it themselves.
public struct ChatScrollbackView: View {
    public let chatLines: [ChatLine]
    public let locale: Locale?

    public init(chatLines: [ChatLine], locale: Locale? = nil) {
        self.chatLines = chatLines
        self.locale = locale
    }

    public var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 2) {
                ForEach(Array(renderedLines.enumerated()), id: \.offset) { _, line in
                    let style = ChatLineStyle.style(for: line.category)
                    Text(verbatim: ChatLineRenderer.render(line, locale: locale))
                        .foregroundStyle(style.foreground.color)
                        .bold(style.bold)
                        .italic(style.italic)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .padding(4)
        }
        .frame(width: 150, height: 336)
    }

    private var renderedLines: [ChatLine] {
        [.startupGreeting] + chatLines
    }
}
