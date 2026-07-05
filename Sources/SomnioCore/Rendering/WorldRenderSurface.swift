import Foundation

/// Sub-pixel position on the legacy pixel grid. The simulation moves entities in whole
/// pixels, but the local player's per-tick step is a rotated fraction of a pixel; rendering
/// the carried fraction keeps a screen-straight walk from zigzagging along the integer grid.
public struct SubpixelPoint: Sendable, Equatable {
    public var x: Double
    public var y: Double

    public init(x: Double, y: Double) {
        self.x = x
        self.y = y
    }

    /// The nearest authoritative grid position, clamped into the `Int16` pixel domain — the
    /// one rule for collapsing a sub-pixel render position back onto the simulation grid.
    public var gridRounded: GridPoint {
        GridPoint(
            x: Int16(clamping: Int32(x.rounded())),
            y: Int16(clamping: Int32(y.rounded()))
        )
    }
}

/// Renderer-neutral surface the player client drives to present the world. The view model
/// holds `any WorldRenderSurface` and calls only these methods, so the concrete renderer —
/// the SpriteKit `WorldScene` or the RealityKit `WorldScene3D` — is a single wiring choice in
/// the app entry rather than a coupling baked into the view model.
///
/// `@MainActor`-isolated because the conforming render objects are non-Sendable main-actor
/// types (an `SKScene`, a RealityKit `Entity` graph) and the driving view model is itself
/// main-actor isolated — the protocol-level isolation matches its call sites.
@MainActor public protocol WorldRenderSurface {
    /// Swaps the rendered sector. When `awaitingPlayerPlacement` is `true` the held visual stays
    /// on screen until the local player is placed, avoiding a frame of the new sector framed on
    /// its origin with no character.
    func load(sector: Sector, awaitingPlayerPlacement: Bool)
    func placeEntity(_ entity: WorldEntity)
    func updatePosition(entityID: Int16, to position: GridPoint, facing: Direction)
    /// Sub-pixel variant for the locally predicted player, whose per-tick step carries a
    /// rounding fraction. Renderers that can only place entities on the integer grid inherit
    /// the default, which rounds and forwards to the grid variant.
    func updatePosition(entityID: Int16, to position: SubpixelPoint, facing: Direction)
    func animateEntity(_ id: Int16, to position: GridPoint, facing: Direction, duration: TimeInterval)
    /// Movement-speed change for an already placed entity, so renderers with tempo-specific
    /// motion clips (sneak/walk/run) can switch loops. Defaults to a no-op for renderers
    /// whose walk presentation is tempo-agnostic.
    func updateTempo(entityID: Int16, tempo: Tempo)
    func updateDayNightTint(hour: Int16, minute: Int16, sectorLight: LightSetting)
    func showSpeechBubble(above entityID: Int16, lines: [String], lifetimeMs: Int)
    func removeEntity(id: Int16)
    func showSplash()
}

public extension WorldRenderSurface {
    func updateTempo(entityID _: Int16, tempo _: Tempo) {}

    func updatePosition(entityID: Int16, to position: SubpixelPoint, facing: Direction) {
        updatePosition(entityID: entityID, to: position.gridRounded, facing: facing)
    }
}
