import Foundation

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
    func animateEntity(_ id: Int16, to position: GridPoint, facing: Direction, duration: TimeInterval)
    func updateDayNightTint(hour: Int16, minute: Int16, sectorLight: LightSetting)
    func showSpeechBubble(above entityID: Int16, lines: [String], lifetimeMs: Int)
    func removeEntity(id: Int16)
    func showSplash()
}
