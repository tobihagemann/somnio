import Foundation

/// Top-level identifier for the currently presented in-scene overlay, mirroring the player
/// client's `OverlayKind`. `gameMenu` is the Esc menu; `newMap` replaces the focused
/// document's geometry in place (auto-presented while the document is uninitialized);
/// `sectorSettings` edits the sector-level fields of an initialized document.
public enum EditorOverlayKind: Identifiable, Sendable, Equatable {
    case gameMenu
    case newMap
    case sectorSettings
    case about

    public var id: Self {
        self
    }
}
