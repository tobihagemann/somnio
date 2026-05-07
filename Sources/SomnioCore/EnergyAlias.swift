import Foundation
import SomnioProtocol

/// Re-exports `Energy` from `SomnioProtocol` so runtime code in `SomnioCore` and downstream
/// targets reads `Energy` without a module qualifier. There is one `Energy` type in the
/// project — the canonical one defined in `SomnioProtocol/Payloads/Energy.swift`.
public typealias Energy = SomnioProtocol.Energy
