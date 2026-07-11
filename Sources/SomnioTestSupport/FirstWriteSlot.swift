import Foundation

/// Generic actor for "first writer wins" capture between a WS handler closure and the
/// post-handler assertion. Replaces the per-test `HelloSlot`, `AdminResponseSlot`,
/// `DateTickSlot`, and `CloseRecorder` actors that all carry the same single-value
/// shape — a regression to one would silently fail to propagate to the others.
public actor FirstWriteSlot<Value: Sendable> {
    private var stored: Value?

    public init() {}

    public func set(_ value: Value) {
        if stored == nil { stored = value }
    }

    public func value() -> Value? {
        stored
    }
}
