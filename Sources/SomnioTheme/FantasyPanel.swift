import SwiftUI

/// Game-styled panel: a dark plate under the Kenney "Fantasy UI Borders" white line-art,
/// 9-sliced so any panel size keeps crisp corner ornaments and straight stretched edges.
/// The title is a `LocalizedStringResource` so callers resolve it against their own
/// catalog bundle. Without the texture (no asset pack) the panel renders the plain dark
/// plate — the loader already logged the missing stem.
public struct FantasyPanel<Content: View>: View {
    private let title: LocalizedStringResource?
    private let fillOpacity: Double
    private let content: Content

    public init(
        title: LocalizedStringResource? = nil,
        fillOpacity: Double = 0.85,
        @ViewBuilder content: () -> Content
    ) {
        self.title = title
        self.fillOpacity = fillOpacity
        self.content = content()
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let title {
                FantasyFlankedLabel {
                    Text(title)
                        .font(.headline)
                        .foregroundStyle(.white)
                }
            }
            content
        }
        .padding(FantasyChrome.panelContentPadding)
        .background {
            FantasyChrome.background(stem: FantasyPanelTextures.panelPrimary, fillOpacity: fillOpacity)
        }
        // The plate is dark in either system appearance: default the text to white and
        // force dark chrome on AppKit-backed controls (popup pickers, checkboxes), which
        // keep light-mode styling otherwise and vanish against it.
        .foregroundStyle(.white)
        .environment(\.colorScheme, .dark)
    }
}

/// A centered label flanked by the pack's divider strips on both sides, end ornaments
/// facing the text — the sample-sheet heading arrangement. Used for panel titles and
/// standalone headings alike.
public struct FantasyFlankedLabel<Label: View>: View {
    private let label: Label

    public init(@ViewBuilder label: () -> Label) {
        self.label = label()
    }

    public var body: some View {
        HStack(spacing: 10) {
            FantasyDividerHalf(ornamentEdge: .trailing)
            label
                .fixedSize()
            FantasyDividerHalf(ornamentEdge: .leading)
        }
    }
}

/// Plain double-line rule matching the border art's line weight — deliberately
/// ornament-free (ornaments are reserved for the title flanks), so it is drawn
/// directly rather than sliced from the pack's ornamented divider strips.
public struct FantasyDivider: View {
    public init() {}

    public var body: some View {
        VStack(spacing: 3) {
            Rectangle()
                .fill(.white)
                .frame(height: 1.5)
            Rectangle()
                .fill(.white)
                .frame(height: 1.5)
        }
        .frame(maxWidth: .infinity)
    }
}

/// One flank of a heading arrangement: the strip's long run stretches, its end ornament
/// stays fixed on `ornamentEdge`. The texture authors the ornament on the trailing end;
/// the leading variant mirrors it (a horizontal flip is exact for this symmetric-line art).
struct FantasyDividerHalf: View {
    enum OrnamentEdge {
        case leading
        case trailing
    }

    let ornamentEdge: OrnamentEdge

    var body: some View {
        if let image = FantasyPanelTextures.image(named: FantasyPanelTextures.divider) {
            Image(nsImage: image)
                .resizable(
                    capInsets: EdgeInsets(top: 0, leading: 12, bottom: 0, trailing: 24),
                    resizingMode: .stretch
                )
                .scaleEffect(x: ornamentEdge == .leading ? -1 : 1, y: 1)
                .frame(maxWidth: .infinity)
                .frame(height: image.size.height)
        } else {
            Rectangle()
                .fill(.white.opacity(0.4))
                .frame(maxWidth: .infinity)
                .frame(height: 1)
        }
    }
}

/// Shared chrome constants + the plate/border composition used by `FantasyPanel` and
/// `FantasyButtonStyle`.
enum FantasyChrome {
    /// Matches the border art's ornament depth (16 pt at the halved "Double" point size)
    /// so content never underlaps the line work.
    static let panelContentPadding: CGFloat = 20
    /// 9-slice corner extent: past every corner ornament in the curated set, well under
    /// half the 48 pt tile so a stretchable center band always remains.
    static let capInset: CGFloat = 18
    /// The dark plate reaches under the border line (drawn a few points inside the
    /// texture edge) without spilling past the ornaments.
    static let plateInset: CGFloat = 3

    @MainActor static func background(stem: String, fillOpacity: Double) -> some View {
        ZStack {
            Rectangle()
                .fill(.black.opacity(fillOpacity))
                .padding(plateInset)
            if let image = FantasyPanelTextures.image(named: stem) {
                Image(nsImage: image)
                    .resizable(
                        capInsets: EdgeInsets(top: capInset, leading: capInset, bottom: capInset, trailing: capInset),
                        resizingMode: .stretch
                    )
            }
        }
    }
}
