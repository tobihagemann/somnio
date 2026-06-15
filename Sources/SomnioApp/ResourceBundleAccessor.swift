import Foundation
import SomnioCore

extension Bundle {
    /// SomnioApp's resource bundle, resolved via the shared `somnioResourceBundle` search so the
    /// player loads its catalog from the code-signing-valid `Contents/Resources/` location in a
    /// packaged app rather than the bundle root the generated `Bundle.module` expects (which
    /// `fatalError`s at launch).
    static let somnioAppModule: Bundle = somnioResourceBundle(named: "Somnio_SomnioApp.bundle") { .module }
}
