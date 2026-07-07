import SwiftUI

/// Scrollable read-only chat history, sized by its host panel. Always prepends the
/// localized startup-greeting line as the first row so the player sees
/// `"Welcome to Somnio!"` before any wire message arrives — this view is the single
/// owner of the prepend, callers do not seed it themselves.
public struct ChatScrollbackView: View {
    public let chatLines: [ChatLine]
    public let locale: Locale?

    public init(chatLines: [ChatLine], locale: Locale? = nil) {
        self.chatLines = chatLines
        self.locale = locale
    }

    /// Scroll target: a zero-height tail placed *below* the content's bottom padding so `scrollTo`
    /// reaches the true content bottom. A row ID instead anchors to the row's bottom edge, which
    /// sits the padding's worth above the content's end and leaves a sliver still scrollable.
    private static let bottomAnchorID = "chat-bottom-anchor"

    public var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(spacing: 0) {
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
                    Color.clear
                        .frame(height: 0)
                        .id(Self.bottomAnchorID)
                }
            }
            // The scrollback fills from the top and only scrolls once it overflows: a no-op while a
            // few lines fit, pinning the newest line to the bottom past that. The scroll is deferred
            // into a `Task` so the freshly appended row is laid out before `scrollTo` runs — a
            // synchronous scroll in the same `onChange` lands one row short of the bottom.
            .onChange(of: chatLines.count) {
                Task { @MainActor in
                    proxy.scrollTo(Self.bottomAnchorID, anchor: .bottom)
                }
            }
            .onAppear {
                proxy.scrollTo(Self.bottomAnchorID, anchor: .bottom)
            }
        }
    }

    private var renderedLines: [ChatLine] {
        [.startupGreeting] + chatLines
    }
}
