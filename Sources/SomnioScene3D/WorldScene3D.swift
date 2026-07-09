import AppKit
import Foundation
import Logging
import RealityKit
import simd
import SomnioCore

/// RealityKit render surface for the player client and the map editor. Owns the `Entity`
/// graph hosted by `WorldScene3DView`: `rootEntity` carries only the scene-persistent pieces —
/// the orthographic 3/4 camera, the retained sun + ambient fill lights — and the per-sector
/// roots. Everything sector-scoped (floor, placed objects, entities, name plaques, speech
/// bubbles, the editor's authoring overlay) lives under a per-sector root so a sector swap is a single
/// subtree replace (the `sectorRoot`/`previousRoot` held-swap state machine).
///
/// Real 3D depth: objects and entities sit on the floor (Y = 0) at their world XZ, and the
/// camera's perspective plus the depth buffer give draw order for free — no painter's
/// algorithm, no Y-flip.
@MainActor public final class WorldScene3D: WorldRenderSurface {
    private static let logger = Logger(label: "de.tobiha.somnio.scene3d.scene")

    /// Per-entity render state the scene mutates each tick. `WorldEntity` is a value type
    /// rebuilt from every wire `EntityMessage`, so the walk/tween clocks and the slewed yaw
    /// can't live there — they live here, keyed by the sector-local entity index.
    private final class EntityRenderState {
        /// Stable transform node carrying translation only: `modelHolder` (the swappable
        /// clone/placeholder), the speech bubble, and the name plaque hang off it, so a
        /// post-prewarm model swap never touches the overlays. The facing yaw lives on
        /// `modelHolder`, never here — the screen-aligned overlays must not inherit it.
        let node: Entity
        let modelHolder: Entity
        var kind: WorldEntity.Kind
        var figure: Int16
        var name: String
        var maskSize: GridSize
        var facing: Heading
        var tempo: Tempo
        var lastPosition: GridPoint
        /// Heading of the most recent travel step, used to bucket the directional movement clip
        /// against `facing`. Set by whichever driver saw the move (threaded from the local
        /// predictor's intended vector, or derived from a peer's grid delta) and cleared on an
        /// authoritative snap; persists across the grace window so the clip holds through a glide.
        var travelHeading: Heading?
        var currentYaw: Float
        /// Scene-clock time of the most recent position change; `tick` derives the
        /// moving/idle signal from how recently this was.
        var lastMotionTime: TimeInterval
        /// One-shot: set when a driver path sees a position delta, consumed in `tick`.
        var pendingMotion: Bool
        /// Seconds of motion still owed to an in-flight `animateEntity` tween, so the walk
        /// clip runs across the whole glide rather than freezing after the grace window.
        var remainingTweenMotion: TimeInterval
        var tween: PositionTween?
        var isPlaceholder: Bool
        /// Billboarded name label under the feet; created once on first placement (players
        /// and NPCs; monsters get none) and rebuilt on a kind change.
        var namePlaque: Entity?
        /// Last pose whose clip was started on the model; `nil` until the first tick (and
        /// reset when a model swap discards the playing clip).
        var pose: AnimationPose?

        init(node: Entity, modelHolder: Entity, entity: WorldEntity, isPlaceholder: Bool) {
            self.node = node
            self.modelHolder = modelHolder
            self.kind = entity.kind
            self.figure = entity.figure
            self.name = entity.name
            self.maskSize = entity.maskSize
            self.facing = entity.facing
            self.tempo = entity.tempo
            self.lastPosition = entity.position
            self.travelHeading = nil
            self.currentYaw = entity.facing.radians
            self.lastMotionTime = -.infinity
            self.pendingMotion = false
            self.remainingTweenMotion = 0
            self.tween = nil
            self.isPlaceholder = isPlaceholder
            self.pose = nil
        }
    }

    /// Scene-driven position interpolation for `animateEntity`. Driven from `tick` instead of
    /// RealityKit's transform animation so the per-tick yaw slew and a position glide never
    /// fight over the same transform.
    private struct PositionTween {
        var start: SIMD3<Float>
        var target: SIMD3<Float>
        var total: TimeInterval
        var remaining: TimeInterval
    }

    enum AnimationPose {
        case idle
        case sneaking
        case walking
        case running
        case backpedal
        case strafeLeft
        case strafeRight
    }

    /// Movement clip per tempo and travel direction: the legacy Option-slow tempo reads as
    /// sneaking and the Shift tempo as running, but only when moving forward and only for
    /// player-kind figures. Backpedaling and strafing collapse to their single directional clip
    /// regardless of tempo (no tier-specific slow/fast variants exist). NPCs amble on the plain
    /// walk clip (the librarian must not skulk through its own room) and monsters drift on their
    /// single clip regardless, so `direction` is ignored for both.
    static func movementPose(kind: WorldEntity.Kind, tempo: Tempo, direction: RelativeDirection) -> AnimationPose {
        switch kind {
        case .player, .peer:
            switch direction {
            case .forward:
                switch tempo {
                case .walk: .sneaking
                case .default: .walking
                case .run: .running
                }
            case .backward: .backpedal
            case .strafeLeft: .strafeLeft
            case .strafeRight: .strafeRight
            }
        case .npc, .monster:
            .walking
        }
    }

    /// One placed object's re-resolution record: the retained authored object + stable node
    /// let the post-prewarm pass swap a placeholder for the real prop and re-align it in place.
    private final class PlacedObject {
        let object: Object
        let node: Entity
        let anchorBottomY: Float
        var isPlaceholder: Bool

        init(object: Object, node: Entity, anchorBottomY: Float, isPlaceholder: Bool) {
            self.object = object
            self.node = node
            self.anchorBottomY = anchorBottomY
            self.isPlaceholder = isPlaceholder
        }
    }

    /// The floor's re-resolution record, the material analog of `PlacedObject`: when a sector
    /// loads before the floor-texture cache warms, `makeFloor` builds a gray-fallback floor and
    /// records `isFallback`, so the post-prewarm pass can re-tint it in place against the warm
    /// cache — the floor heals like every placed model rather than staying untextured.
    private struct FloorRenderState {
        let entity: ModelEntity
        let materialID: String
        let widthMeters: Float
        let depthMeters: Float
        var isFallback: Bool
    }

    /// Idle threshold: an entity counts as moving for this long after its last position change.
    private static let motionGraceWindow: TimeInterval = 0.15
    /// Upper bound on one tick's dt so a stall cannot teleport tweens or the walk clock.
    private static let maxTickDelta: TimeInterval = 0.1
    private static let clipTransitionDuration: TimeInterval = 0.2
    /// Clip preference per pose; the Ghost carries only `Flying_Idle`, so every pose falls
    /// through to it and the drift never freezes. Sneak/run fall back to the walk clip for
    /// models converted before those clips were merged in.
    private static let idleClipNames = ["Idle", "Flying_Idle"]
    private static let walkClipNames = ["Walking_A", "Flying_Idle"]
    private static let sneakClipNames = ["Sneaking", "Walking_A", "Flying_Idle"]
    private static let runClipNames = ["Running_A", "Walking_A", "Flying_Idle"]
    /// Directional movement clips, each falling back to the forward walk clip so models
    /// converted before those clips were merged in still render (no reverse-play or rate scaling —
    /// a gap tier collapses to the single available directional clip regardless of tempo).
    private static let backpedalClipNames = ["Walking_Backwards", "Walking_A", "Flying_Idle"]
    private static let strafeLeftClipNames = ["Running_Strafe_Left", "Walking_A", "Flying_Idle"]
    private static let strafeRightClipNames = ["Running_Strafe_Right", "Walking_A", "Flying_Idle"]
    /// Gap between a speaker's head (model bounds top) and the bubble's tail tip.
    private static let bubbleHeadGap: Float = 0.2
    /// Screen-space gap between the feet anchor and the plaque's top edge. Legacy pinned the
    /// plaque 1 px below the sprite's feet, but the feet anchor is the mask *center* and the
    /// 3D body visually spills below it, so the plaque needs real clearance or it clips into
    /// the model's legs.
    private static let plaqueFeetGap: Float = 0.15
    /// Extra toward-camera advance past the point where the plaque's below-the-feet quad
    /// clears the floor plane (see `namePlaqueEntity`).
    private static let plaqueFloorClearance: Float = 0.15
    private static let placeholderMaterial = SimpleMaterial(color: .gray, isMetallic: false)

    /// Added to the `RealityView` by `WorldScene3DView`; internal, not private, so the host view can reach it.
    let rootEntity = Entity()
    /// Internal (not private) alongside `rootEntity` so lifecycle tests can probe camera focus
    /// and the retained light rig without widening the public surface.
    let cameraEntity = Entity()
    let sunEntity = Entity()
    let ambientEntity = Entity()
    /// Last camera focus, anchoring the sun's fixed shadow volume (see `repositionSun`).
    private var sunFocus = SIMD3<Float>.zero

    /// `.automatic` fits the shadow volume to the camera frustum, which fails to produce any
    /// shadow under the orthographic gameplay camera; a fixed volume around the
    /// camera-followed focus (see `repositionSun`) renders reliably and keeps the map dense.
    /// Re-set alongside every `DirectionalLightComponent` update in `applySunState`.
    private static var sunShadow: DirectionalLightComponent.Shadow {
        var shadow = DirectionalLightComponent.Shadow()
        shadow.shadowProjection = .fixed(zNear: 1, zFar: 60, orthographicScale: 24)
        return shadow
    }

    private let modelAssets: any ModelAssets
    private var sectorRoot: Entity?
    /// On a player-driven sector switch the incoming `sectorRoot` is added disabled and the
    /// outgoing root is parked here (kept on screen) until the player is placed, then swapped —
    /// so the new sector never shows framed on its origin without a character. `nil` outside a
    /// switch.
    private var previousRoot: Entity?
    /// `true` between an `awaitingPlayerPlacement` load and the player's placement: the gate
    /// that triggers the atomic swap (enable new root, drop `previousRoot`) in `placeEntity`.
    private var pendingPlayerReveal = false
    /// During a held sector switch the incoming sector's sun state is stashed here instead of
    /// being applied — the lights are scene-persistent, so applying immediately would relight
    /// the still-visible outgoing sector. Consumed by `revealHeldSectorIfPending`.
    private var pendingSunState: SunState?
    private var entityRenderStates: [Int16: EntityRenderState] = [:]
    private var placedObjects: [PlacedObject] = []
    /// `nil` before the first load and after `showSplash`.
    private var floorRenderState: FloorRenderState?
    /// Editor-only authoring gizmos (record rects, selection highlight, grid), parented under
    /// `sectorRoot` so a sector swap tears them down with everything else sector-scoped.
    /// Internal (not private) so the overlay extension in `AuthoringOverlay.swift` can own the
    /// rebuild; `nil` until the editor's first `updateAuthoringOverlay` after a load.
    var authoringOverlayRoot: Entity?
    private var speechBubbles: [Int16: SpeechBubble] = [:]
    private var sceneClock: TimeInterval = 0
    /// Entity index of the local player — the camera-follow target. Set when an entity of
    /// kind `.player` is first placed.
    private var cameraFollowID: Int16?

    private struct SpeechBubble {
        var node: Entity
        var remainingLifetime: TimeInterval
    }

    public init(modelAssets: any ModelAssets = BundleMainModelAssets()) {
        self.modelAssets = modelAssets
        var camera = OrthographicCameraComponent()
        camera.scale = OrthographicCameraRig.defaultScale
        camera.near = OrthographicCameraRig.nearClip
        camera.far = OrthographicCameraRig.farClip
        cameraEntity.components.set(camera)
        rootEntity.addChild(cameraEntity)

        // The void outside the sector floor: a huge unlit black plane just below ground level,
        // scene-persistent so every sector (and the gap during a swap) sits on black instead
        // of the view's default white environment.
        let backdrop = ModelEntity(
            mesh: .generatePlane(width: 400, depth: 400),
            materials: [UnlitMaterial(color: .black)]
        )
        backdrop.position = SIMD3<Float>(0, -0.005, 0)
        rootEntity.addChild(backdrop)

        sunEntity.components.set(Self.sunShadow)
        rootEntity.addChild(sunEntity)
        // Fixed low fill opposite the arc's southward lean, standing in for sky ambience so
        // the shadow side never drops to black; `applySunState` only retunes its intensity.
        ambientEntity.orientation = OrthographicCameraRig.lookRotation(from: normalize(SIMD3<Float>(-0.3, 1, -0.4)), to: .zero)
        rootEntity.addChild(ambientEntity)
        applySunState(DayNightSun.state(hour: 12, minute: 0, sectorLight: LightSetting(indoor: false, brightness: 100)))

        showSplash()
    }

    /// Warms the model-prototype cache, then re-resolves every placeholder already on screen
    /// (or held hidden for a pending reveal) against the warm cache — so an arrival that wins
    /// the race against prewarm self-heals instead of leaving permanent placeholders.
    public func prewarmModels() async {
        await modelAssets.prewarm()
        refreshResolvedModels()
    }

    /// Swaps the rendered sector. When `awaitingPlayerPlacement` is `true` the held visual —
    /// the outgoing sector on a portal hop, or the splash-era emptiness on first login — stays
    /// on screen and the incoming sector is added disabled, until `placeEntity` places the
    /// player and swaps atomically, avoiding a frame of the new sector framed on its origin
    /// with no character.
    public func load(sector: Sector, awaitingPlayerPlacement: Bool) {
        if awaitingPlayerPlacement {
            previousRoot?.removeFromParent()
            previousRoot = sectorRoot
        } else {
            previousRoot?.removeFromParent()
            sectorRoot?.removeFromParent()
            previousRoot = nil
        }
        entityRenderStates.removeAll()
        speechBubbles.removeAll()
        placedObjects.removeAll()
        authoringOverlayRoot = nil
        cameraFollowID = nil

        let root = Entity()
        let floorCenter = makeFloor(for: sector, into: root)
        placeObjects(of: sector, into: root)
        root.isEnabled = !awaitingPlayerPlacement
        rootEntity.addChild(root)
        sectorRoot = root
        pendingPlayerReveal = awaitingPlayerPlacement
        if !awaitingPlayerPlacement {
            // Frame the whole sector for consumers without a player; the player client's
            // `placeEntity` re-centers on the character immediately after load. During a held
            // switch the camera stays on the outgoing sector until the swap re-centers it.
            focusCamera(on: floorCenter)
        }
    }

    public func placeEntity(_ entity: WorldEntity) {
        let state: EntityRenderState
        if let existing = entityRenderStates[entity.id] {
            state = existing
            if state.kind != entity.kind || state.figure != entity.figure {
                state.isPlaceholder = !resolveModel(into: existing.modelHolder, kind: entity.kind, figure: entity.figure, maskSize: entity.maskSize)
                state.pose = nil
            }
            if state.kind != entity.kind || state.name != entity.name {
                // A kind change restyles the plaque and a name change relabels it (an NPC
                // label would linger on a monster band, a renamed entity would keep its old
                // label); the attach below rebuilds it.
                state.namePlaque?.removeFromParent()
                state.namePlaque = nil
            }
            state.kind = entity.kind
            state.figure = entity.figure
            state.name = entity.name
            state.maskSize = entity.maskSize
        } else {
            let node = Entity()
            let modelHolder = Entity()
            node.addChild(modelHolder)
            let resolved = resolveModel(into: modelHolder, kind: entity.kind, figure: entity.figure, maskSize: entity.maskSize)
            state = EntityRenderState(node: node, modelHolder: modelHolder, entity: entity, isPlaceholder: !resolved)
            sectorRoot?.addChild(node)
            entityRenderStates[entity.id] = state
        }
        attachNamePlaqueIfNeeded(to: state, entity: entity)

        state.facing = entity.facing
        if entity.position != state.lastPosition {
            state.pendingMotion = true
            state.lastPosition = entity.position
        }
        state.tween = nil
        let world = Self.entityWorldPosition(position: entity.position, maskSize: entity.maskSize)
        state.node.position = world
        state.modelHolder.orientation = simd_quatf(angle: state.currentYaw, axis: [0, 1, 0])

        if entity.kind == .player {
            cameraFollowID = entity.id
            focusCamera(on: world)
            revealHeldSectorIfPending()
        }
    }

    public func updatePosition(entityID: Int16, to position: GridPoint, facing: Heading) {
        // An authoritative snap (arrival, or the local player's post-rejection `snapBack`) is a
        // position discontinuity: any carried travel direction is the meaningless rejected-move
        // direction, so clear it before forwarding with `travel: nil` (which now preserves the
        // clear). The next `RelativeDirection` then defaults to `.forward` rather than a stale clip.
        entityRenderStates[entityID]?.travelHeading = nil
        updatePosition(entityID: entityID, to: SubpixelPoint(x: Double(position.x), y: Double(position.y)), facing: facing, travel: nil)
    }

    public func updatePosition(entityID: Int16, to position: SubpixelPoint, facing: Heading, travel: Heading? = nil) {
        guard let state = entityRenderStates[entityID] else {
            Self.logger.debug("updatePosition called for unknown entity", metadata: ["entity_id": "\(entityID)"])
            return
        }
        let grid = position.gridRounded
        if grid != state.lastPosition {
            state.pendingMotion = true
            state.lastPosition = grid
        }
        state.facing = facing
        // Only overwrite on a real travel step; a stationary tick or the tail of a glide passes
        // `nil` so the last direction persists across the grace window for the held clip.
        if let travel {
            state.travelHeading = travel
        }
        state.tween = nil
        let world = Self.entityWorldPosition(exact: position, maskSize: state.maskSize)
        state.node.position = world
        if entityID == cameraFollowID {
            focusCamera(on: world)
        }
    }

    /// Glides the entity from its current world position to the new grid position over
    /// `duration` seconds. The glide is integrated in `tick` (not a RealityKit transform
    /// animation) so it composes with the per-tick yaw slew; `remainingTweenMotion` keeps the
    /// walk clip running across the whole glide (peers update on the sparse ~500 ms heartbeat).
    public func animateEntity(_ id: Int16, to position: GridPoint, facing: Heading, duration: TimeInterval) {
        guard let state = entityRenderStates[id] else {
            Self.logger.debug("animateEntity called for unknown entity", metadata: ["entity_id": "\(id)"])
            return
        }
        if position != state.lastPosition {
            state.pendingMotion = true
            state.remainingTweenMotion = duration
            // Derive the peer's travel heading from the grid delta (they carry no continuous
            // vector). Widen to Float before subtracting so Int16 grid math never overflows;
            // grid axes are x east, y south — the `Heading(dx:dy:)` convention.
            state.travelHeading = Heading(
                dx: Float(position.x) - Float(state.lastPosition.x),
                dy: Float(position.y) - Float(state.lastPosition.y)
            )
            state.lastPosition = position
        }
        state.facing = facing
        let target = Self.entityWorldPosition(position: position, maskSize: state.maskSize)
        state.tween = PositionTween(start: state.node.position, target: target, total: duration, remaining: duration)
    }

    public func updateTempo(entityID: Int16, tempo: Tempo) {
        entityRenderStates[entityID]?.tempo = tempo
    }

    public func updateDayNightTint(hour: Int16, minute: Int16, sectorLight: LightSetting) {
        let sunState = DayNightSun.state(hour: hour, minute: minute, sectorLight: sectorLight)
        guard !pendingPlayerReveal else {
            // Mid-switch: the lights are scene-persistent, so stash the destination state and
            // keep the parked outgoing sector under its own lighting until the atomic reveal.
            pendingSunState = sunState
            return
        }
        applySunState(sunState)
    }

    /// Renders pre-wrapped speech bubble lines as a billboarded balloon parented to the
    /// speaker's node, so it follows tweens and is torn down with the sector root. `lifetimeMs`
    /// is integer milliseconds matching the legacy `2000 + lines × 1000` rule; expiry is
    /// driven by `tick`.
    public func showSpeechBubble(above entityID: Int16, lines: [String], lifetimeMs: Int) {
        guard let state = entityRenderStates[entityID] else { return }
        speechBubbles[entityID]?.node.removeFromParent()
        let bubble = Self.speechBubbleEntity(lines: lines)
        // Measure the model only — the persistent name plaque hanging off the node would
        // otherwise stretch the bounds and push the bubble up.
        let headHeight = state.modelHolder.visualBounds(relativeTo: state.node).max.y
        bubble.position = SIMD3<Float>(0, max(headHeight, 0) + Self.bubbleHeadGap, 0)
        state.node.addChild(bubble)
        speechBubbles[entityID] = SpeechBubble(node: bubble, remainingLifetime: TimeInterval(lifetimeMs) / 1000)
    }

    /// Removes the entity's node (and its bubble with it). Called on `.leave`.
    public func removeEntity(id: Int16) {
        if let state = entityRenderStates.removeValue(forKey: id) {
            state.node.removeFromParent()
        }
        speechBubbles.removeValue(forKey: id)
    }

    public func showSplash() {
        sectorRoot?.removeFromParent()
        sectorRoot = nil
        // Drop any sector parked for an in-flight switch the splash interrupts (e.g. Leave Game).
        previousRoot?.removeFromParent()
        previousRoot = nil
        pendingPlayerReveal = false
        pendingSunState = nil
        entityRenderStates.removeAll()
        speechBubbles.removeAll()
        placedObjects.removeAll()
        floorRenderState = nil
        authoringOverlayRoot = nil
        cameraFollowID = nil
        focusCamera(on: .zero)
    }

    /// Per-frame driver, forwarded by `WorldScene3DView` from the RealityKit scene's
    /// `SceneEvents.Update`. Pure accumulation over per-entity state, so yaw/walk behavior is
    /// unit-testable by calling it directly — no live scene needed.
    public func tick(deltaTime: TimeInterval) {
        let dt = min(deltaTime, Self.maxTickDelta)
        sceneClock += dt

        for state in entityRenderStates.values {
            if var tween = state.tween {
                tween.remaining = max(0, tween.remaining - dt)
                let fraction = tween.total > 0 ? Float(1 - tween.remaining / tween.total) : 1
                state.node.position = simd_mix(tween.start, tween.target, SIMD3<Float>(repeating: fraction))
                state.tween = tween.remaining > 0 ? tween : nil
            }
            if state.pendingMotion {
                state.lastMotionTime = sceneClock
                state.pendingMotion = false
            }
            // Drain owed tween motion so a gliding entity counts as moving for the whole
            // glide, not just the grace window after its single position delta.
            if state.remainingTweenMotion > 0 {
                state.remainingTweenMotion -= dt
                state.lastMotionTime = sceneClock
            }
            let isMoving = (sceneClock - state.lastMotionTime) < Self.motionGraceWindow

            let targetYaw = state.facing.radians
            if state.currentYaw != targetYaw {
                state.currentYaw = YawSlew.step(from: state.currentYaw, toward: targetYaw, deltaTime: dt)
                state.modelHolder.orientation = simd_quatf(angle: state.currentYaw, axis: [0, 1, 0])
            }

            let direction = state.travelHeading.map { RelativeDirection(travel: $0, facing: state.facing) } ?? .forward
            applyPose(isMoving ? Self.movementPose(kind: state.kind, tempo: state.tempo, direction: direction) : .idle, to: state)
        }

        expireSpeechBubbles(after: dt)
    }

    // MARK: - Sector geometry

    /// Physical repeat size of a dedicated floor-material texture: large enough that plank
    /// and blade detail reads at the fixed 3 m viewport without visible tiling cadence.
    private static let floorMaterialTileMeters: Float = 1.6

    /// Builds the sector floor under `root` and returns its center (the whole-sector camera
    /// focus). Resolves the dedicated floor material from the sector's `floorMaterialID` —
    /// `generatePlane` emits 0..1 UVs, so tiling needs both the repeat sampler and the UV
    /// scale on the material's coordinate transform. Nil-fallback: a solid lit gray plane.
    private func makeFloor(for sector: Sector, into root: Entity) -> SIMD3<Float> {
        let widthMeters = Float(sector.pixelWidth) * OrthographicCameraRig.worldUnitsPerPixel
        let depthMeters = Float(sector.pixelHeight) * OrthographicCameraRig.worldUnitsPerPixel
        let mesh = MeshResource.generatePlane(width: widthMeters, depth: depthMeters)
        let texture = modelAssets.floorMaterialTexture(forID: sector.floorMaterialID)
        let floor = ModelEntity(
            mesh: mesh,
            materials: [Self.floorMaterial(texture: texture, widthMeters: widthMeters, depthMeters: depthMeters)]
        )
        // `generatePlane` centers the mesh at the origin; offset by half so the sector's
        // top-left pixel origin (0, 0) maps to a floor corner, matching
        // `OrthographicCameraRig.worldPosition`.
        let center = SIMD3<Float>(widthMeters / 2, 0, depthMeters / 2)
        floor.position = center
        root.addChild(floor)
        floorRenderState = FloorRenderState(
            entity: floor,
            materialID: sector.floorMaterialID,
            widthMeters: widthMeters,
            depthMeters: depthMeters,
            isFallback: texture == nil
        )
        return center
    }

    /// The floor plane's material: the tiled floor texture over a matte PBR base, or a solid gray
    /// tint when the texture is not (yet) cached. Shared by `makeFloor` and the post-prewarm
    /// re-tint so a healed floor is byte-for-byte the eager-load result.
    private static func floorMaterial(texture: TextureResource?, widthMeters: Float, depthMeters: Float) -> PhysicallyBasedMaterial {
        var material = PhysicallyBasedMaterial()
        material.roughness = .init(floatLiteral: 1)
        material.metallic = .init(floatLiteral: 0)
        guard let texture else {
            material.baseColor = .init(tint: NSColor(white: 0.5, alpha: 1))
            return material
        }
        // Metal sampler defaults are nearest filtering with mipmaps ignored — the generated
        // mip chain only suppresses minification shimmer if the sampler actually filters
        // through it, and the tilted camera needs anisotropy on top or the tiling still
        // sparkles at grazing angles.
        let sampler: MaterialParameters.Texture.Sampler = {
            let descriptor = MTLSamplerDescriptor()
            descriptor.sAddressMode = .repeat
            descriptor.tAddressMode = .repeat
            descriptor.minFilter = .linear
            descriptor.magFilter = .linear
            descriptor.mipFilter = .linear
            descriptor.maxAnisotropy = 8
            return .init(descriptor)
        }()
        material.baseColor = .init(tint: .white, texture: .init(texture, sampler: sampler))
        // Non-square source textures (plank strips) keep their authored aspect: the v
        // repeat shrinks with the texture's height/width ratio.
        let aspect = Float(texture.height) / Float(texture.width)
        material.textureCoordinateTransform = .init(scale: SIMD2<Float>(
            widthMeters / Self.floorMaterialTileMeters,
            depthMeters / (Self.floorMaterialTileMeters * aspect)
        ))
        return material
    }

    private func placeObjects(of sector: Sector, into root: Entity) {
        for object in sector.objects.sorted(by: { $0.priority < $1.priority }) {
            let node = Entity()
            let resolved = modelAssets.object(forID: object.modelID)
            node.addChild(resolved ?? Self.objectPlaceholder(for: object))
            let anchorBottomY = Self.objectAnchorBottomY(for: object, masks: sector.collisionMasks)
            Self.alignObjectNode(node, for: object, anchorBottomY: anchorBottomY)
            root.addChild(node)
            placedObjects.append(PlacedObject(
                object: object, node: node, anchorBottomY: anchorBottomY, isPlaceholder: resolved == nil
            ))
        }
    }

    /// The legacy pixel row a prop's physical base stands on. Defaults to the decal rect's
    /// bottom edge (the 2D art draws standing furniture with its base there), but when a
    /// collision mask overlaps the decal and ends within one ground cell above that edge,
    /// the mask's south edge wins: the mask is the authored physical footprint, and art
    /// below it is deliberate 2D front-face overhang the player was allowed to stand on
    /// (painter's order made the overlap read fine in 2D; in 3D it walks inside the mesh).
    /// Masks ending below the rect (a table's mask under a behind-it chair) never pull a
    /// prop south, and masks further than a cell above the edge are unrelated geometry.
    static func objectAnchorBottomY(for object: Object, masks: [CollisionMask]) -> Float {
        let rectBottom = Int32(object.y) + Int32(object.sourceHeight)
        let window = rectBottom - Int32(SomnioConstants.groundCellSize)
        let anchor = masks
            .filter { mask in
                let maskBottom = Int32(mask.y) + Int32(mask.height)
                return maskBottom >= window && maskBottom <= rectBottom
                    && Int32(mask.x) < Int32(object.x) + Int32(object.sourceWidth)
                    && Int32(mask.x) + Int32(mask.width) > Int32(object.x)
                    && Int32(mask.y) < rectBottom
                    && maskBottom > Int32(object.y)
            }
            .map { Int32($0.y) + Int32($0.height) }
            .max()
        return Float(anchor ?? rectBottom)
    }

    /// Placement normalization contract: a prop USDZ is authored/converted so its local origin
    /// sits at the model's ground-footprint center and its metric footprint width matches the
    /// authored `sourceWidth` × `worldUnitsPerPixel` — the loader adds no per-object scale.
    /// Placement anchors the footprint's SOUTH edge to `anchorBottomY` (see
    /// `objectAnchorBottomY`); centering on the whole rect would push props half a decal
    /// north of where the sprite stood. Per-rule transform metadata on `ObjectModelRule` is
    /// the deferred richer alternative if this convention proves insufficient.
    private static func alignObjectNode(_ node: Entity, for object: Object, anchorBottomY: Float) {
        let footprintDepth = node.visualBounds(relativeTo: node).extents.z
        var position = OrthographicCameraRig.worldPosition(forLegacyPoint: SIMD2<Float>(
            Float(object.x) + Float(object.sourceWidth) / 2,
            anchorBottomY
        ))
        position.z -= footprintDepth / 2
        node.position = position
    }

    /// Entities stand at their feet-box center — the same ground point the game's proximity
    /// gates use — with the legacy sprite-top-left position converted through it. The feet
    /// center is a constant offset from the sprite origin for a given mask size, so the
    /// sub-pixel origin adds onto the offset computed at the grid origin.
    private static func entityWorldPosition(position: GridPoint, maskSize: GridSize) -> SIMD3<Float> {
        entityWorldPosition(exact: SubpixelPoint(x: Double(position.x), y: Double(position.y)), maskSize: maskSize)
    }

    private static func entityWorldPosition(exact position: SubpixelPoint, maskSize: GridSize) -> SIMD3<Float> {
        let offset = FeetMask.center(forSpriteAt: GridPoint(x: 0, y: 0), spriteSize: maskSize)
        return OrthographicCameraRig.worldPosition(forLegacyPoint: SIMD2<Float>(
            Float(Double(offset.x) + position.x),
            Float(Double(offset.y) + position.y)
        ))
    }

    // MARK: - Model resolution

    /// Fills `holder` with the resolved model clone, or a mask-sized placeholder when the
    /// cache misses. Returns whether the real model resolved.
    private func resolveModel(into holder: Entity, kind: WorldEntity.Kind, figure: Int16, maskSize: GridSize) -> Bool {
        for child in Array(holder.children) {
            child.removeFromParent()
        }
        if let clone = modelAssets.entity(forKind: kind, figure: figure) {
            holder.addChild(clone)
            holder.scale = Self.characterScale(maskSize: maskSize)
            return true
        }
        holder.scale = .one
        holder.addChild(Self.entityPlaceholder(maskSize: maskSize))
        return false
    }

    /// Vertical fraction of the legacy cell a figure fills: the reference charsets stand
    /// ~37 px tall in the 48 px cell (headroom and foot gap take the rest), so a body scaled
    /// to the full cell height reads oversized next to the pixel-derived props.
    private static let characterCellFill: Float = 37.0 / 48.0

    /// Bind-pose figure height every character model is staged at (the asset pipeline's
    /// `character_normalize.py` contract, accessories excluded). The runtime scales by this
    /// constant instead of measuring the loaded model: RealityKit's skinned-mesh bounds
    /// include animation envelopes and merge accessory meshes unpredictably, so a runtime
    /// measurement mis-sizes characters model by model.
    static let canonicalFigureHeight: Float = 1.0

    /// Uniform scale normalizing a character model to its legacy figure height (the cell-fill
    /// fraction of the mask; 48 px cell ≈ 0.74 m figure). The feet box, proximity gates, and
    /// collision all live in legacy mask pixels, so the visible body must match that
    /// footprint — an unscaled source-kit character (~1.7 m) reads as clipping through
    /// furniture its mask legitimately walks past.
    static func characterScale(maskSize: GridSize) -> SIMD3<Float> {
        let target = Float(maskSize.height) * OrthographicCameraRig.worldUnitsPerPixel * Self.characterCellFill
        return SIMD3<Float>(repeating: target / canonicalFigureHeight)
    }

    /// Post-prewarm re-resolution pass: swaps every placeholder (placed objects and entities) for
    /// the now-cached real model in place and re-tints a gray-fallback floor with its now-cached
    /// texture, reaching the hidden pending `sectorRoot` too — its records are the current ones, so
    /// a pre-reveal placeholder heals before it is ever shown. Only meshes and the floor material
    /// are swapped; `isEnabled`/`pendingPlayerReveal` stay untouched.
    private func refreshResolvedModels() {
        for placed in placedObjects where placed.isPlaceholder {
            guard let clone = modelAssets.object(forID: placed.object.modelID) else { continue }
            for child in Array(placed.node.children) {
                child.removeFromParent()
            }
            placed.node.addChild(clone)
            // The real prop's footprint depth differs from the placeholder's, so the
            // bottom-edge anchor must be recomputed for the new bounds.
            Self.alignObjectNode(placed.node, for: placed.object, anchorBottomY: placed.anchorBottomY)
            placed.isPlaceholder = false
        }
        for state in entityRenderStates.values where state.isPlaceholder {
            // resolveModel is the single lookup: on a still-missing model it rebuilds an
            // equivalent placeholder box, which this one post-prewarm pass can afford.
            state.isPlaceholder = !resolveModel(into: state.modelHolder, kind: state.kind, figure: state.figure, maskSize: state.maskSize)
            state.pose = nil
        }
        if let floor = floorRenderState, floor.isFallback,
           let texture = modelAssets.floorMaterialTexture(forID: floor.materialID) {
            floor.entity.model?.materials = [Self.floorMaterial(
                texture: texture, widthMeters: floor.widthMeters, depthMeters: floor.depthMeters
            )]
            floorRenderState?.isFallback = false
        }
    }

    /// Gray standing box sized to the entity's mask — the nil-fallback for a figure whose
    /// model is unmapped or not yet cached.
    private static func entityPlaceholder(maskSize: GridSize) -> Entity {
        let width = Float(maskSize.width) * OrthographicCameraRig.worldUnitsPerPixel
        let height = Float(maskSize.height) * OrthographicCameraRig.worldUnitsPerPixel
        let box = ModelEntity(
            mesh: .generateBox(width: width, height: height, depth: width / 2),
            materials: [placeholderMaterial]
        )
        box.position.y = height / 2
        return box
    }

    /// Gray box over the object's authored footprint for unmapped/unavailable model ids.
    private static func objectPlaceholder(for object: Object) -> Entity {
        let width = Float(object.sourceWidth) * OrthographicCameraRig.worldUnitsPerPixel
        let depth = Float(object.sourceHeight) * OrthographicCameraRig.worldUnitsPerPixel
        let height = Float(SomnioConstants.groundCellSize) * OrthographicCameraRig.worldUnitsPerPixel
        let box = ModelEntity(
            mesh: .generateBox(width: width, height: height, depth: depth),
            materials: [placeholderMaterial]
        )
        box.position.y = height / 2
        return box
    }

    // MARK: - Reveal + lighting

    /// Atomic swap once the local player lands in a freshly loaded sector: drops the held
    /// outgoing sector, enables the new one, and applies the deferred destination lighting —
    /// so there's no empty-origin frame between load and placement.
    private func revealHeldSectorIfPending() {
        guard pendingPlayerReveal else { return }
        previousRoot?.removeFromParent()
        previousRoot = nil
        sectorRoot?.isEnabled = true
        pendingPlayerReveal = false
        if let sunState = pendingSunState {
            applySunState(sunState)
            pendingSunState = nil
        }
    }

    private func applySunState(_ state: SunState) {
        sunEntity.orientation = state.orientation
        repositionSun()
        sunEntity.components.set(DirectionalLightComponent(
            color: NSColor(red: CGFloat(state.sunColor.x), green: CGFloat(state.sunColor.y), blue: CGFloat(state.sunColor.z), alpha: 1),
            intensity: state.sunIntensity
        ))
        sunEntity.components.set(Self.sunShadow)
        ambientEntity.components.set(DirectionalLightComponent(color: .white, intensity: state.ambientIntensity))
    }

    // MARK: - Animation

    private func applyPose(_ pose: AnimationPose, to state: EntityRenderState) {
        guard state.pose != pose else { return }
        state.pose = pose
        let names = switch pose {
        case .idle: Self.idleClipNames
        case .sneaking: Self.sneakClipNames
        case .walking: Self.walkClipNames
        case .running: Self.runClipNames
        case .backpedal: Self.backpedalClipNames
        case .strafeLeft: Self.strafeLeftClipNames
        case .strafeRight: Self.strafeRightClipNames
        }
        guard let (owner, clip) = Self.animation(named: names, in: state.modelHolder) else { return }
        owner.playAnimation(Self.loopedClip(clip), transitionDuration: Self.clipTransitionDuration)
    }

    /// Loops a named clip verbatim — KayKit's clips are cadence-tuned as authored, so no
    /// playback-rate scaling. The converter authors each clip's window to end exactly at its
    /// content end (a `<clip>_hold` filler entry in the clip definition absorbs the baked
    /// inter-clip boundary frames), so the window is loop-closed as authored — any trim here
    /// would cut the closure frame and pop once per cycle.
    private static func loopedClip(_ clip: AnimationResource) -> AnimationResource {
        var definition = clip.definition
        definition.repeatMode = .repeat
        return (try? AnimationResource.generate(with: definition)) ?? clip.repeat()
    }

    /// First clip matching a preferred name, walking the model subtree — clips can hang off a
    /// descendant (the skeleton root) rather than the clone's root.
    private static func animation(named names: [String], in root: Entity) -> (owner: Entity, clip: AnimationResource)? {
        for name in names {
            if let found = firstAnimation(named: name, in: root) {
                return found
            }
        }
        return nil
    }

    private static func firstAnimation(named name: String, in entity: Entity) -> (owner: Entity, clip: AnimationResource)? {
        if let clip = entity.availableAnimations.first(where: { $0.name == name }) {
            return (entity, clip)
        }
        for child in entity.children {
            if let found = firstAnimation(named: name, in: child) {
                return found
            }
        }
        return nil
    }

    // MARK: - Billboard overlays

    /// Fixed screen-aligned orientation for overlay quads. The camera rig is locked, so a
    /// constant orientation replaces `BillboardComponent`: the component aims each quad at
    /// the camera *point* (50 m out), so off-focus speakers rendered visibly tilted text
    /// lines under the orthographic projection.
    private static let overlayOrientation = OrthographicCameraRig.cameraOrientation(focusing: .zero)

    /// Overlay world scale: legacy-pixel artwork mapped straight through `worldUnitsPerPixel`
    /// reads oversized under the zoomed-in 3D framing (the 3D viewport spans ~150 legacy px
    /// against the 2D game's 480), so plaques and bubbles shrink by this factor while keeping
    /// their legacy proportions. Preview-tuned: 1.0 dwarfed the characters, 0.6 read too
    /// tiny to stay legible.
    private static let overlayScale: Float = 0.8

    /// The world-quad footprint for overlay artwork authored in legacy pixels.
    private static func overlayWorldSize(_ sizePixels: CGSize) -> SIMD2<Float> {
        SIMD2<Float>(Float(sizePixels.width), Float(sizePixels.height)) * OrthographicCameraRig.worldUnitsPerPixel * overlayScale
    }

    /// Unlit textured material for the plaque/bubble quads: unlit so the artwork stays legible
    /// under the night sun, with the optional grayscale silhouette cutting the quad to shape.
    /// The overlay textures are tiny, so the (main-actor-blocking) synchronous upload is fine
    /// here — unlike the whole-sector floor textures the loader creates asynchronously. The
    /// nil-fallback (a failed upload) keeps the plain tint: a readable blank plate.
    /// Keep the default mip-chain sampling — mip-free linear sampling reads worse in the
    /// running game.
    private static func overlayMaterial(color: CGImage, opacityMask: CGImage?) -> UnlitMaterial {
        var material = UnlitMaterial(color: .white)
        if let texture = try? TextureResource(image: color, options: .init(semantic: .color, mipmapsMode: .allocateAndGenerateAll)) {
            material.color = .init(tint: .white, texture: .init(texture))
        }
        if let opacityMask,
           let mask = try? TextureResource(image: opacityMask, options: .init(semantic: .raw, mipmapsMode: .allocateAndGenerateAll)) {
            material.blending = .transparent(opacity: .init(texture: .init(mask)))
        }
        return material
    }

    /// Shared overlay quad: a screen-aligned container holding one textured plate at the
    /// given world size. Callers position the plate.
    private static func overlayQuad(
        color: CGImage, opacityMask: CGImage?, size: SIMD2<Float>
    ) -> (container: Entity, plate: ModelEntity) {
        let container = Entity()
        container.orientation = overlayOrientation
        let plate = ModelEntity(
            mesh: .generatePlane(width: size.x, height: size.y),
            materials: [overlayMaterial(color: color, opacityMask: opacityMask)]
        )
        container.addChild(plate)
        return (container, plate)
    }

    // MARK: - Name plaques

    /// Creates the entity's name plaque on first placement (players + NPCs; monsters get
    /// none), pinned under the feet like the legacy plaque. The local player's text is bold.
    private func attachNamePlaqueIfNeeded(to state: EntityRenderState, entity: WorldEntity) {
        guard state.namePlaque == nil else { return }
        let background: NSColor
        let bold: Bool
        switch entity.kind {
        case .player:
            background = NamePlaqueArt.playerBackground
            bold = true
        case .peer:
            background = NamePlaqueArt.playerBackground
            bold = false
        case .npc:
            background = NamePlaqueArt.npcBackground
            bold = false
        case .monster:
            return
        }
        guard let rendering = NamePlaqueArt.render(name: entity.name, background: background, bold: bold) else { return }
        let plaque = Self.namePlaqueEntity(rendering: rendering)
        state.node.addChild(plaque)
        state.namePlaque = plaque
    }

    /// Screen-aligned opaque quad hanging just below the feet anchor. In the quad's local
    /// space +Y is camera-up and +Z is toward the camera: hanging at negative Y alone would
    /// dip the quad below the floor plane, which always occludes below-ground content under
    /// the downward 3/4 camera. The toward-camera Z advance compensates — invisible under the
    /// orthographic projection, but it lifts the quad's world height above the floor and draws
    /// it in front of the speaker, matching the 2D scene's plaque-over-sprite ordering.
    private static func namePlaqueEntity(rendering: NamePlaqueArt.Rendering) -> Entity {
        let size = overlayWorldSize(rendering.sizePixels)
        let (container, plate) = overlayQuad(color: rendering.image, opacityMask: nil, size: size)
        let drop = size.y + plaqueFeetGap
        let pitch = OrthographicCameraRig.pitchDegrees * .pi / 180
        plate.position = SIMD3<Float>(0, -(size.y / 2 + plaqueFeetGap), drop / tan(pitch) + plaqueFloorClearance)
        return container
    }

    // MARK: - Speech bubbles

    /// Screen-aligned comic balloon anchored at its tail tip (like the legacy node), so the
    /// caller can pin the tip just above the speaker's head with the body rising above it.
    private static func speechBubbleEntity(lines: [String]) -> Entity {
        guard !lines.isEmpty, let rendering = SpeechBubbleArt.render(lines: lines) else { return Entity() }
        let size = overlayWorldSize(rendering.sizePixels)
        let (container, plate) = overlayQuad(color: rendering.color, opacityMask: rendering.opacityMask, size: size)
        plate.position = SIMD3<Float>(0, size.y / 2, 0)
        return container
    }

    private func expireSpeechBubbles(after dt: TimeInterval) {
        for (id, var bubble) in speechBubbles {
            bubble.remainingLifetime -= dt
            if bubble.remainingLifetime <= 0 {
                bubble.node.removeFromParent()
                speechBubbles.removeValue(forKey: id)
            } else {
                speechBubbles[id] = bubble
            }
        }
    }

    // MARK: - Camera

    /// Player camera path: the interactive scroll zoom over the height-independent default
    /// framing. `defaultScale` is deliberately NOT scaled by viewport height (unlike the
    /// editor's `playerZoomScale`): every window size shows the same vertical world extent —
    /// a bigger window magnifies rather than reveals (MMO fairness), with width following
    /// the aspect ratio. Routed through `clampedScale` so the rig bound and the
    /// `PlayerZoom` clamp agree by construction. Camera focus is untouched — it keeps
    /// following the player.
    public func applyPlayerFraming(zoomFactor: Double) {
        if var camera = cameraEntity.components[OrthographicCameraComponent.self] {
            camera.scale = OrthographicCameraRig.clampedScale(OrthographicCameraRig.defaultScale / Float(zoomFactor))
            cameraEntity.components.set(camera)
        }
    }

    /// Editor camera path: applies a whole-sector fit (focus + orthographic scale) computed by
    /// `OrthographicCameraRig.editorFraming`. Deliberately not clamped to the gameplay zoom
    /// bounds — the fit for a large sector exceeds `maxScale`, and clamping would crop it.
    public func applyEditorFraming(_ framing: EditorFraming) {
        if var camera = cameraEntity.components[OrthographicCameraComponent.self] {
            camera.scale = framing.scale
            cameraEntity.components.set(camera)
        }
        focusCamera(on: framing.focus)
    }

    /// Reads the sector graph's current authoring-overlay container, creating and parenting it
    /// under `sectorRoot` on first use after a load. `nil` when no sector is loaded.
    func resolvedAuthoringOverlayRoot() -> Entity? {
        guard let sectorRoot else { return nil }
        if let existing = authoringOverlayRoot { return existing }
        let overlay = Entity()
        sectorRoot.addChild(overlay)
        authoringOverlayRoot = overlay
        return overlay
    }

    private func focusCamera(on focus: SIMD3<Float>) {
        cameraEntity.position = OrthographicCameraRig.cameraPosition(focusing: focus)
        cameraEntity.orientation = OrthographicCameraRig.cameraOrientation(focusing: focus)
        sunFocus = focus
        repositionSun()
    }

    /// Keeps the sun's fixed shadow volume centered on the camera focus: a directional light
    /// ignores its position for illumination, but the `.fixed` shadow projection is anchored
    /// to the light's transform, so the light backs away from the focus along its own axis
    /// far enough that the whole visible sector slice sits inside `zNear...zFar`. The focus
    /// snaps to a coarse grid: re-anchoring the shadow volume continuously while the camera
    /// follows a walk re-rasterizes the shadow map every frame and its edges visibly crawl.
    private func repositionSun() {
        let snap: Float = 0.5
        let snapped = SIMD3<Float>(
            (sunFocus.x / snap).rounded() * snap,
            (sunFocus.y / snap).rounded() * snap,
            (sunFocus.z / snap).rounded() * snap
        )
        let forward = sunEntity.orientation.act(SIMD3<Float>(0, 0, -1))
        sunEntity.position = snapped - forward * 30
    }

    // MARK: - Test seams

    /// Held-sector-swap test seam (mirrors the SpriteKit scene's): visible to `@testable
    /// import SomnioScene3D`, kept out of the public surface. Exposes the swap state machine's
    /// observable flags plus the applied/deferred lighting so the load/reveal/showSplash
    /// transitions can be asserted headlessly.
    struct HeldSwapProbe {
        var sectorRootEnabled: Bool?
        var hasParkedPreviousRoot: Bool
        var pendingPlayerReveal: Bool
        var pendingSunState: SunState?
        var appliedSunIntensity: Float?
    }

    func _heldSwapProbe() -> HeldSwapProbe {
        HeldSwapProbe(
            sectorRootEnabled: sectorRoot?.isEnabled,
            hasParkedPreviousRoot: previousRoot != nil,
            pendingPlayerReveal: pendingPlayerReveal,
            pendingSunState: pendingSunState,
            appliedSunIntensity: sunEntity.components[DirectionalLightComponent.self]?.intensity
        )
    }

    /// Sector-graph test seam: children of the current `sectorRoot` (floor + objects +
    /// entities), or `nil` before any load.
    func _sectorRootChildCount() -> Int? {
        sectorRoot.map(\.children.count)
    }

    /// Render-state test seam (mirrors the SpriteKit scene's `_entityRenderStateContains`).
    func _entityRenderStateContains(_ id: Int16) -> Bool {
        entityRenderStates[id] != nil
    }

    /// Entity-node test seam: node position, the model holder's slewed yaw orientation,
    /// placeholder status, in-flight tween, and overlay presence for yaw/tween/re-resolution
    /// assertions.
    struct EntityNodeProbe {
        var nodePosition: SIMD3<Float>
        var orientation: simd_quatf
        /// Must stay identity: the screen-aligned overlays hang off the node, so any node
        /// rotation (e.g. a facing yaw applied to the wrong entity) would tilt them.
        var nodeOrientation: simd_quatf
        var isPlaceholder: Bool
        var hasActiveTween: Bool
        var hasSpeechBubble: Bool
        var hasNamePlaque: Bool
        /// Identity of the plaque entity — a rebuild (kind or name change) mints a new one,
        /// distinguishing "relabeled" from "stale plaque reused".
        var namePlaqueID: Entity.ID?
        /// The bubble container's height above the node origin (`nil` without a bubble) —
        /// lets tests assert the head measurement ignores the coexisting plaque.
        var speechBubbleHeight: Float?
        /// Children of the stable node: the model holder plus any attached overlays — lets
        /// tests assert a re-place never stacks duplicate plaques or bubbles.
        var nodeChildCount: Int
        /// Last pose `tick` selected (`nil` before the first tick) and the travel heading a
        /// driver last recorded (`nil` when cleared) — lets tests observe the directional
        /// clip selection, the snap-clear, and the grace-window persistence.
        var pose: AnimationPose?
        var travelHeading: Heading?
    }

    func _entityNodeProbe(for entityID: Int16) -> EntityNodeProbe? {
        guard let state = entityRenderStates[entityID] else { return nil }
        return EntityNodeProbe(
            nodePosition: state.node.position,
            orientation: state.modelHolder.orientation,
            nodeOrientation: state.node.orientation,
            isPlaceholder: state.isPlaceholder,
            hasActiveTween: state.tween != nil,
            hasSpeechBubble: speechBubbles[entityID] != nil,
            hasNamePlaque: state.namePlaque != nil,
            namePlaqueID: state.namePlaque?.id,
            speechBubbleHeight: speechBubbles[entityID].map(\.node.position.y),
            nodeChildCount: state.node.children.count,
            pose: state.pose,
            travelHeading: state.travelHeading
        )
    }

    /// Re-resolution test seam: how many placed objects still render placeholders.
    func _placeholderObjectCount() -> Int {
        placedObjects.filter(\.isPlaceholder).count
    }

    /// Floor re-resolution test seam: whether the current floor renders the gray fallback rather
    /// than its material texture, or `nil` before the first load.
    func _floorIsFallback() -> Bool? {
        floorRenderState?.isFallback
    }

    /// Floor render-effect test seam: whether the live floor entity's material actually carries a
    /// texture (vs. the gray fallback tint), or `nil` before the first load. Reads the rendered
    /// material rather than the `isFallback` flag, so a heal that clears the flag without swapping
    /// the material is caught.
    func _floorMaterialIsTextured() -> Bool? {
        guard let material = floorRenderState?.entity.model?.materials.first as? PhysicallyBasedMaterial else { return nil }
        return material.baseColor.texture != nil
    }
}
