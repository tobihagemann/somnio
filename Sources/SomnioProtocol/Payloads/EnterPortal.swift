import Foundation

public struct EnterPortalMessage: Codable, Sendable, Equatable {
    public var portalIndex: Int16

    public init(portalIndex: Int16) {
        self.portalIndex = portalIndex
    }
}
