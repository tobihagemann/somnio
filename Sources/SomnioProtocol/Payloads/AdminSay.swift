import Foundation

public struct AdminSayMessage: Codable, Sendable, Equatable {
    public var text: String

    public init(text: String) {
        self.text = text
    }
}
