import Foundation
import SpriteKit

/// Texture-pack accessor for the SpriteKit scene. Implementations resolve the legacy
/// asset-pack naming conventions described in the reference docs. The protocol is
/// `@MainActor`-isolated because `SKTexture` is a non-Sendable SpriteKit reference type
/// bound to the main actor; the scene that calls these methods is itself main-actor
/// isolated, so the protocol-level isolation matches its call sites.
///
/// `groundTexture` takes only three params because each engine tile is composed at
/// load time from a 4 × 4 grid of 32 × 32 source-pack pixels — the slicing is implicit
/// in the implementation. `objectTexture` takes an explicit five-param source rect
/// because the `Object` record carries its own width and height which can be any size.
@MainActor public protocol SpriteAssets {
    func groundTexture(tilesetIndex: Int16, sourceX: Int16, sourceY: Int16) -> SKTexture?
    func objectTexture(
        tilesetIndex: Int16,
        sourceX: Int16,
        sourceY: Int16,
        sourceWidth: Int16,
        sourceHeight: Int16
    ) -> SKTexture?
    func characterTexture(figure: Int16, frame: Int) -> SKTexture?
    func npcTexture(figure: Int16, frame: Int) -> SKTexture?
    func monsterTexture(figure: Int16, frame: Int) -> SKTexture?
    func animationStrip(name: String) -> SKTexture?
    func splash() -> SKTexture?
}

/// Production texture loader. Until the asset pack lands, every method returns `nil`
/// from the runtime bundle; the scene still renders splash-as-placeholder and uses
/// untextured nodes. Tests inject a `MainActor`-isolated stub instead.
@MainActor public final class BundleMainSpriteAssets: SpriteAssets {
    public init() {}

    public func groundTexture(tilesetIndex _: Int16, sourceX _: Int16, sourceY _: Int16) -> SKTexture? {
        nil
    }

    public func objectTexture(
        tilesetIndex _: Int16,
        sourceX _: Int16,
        sourceY _: Int16,
        sourceWidth _: Int16,
        sourceHeight _: Int16
    ) -> SKTexture? {
        nil
    }

    public func characterTexture(figure _: Int16, frame _: Int) -> SKTexture? {
        nil
    }

    public func npcTexture(figure _: Int16, frame _: Int) -> SKTexture? {
        nil
    }

    public func monsterTexture(figure _: Int16, frame _: Int) -> SKTexture? {
        nil
    }

    public func animationStrip(name _: String) -> SKTexture? {
        nil
    }

    public func splash() -> SKTexture? {
        nil
    }
}
