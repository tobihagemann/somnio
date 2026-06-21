import Foundation

/// Direction of a wire-protocol version mismatch at the Hello handshake. `clientOutdated`
/// means the server advertises a newer version than the client understands (the player
/// needs to update); `serverOutdated` means the server advertises an older version (the
/// player auto-updated ahead of the deploy and should retry shortly).
public enum VersionSkew: Sendable, Equatable, Hashable {
    case clientOutdated
    case serverOutdated
}

/// Top-level identifier for the currently presented modal. The Preferences pane is
/// delivered through SwiftUI's `Settings` scene rather than a sheet, so it deliberately
/// has no case here.
public enum SheetKind: Identifiable, Sendable, Equatable, Hashable {
    case login
    case registration
    case about
    case updateRequired(VersionSkew)

    public var id: Self {
        self
    }
}
