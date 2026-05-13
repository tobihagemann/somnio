import Foundation

/// Server version string surfaced by the admin `version` verb. The packaging shell
/// will inject the real value from `version.env` at build time; this placeholder lets
/// the dispatcher and CLI wire up end-to-end before that lands.
public enum SomnioServerVersion {
    public static let value: String = "1.0.0"
}
