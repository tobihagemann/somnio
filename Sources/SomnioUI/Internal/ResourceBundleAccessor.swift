import Foundation
import SomnioCore

extension Bundle {
    /// SomnioUI's resource bundle, resolved via the shared `somnioResourceBundle` search so it
    /// loads from the code-signing-valid `Contents/Resources/` location in a packaged app rather
    /// than the bundle root the generated `Bundle.module` expects. Also anchors
    /// `@testable import SomnioUI` in test targets that ship their own `.copy`/`.process`
    /// resources, which would otherwise have their synthesized `Bundle.module` shadow SomnioUI's.
    static let somnioUIModule: Bundle = somnioResourceBundle(named: "Somnio_SomnioUI.bundle") { .module }
}
