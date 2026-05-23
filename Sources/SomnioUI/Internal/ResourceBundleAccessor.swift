import Foundation

extension Bundle {
    /// Anchors `@testable import SomnioUI` in test targets that ship their own
    /// `.copy`/`.process` resources, which would otherwise have their synthesized
    /// `Bundle.module` shadow SomnioUI's. Behaviorally identical to `Bundle.module`
    /// from inside SomnioUI.
    static var somnioUIModule: Bundle {
        .module
    }
}
