import Foundation

public struct DateTickMessage: Codable, Sendable, Equatable {
    public var hour: Int16
    public var minute: Int16

    public init(hour: Int16, minute: Int16) {
        self.hour = hour
        self.minute = minute
    }
}
