import Foundation
import SomnioCore

extension Bundle {
    /// SomnioEditor's resource bundle, resolved via the shared `somnioResourceBundle` search so the
    /// editor loads its catalog from the code-signing-valid `Contents/Resources/` location in a
    /// packaged app rather than the bundle root the generated `Bundle.module` expects (which
    /// `fatalError`s at launch).
    static let somnioEditorModule: Bundle = somnioResourceBundle(named: "Somnio_SomnioEditor.bundle") { .module }
}
