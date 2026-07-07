import SwiftUI

/// One horizontal HUD bar pair: a 150 × 10 dark track with a 1 px white line (matching
/// the panel chrome it floats on) and a 148 px maximum-width foreground rectangle whose
/// width tracks the `(current, max)` ratio. Mirrors the legacy `LebenBalken` /
/// `BalanceBalken` / `ManaBalken` control pairs.
public struct HUDBarPair: View {
    public let current: Int16
    public let max: Int16
    public let foregroundColor: Color
    public let tooltip: LocalizedStringResource

    public init(current: Int16, max: Int16, foregroundColor: Color, tooltip: LocalizedStringResource) {
        self.current = current
        self.max = max
        self.foregroundColor = foregroundColor
        self.tooltip = tooltip
    }

    public var body: some View {
        ZStack(alignment: .leading) {
            Rectangle()
                .fill(.black.opacity(0.55))
                .frame(width: 150, height: 10)
                .overlay {
                    Rectangle().stroke(.white.opacity(0.7), lineWidth: 1)
                }
            Rectangle()
                .fill(foregroundColor)
                .frame(width: HUDBarPair.foregroundWidth(current: current, max: max), height: 8)
                .offset(x: 1)
        }
        .frame(width: 150, height: 10, alignment: .leading)
        .help(Text(tooltip))
    }

    /// Clamps `current` into `[0, max]`, guards against a zero `max`, then scales the
    /// ratio across the 148 px usable foreground span.
    static func foregroundWidth(current: Int16, max: Int16) -> CGFloat {
        let safeMax = Swift.max(1, max)
        let clamped = Swift.max(0, Swift.min(current, max))
        return CGFloat(clamped) / CGFloat(safeMax) * 148
    }
}
