import Foundation

/// `SayMessage` is the shared payload for both `clientSay` (C→S) and `serverSay` (S→C broadcast)
/// cases of `SomnioMessage`. The server fills `entityIndex` when broadcasting; the client sends
/// `entityIndex = 0`.
public struct SayMessage: Codable, Sendable, Equatable {
    public var entityIndex: Int16
    public var text: String

    public init(entityIndex: Int16, text: String) {
        self.entityIndex = entityIndex
        self.text = text
    }
}
