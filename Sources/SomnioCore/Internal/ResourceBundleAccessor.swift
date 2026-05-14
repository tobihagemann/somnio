import Foundation

extension Bundle {
    /// Anchors `@testable import SomnioCore` in test targets that ship their own
    /// `.copy`/`.process` resources, which would otherwise have their synthesized
    /// `Bundle.module` shadow SomnioCore's. Behaviorally identical to `Bundle.module`
    /// from inside SomnioCore.
    static var somnioCoreModule: Bundle {
        .module
    }
}
