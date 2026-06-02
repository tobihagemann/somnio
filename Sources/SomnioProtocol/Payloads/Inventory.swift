import Foundation

public struct InventoryMessage: Codable, Sendable, Equatable {
    public var rows: [WireInventoryRow]

    public init(rows: [WireInventoryRow]) {
        self.rows = rows
    }
}
