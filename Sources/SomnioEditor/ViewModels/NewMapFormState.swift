import Foundation

/// In-flight New-map dialog state. `width` / `height` are sector dimensions in tiles
/// (legacy `SektorMacher` semantics); the OK handler multiplies them out into the
/// `SectorBody.dimensions` field which is also tiles.
@Observable public final class NewMapFormState {
    public var sectorName: String = ""
    public var width: Int16 = 20
    public var height: Int16 = 15
    public var indoor: Bool = false
    public var brightness: Int16 = 100

    public init() {}
}
