import Foundation

public struct CollisionMask: Sendable, Equatable, Hashable {
    public var x: Int16
    public var y: Int16
    public var width: Int16
    public var height: Int16

    public init(x: Int16, y: Int16, width: Int16, height: Int16) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }
}
