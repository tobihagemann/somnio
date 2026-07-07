import AppKit
import Logging

/// `Bundle.main` loader for the pack-supplied UI chrome textures (the `UI/` subtree
/// `Scripts/bundle-assets.sh` copies into the .app), mirroring `BundleMainModelAssets`'
/// pack-loading seam: semantic stems, cached prototypes, and a negative cache so a
/// missing stem logs one error and then renders unstyled instead of retrying per frame.
@MainActor enum FantasyPanelTextures {
    static let panelPrimary = "panel-primary"
    static let panelButton = "panel-button"
    static let panelButtonHover = "panel-button-hover"
    static let divider = "divider"

    private static let logger = Logger(label: "de.tobiha.somnio.ui.theme")
    private static var cache: [String: NSImage] = [:]
    private static var misses: Set<String> = []

    static func image(named stem: String) -> NSImage? {
        if let cached = cache[stem] { return cached }
        guard !misses.contains(stem) else { return nil }
        guard let url = Bundle.main.url(forResource: stem, withExtension: "png", subdirectory: "UI"),
              let image = NSImage(contentsOf: url)
        else {
            misses.insert(stem)
            logger.error("UI texture absent from bundle; rendering unstyled", metadata: ["stem": "\(stem)"])
            return nil
        }
        // The pack ships the 2x "Double" pixel variants; halving the point size draws the
        // chrome at its designed thickness with Retina-crisp backing.
        image.size = NSSize(width: image.size.width / 2, height: image.size.height / 2)
        cache[stem] = image
        return image
    }
}
