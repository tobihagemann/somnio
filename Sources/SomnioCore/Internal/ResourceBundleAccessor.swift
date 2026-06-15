import Foundation

public extension Bundle {
    /// Resolves a SwiftPM resource bundle by name from a code-signing-valid location.
    ///
    /// The toolchain's generated `Bundle.module` resolves only `Bundle.main.bundleURL/<name>`,
    /// which for a packaged macOS `.app` is the bundle *root* — where Gatekeeper forbids
    /// resources (`unsealed contents present in the bundle root`). `Scripts/package_app.sh`
    /// therefore places the resource bundles under `Contents/Resources/`
    /// (`Bundle.main.resourceURL`), a path the generated accessor never checks, so `.module`
    /// hits its `fatalError` at launch. This searches the valid packaged location first and
    /// falls back to the trapping `.module` only when it does not resolve — i.e. dev runs and
    /// `swift test`, where `.module` works.
    static func somnioResourceBundle(named name: String, fallback: () -> Bundle) -> Bundle {
        if let resources = Bundle.main.resourceURL,
           let bundle = Bundle(url: resources.appendingPathComponent(name)) {
            return bundle
        }
        return fallback()
    }

    /// SomnioCore's resource bundle, resolved for both packaged apps and dev/test. Also anchors
    /// `@testable import SomnioCore` in test targets that ship their own `.copy`/`.process`
    /// resources, which would otherwise have their synthesized `Bundle.module` shadow SomnioCore's.
    static let somnioCoreModule: Bundle = somnioResourceBundle(named: "Somnio_SomnioCore.bundle") { .module }
}
