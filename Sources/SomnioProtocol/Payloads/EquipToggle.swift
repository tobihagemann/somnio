import Foundation

public struct EquipToggleMessage: Codable, Sendable, Equatable {
    public var slot: Int16
    public var hand: WireHand

    public init(slot: Int16, hand: WireHand) {
        self.slot = slot
        self.hand = hand
    }

    public enum CodingKeys: String, CaseIterable, CodingKey { case slot; case hand }
}
