import Foundation

public enum SomnioProtocolConstants {
    public static let helloVersion: UInt16 = 1
    public static let maxFrameLength: UInt32 = 1 << 20
}

public enum SomnioProtocolError: Error, Equatable, Sendable {
    case truncated
    case invalidPayload(reason: String)
    case unrecognizedTag(UInt8)
    case oversizedFrame(UInt32)
}
