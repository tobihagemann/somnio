import Foundation

public struct HelloMessage: Codable, Sendable, Equatable {
    public var protocolVersion: UInt16

    public init(protocolVersion: UInt16) {
        self.protocolVersion = protocolVersion
    }
}
