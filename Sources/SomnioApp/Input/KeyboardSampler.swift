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
    // Arrow keys drive the same four direction bits as WASD, so a player can walk with either.
    private static let keyUp: UInt16 = 126
    private static let keyDown: UInt16 = 125
    private static let keyLeft: UInt16 = 123
    private static let keyRight: UInt16 = 124
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

    /// Test seam: whether `start()` has run without a matching `stop()`, so lifecycle tests can
    /// assert teardown without poking the AppKit monitor token (which headless test processes
    /// may not create).
    private(set) var _isStarted = false

    /// Set by the host (view model) — `true` when gameplay should respond to WASD
    /// (player attached, no overlay up, chat input not focused). Defaults to `false` so
    /// the sampler doesn't capture keys before the gameplay loop is wired up. When
    /// `false`, key events pass through to AppKit's responder chain so text fields
    /// receive them normally.
    public var isGameplayActive: Bool = false {
        didSet {
            // Releasing capture mid-hold means the matching keyUp is never consumed, so drop
            // held keys to avoid phantom movement when gameplay resumes (e.g. an overlay closes).
            if !isGameplayActive { held = Held() }
        }
    }

    public init() {}

    public func start() {
        guard monitor == nil else { return }
        monitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown, .keyUp, .flagsChanged]) { [weak self] event in
            guard let self else { return event }
            let consumed: Bool
            switch event.type {
            case .keyDown:
                consumed = shouldConsume(keyCode: event.keyCode, modifierFlags: event.modifierFlags)
                if consumed { update(keyCode: event.keyCode, down: true) }
            case .keyUp:
                // Always clear the held bit, independent of whether the event is consumed: a
                // key pressed bare (set + consumed) may be released while Cmd/Ctrl is held
                // (not consumed), and the bit must still clear or the key sticks on.
                update(keyCode: event.keyCode, down: false)
                consumed = shouldConsume(keyCode: event.keyCode, modifierFlags: event.modifierFlags)
            case .flagsChanged:
                handleFlagsChanged(event)
                consumed = false
            default:
                consumed = false
            }
            return consumed ? nil : event
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
        _isStarted = true
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
        _isStarted = false
    }

    public var snapshot: Held {
        held
    }

    /// Clears the held bitset so a key with no matching key-up cannot drive phantom movement on
    /// the next gameplay tick. Invoked when keyboard capture yields to a text surface.
    public func clearHeldKeys() {
        held = Held()
    }

    /// Test seam: drives the `(keyCode, down)` path the event monitor would invoke.
    func updateForTest(keyCode: UInt16, down: Bool) {
        update(keyCode: keyCode, down: down)
    }

    private func isGameplayKey(_ keyCode: UInt16) -> Bool {
        switch keyCode {
        case Self.keyW, Self.keyA, Self.keyS, Self.keyD,
             Self.keyUp, Self.keyDown, Self.keyLeft, Self.keyRight:
            return true
        default:
            return false
        }
    }

    /// Whether a key event is swallowed for gameplay. Consumes bare W/A/S/D (and Shift/Option
    /// tempo combos) while gameplay is active, but lets Command/Control combos through so menu
    /// shortcuts (Cmd-W, Cmd-S, ...) still reach the responder chain. Internal for `@testable`.
    func shouldConsume(keyCode: UInt16, modifierFlags: NSEvent.ModifierFlags) -> Bool {
        guard isGameplayActive, isGameplayKey(keyCode) else { return false }
        return modifierFlags.isDisjoint(with: [.command, .control])
    }

    private func update(keyCode: UInt16, down: Bool) {
        switch keyCode {
        case Self.keyW, Self.keyUp: held.w = down
        case Self.keyA, Self.keyLeft: held.a = down
        case Self.keyS, Self.keyDown: held.s = down
        case Self.keyD, Self.keyRight: held.d = down
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
