import AppKit
import Foundation

/// Tracks the held state of W / A / S / D plus the LShift / LOption modifier keys via
/// an `NSEvent.addLocalMonitorForEvents` monitor. The view model reads the bitset on
/// each gameplay tick; an empty bitset means no movement keys are held.
///
/// Modifier keys are tracked by physical `keyCode` rather than by
/// `NSEvent.modifierFlags.contains(.shift)` so the legacy spec's left-side rule
/// (R1: "While LShift is held the character shall run; while LOption is held it shall
/// walk") is preserved. AppKit's `.shift` / `.option` flags are either-side; using
/// them would let the right-hand modifiers also drive tempo, which the original game
/// did not do.
@MainActor public final class KeyboardSampler {
    public struct Held: Equatable, Sendable {
        public var w = false
        public var a = false
        public var s = false
        public var d = false
        public var leftShift = false
        public var leftOption = false

        public init() {}
    }

    private static let keyW: UInt16 = 13
    private static let keyA: UInt16 = 0
    private static let keyS: UInt16 = 1
    private static let keyD: UInt16 = 2
    private static let keyLeftShift: UInt16 = 56
    private static let keyLeftOption: UInt16 = 58
    /// Device-specific modifier bitmasks from `<IOKit/hidsystem/IOLLEvent.h>`. AppKit's
    /// `.shift`/`.option` are aggregate flags (true if either side is held), so they
    /// can't be used to track per-side state — releasing LShift while RShift was still
    /// held would leave the aggregate flag set and `held.leftShift` stuck.
    /// `event.modifierFlags.rawValue` carries the device-specific bits verbatim.
    private static let lshiftBit: UInt = 0x02 // NX_DEVICELSHIFTKEYMASK
    private static let loptionBit: UInt = 0x20 // NX_DEVICELALTKEYMASK

    private var held = Held()
    private var monitor: Any?
    private var resignActiveObserver: NSObjectProtocol?

    public init() {}

    public func start() {
        guard monitor == nil else { return }
        monitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown, .keyUp, .flagsChanged]) { [weak self] event in
            guard let self else { return event }
            switch event.type {
            case .keyDown:
                update(keyCode: event.keyCode, down: true)
            case .keyUp:
                update(keyCode: event.keyCode, down: false)
            case .flagsChanged:
                handleFlagsChanged(event)
            default:
                break
            }
            return event
        }
        // Clear held keys whenever the app loses focus. `addLocalMonitorForEvents`
        // only delivers events while the app is active; without this hook a user who
        // holds W and Cmd-Tabs away never sees the matching `.keyUp`, so the next
        // tick after refocusing would still see W "held" and the player would walk
        // until the user retypes and releases the key.
        resignActiveObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.didResignActiveNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.held = Held()
            }
        }
    }

    public func stop() {
        if let monitor {
            NSEvent.removeMonitor(monitor)
        }
        monitor = nil
        if let resignActiveObserver {
            NotificationCenter.default.removeObserver(resignActiveObserver)
        }
        resignActiveObserver = nil
        held = Held()
    }

    public var snapshot: Held {
        held
    }

    /// Test seam: clears the held bitset. Used by `KeyboardSamplerTests` to verify
    /// the `didResignActiveNotification` reset path without synthesising AppKit
    /// notifications across actor boundaries.
    func resetForTest() {
        held = Held()
    }

    /// Test seam: drives the `(keyCode, down)` path the event monitor would invoke.
    func updateForTest(keyCode: UInt16, down: Bool) {
        update(keyCode: keyCode, down: down)
    }

    private func update(keyCode: UInt16, down: Bool) {
        switch keyCode {
        case Self.keyW: held.w = down
        case Self.keyA: held.a = down
        case Self.keyS: held.s = down
        case Self.keyD: held.d = down
        case Self.keyLeftShift: held.leftShift = down
        case Self.keyLeftOption: held.leftOption = down
        default: break
        }
    }

    /// `flagsChanged` doesn't carry a `down` boolean directly; derive it from the
    /// device-specific bit that names the physical key. Aggregate `.shift`/`.option`
    /// would falsely keep `held.leftShift = true` after the user releases LShift if
    /// RShift is still down.
    private func handleFlagsChanged(_ event: NSEvent) {
        let raw = event.modifierFlags.rawValue
        switch event.keyCode {
        case Self.keyLeftShift:
            held.leftShift = raw & Self.lshiftBit != 0
        case Self.keyLeftOption:
            held.leftOption = raw & Self.loptionBit != 0
        default:
            break
        }
    }
}
