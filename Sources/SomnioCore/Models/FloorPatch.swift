import Foundation

/// A rectangular floor-material override painted over the sector's base floor (a cobbled
/// street crossing a grass square). Pixel-space rect like `CollisionMask`; purely visual —
/// patches never affect collision or placement. The `floorMaterialID` resolves through the
/// model registry's `floorMaterials` table exactly like the sector's base floor id.
public struct FloorPatch: Sendable, Equatable, Hashable, Codable {
    public var floorMaterialID: String
    public var x: Int16
    public var y: Int16
    public var width: Int16
    public var height: Int16

    public init(floorMaterialID: String, x: Int16, y: Int16, width: Int16, height: Int16) {
        self.floorMaterialID = floorMaterialID
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }
}
