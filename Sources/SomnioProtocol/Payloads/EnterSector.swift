import Foundation

public struct EnterSectorMessage: Codable, Sendable, Equatable {
    public var sector: WireSector

    public init(sector: WireSector) {
        self.sector = sector
    }

    public enum CodingKeys: String, CaseIterable, CodingKey { case sector }
}
