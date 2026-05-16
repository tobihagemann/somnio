import Foundation
import UniformTypeIdentifiers

public extension UTType {
    /// Canonical editor file type. Conforms to `public.data` and is exported from the
    /// editor bundle's `UTExportedTypeDeclarations` with a `somnio-sector` filename
    /// extension; `Scripts/package_app.sh` injects the matching `CFBundleDocumentTypes`
    /// entry so Launch Services routes `*.somnio-sector` files to `SomnioEditor.app`.
    /// Bare-name files (the server's on-disk convention) flow through the editor's
    /// Import/Export menu pair instead — the bytes are identical either way.
    static let somnioSector = UTType(exportedAs: "de.tobiha.somnio.sector", conformingTo: .data)
}
