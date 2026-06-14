import Foundation
import UniformTypeIdentifiers

public extension UTType {
    /// Canonical editor file type. The on-disk format is JSON, so it conforms to `public.json`
    /// and is exported from the editor bundle's `UTExportedTypeDeclarations` with a
    /// `somnio-sector` filename extension; `Scripts/package_app.sh` injects the matching
    /// `CFBundleDocumentTypes` entry so Launch Services routes `*.somnio-sector` files to
    /// `SomnioEditor.app`. The server's `SOMNIO_SECTORS_DIR` uses the same extension and bytes.
    static let somnioSector = UTType(exportedAs: "de.tobiha.somnio.sector", conformingTo: .json)
}
