import Foundation

/// Top-level identifier for the currently presented modal. The Preferences pane is
/// delivered through SwiftUI's `Settings` scene rather than a sheet, so it deliberately
/// has no case here.
public enum SheetKind: Identifiable, Sendable, Equatable {
    case login
    case registration
    case about

    public var id: Self {
        self
    }
}
