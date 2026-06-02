import Foundation

public struct BumpNPCMessage: Codable, Sendable, Equatable {
    public var npcIndex: Int16

    public init(npcIndex: Int16) {
        self.npcIndex = npcIndex
    }
}
