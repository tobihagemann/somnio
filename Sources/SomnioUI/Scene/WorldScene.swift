import CoreGraphics
import Foundation
import Logging
import SomnioCore
import SpriteKit

/// SpriteKit scene that renders the world inside the play-field viewport. State lives
/// across multiple sectors: `load(sector:)` swaps the rendered ground/objects, the
/// entity-node map is rebuilt per sector (the wire's sector-local `entityIndex` may
/// be reused after a sector switch), and the day/night tint pass updates with each
/// `DateTick`. Splash is the scene's initial state until the first `EnterSector`
/// frame arrives.
@MainActor public final class WorldScene: SKScene {
    private static let logger = Logger(label: "de.tobiha.somnio.ui.scene")

    /// Per-entity render state the scene mutates each frame. `WorldEntity` is a value type
    /// rebuilt from every wire `EntityMessage`, so the walk-cycle clock and last-rendered
    /// pose can't live there — they live here, keyed by the sector-local entity index.
    private final class EntityRenderState {
        let node: SKSpriteNode
        var kind: WorldEntity.Kind
        var figure: Int16
        var facing: Direction
        var lastPosition: CGPoint
        /// Scene-clock time of the most recent position change; `update(_:)` derives the
        /// moving/idle signal from how recently this was.
        var lastMotionTime: TimeInterval
        /// One-shot: set when a driver path sees a position delta, consumed in `update(_:)`.
        var pendingMotion: Bool
        var walkPhase: TimeInterval
        var renderedFacing: Direction?
        var renderedFrame: Int?
        /// Name label under the sprite (players + NPCs; `nil` for monsters). A child of `node`,
        /// created once on first placement and removed with the node on despawn.
        var namePlaque: NamePlaqueNode?

        init(node: SKSpriteNode, kind: WorldEntity.Kind, figure: Int16, facing: Direction, position: CGPoint) {
            self.node = node
            self.kind = kind
            self.figure = figure
            self.facing = facing
            self.lastPosition = position
            self.lastMotionTime = -.infinity
            self.pendingMotion = false
            self.walkPhase = 0
            self.renderedFacing = nil
            self.renderedFrame = nil
        }
    }

    /// Name-plaque backgrounds: players gray `RGB(221,221,221)`, NPCs cyan `RGB(204,255,255)`.
    private static let playerPlaqueColor = SKColor(red: 221 / 255, green: 221 / 255, blue: 221 / 255, alpha: 1)
    private static let npcPlaqueColor = SKColor(red: 204 / 255, green: 255 / 255, blue: 255 / 255, alpha: 1)
    /// One walk frame; matches the legacy 5 frames/s cadence (one 4-frame cycle in 800 ms).
    private static let framePeriod: TimeInterval = 0.2
    /// Idle threshold: an entity counts as moving for this long after its last position change.
    private static let motionGraceWindow: TimeInterval = 0.15
    /// Walk frames per direction. Must equal `BundleMainSpriteAssets.entityWalkFrames`:
    /// `update(_:)` requests `frame % walkFrameCount` and `entityTexture` rejects any
    /// `frame >= entityWalkFrames`, so a drift would freeze sprites on a stale frame.
    private static let walkFrameCount = 4
    /// Speech bubbles render above the day/night tint (decision: readable at night). The tint sits
    /// at z 1000 on the camera; the bubble is a child of the entity node — a sibling subtree of the
    /// camera — so its accumulated z (the entity's feet-line z + this constant) clears 1000.
    private static let bubbleZ: CGFloat = 1100
    /// Gap in points between the speaker's head (sprite top) and the bubble's content bottom.
    private static let bubbleHeadGap: CGFloat = 2
    /// Local z lifting a name plate just above its own sprite cell within the entity node. The
    /// parent entity node's per-frame `ScreenDepth.entity` z drives inter-entity (screen-Y)
    /// ordering, so an absolute screen depth here would double-apply onto the parent's.
    private static let namePlateZ: CGFloat = 1

    private let assets: any SpriteAssets
    private var sectorRoot: SKNode?
    /// On a player-driven sector switch the incoming `sectorRoot` is added hidden and the outgoing
    /// root is parked here (kept on screen) until the player is placed, then swapped — so the new
    /// sector never shows framed on its origin without a character. `nil` outside a switch.
    private var previousRoot: SKNode?
    /// `true` between an `awaitingPlayerPlacement` load and the player's placement: the gate that
    /// triggers the atomic swap (reveal new root, drop `previousRoot`) in `placeEntity`.
    private var pendingPlayerReveal = false
    private var splashNode: SKSpriteNode?
    /// Title text shown over the splash when no splash asset is available (no-asset-pack
    /// fallback), mirroring the PoC. A child of `splashNode`, cleared when a sector loads.
    private var splashLabelNode: SKLabelNode?
    private var tintNode: SKSpriteNode?
    /// During a held sector switch the incoming sector's tint alpha is stashed here instead of being
    /// applied, so the parked outgoing sector keeps its own lighting until the atomic reveal rather
    /// than briefly rendering under the new sector's `LightSetting`. Consumed by
    /// `revealHeldSectorIfPending`; `nil` when no tint is deferred.
    private var pendingTintAlpha: CGFloat?
    private var entityRenderStates: [Int16: EntityRenderState] = [:]
    private var bubbleNodes: [Int16: SpeechBubbleNode] = [:]
    /// Scene-clock time of the last `update(_:)`; `nil` until the first tick. Drives the
    /// per-frame walk-cycle dt.
    private var lastUpdateTime: TimeInterval?
    /// Sector height in pixels for the legacy Y-down → SpriteKit Y-up flip. Zero before
    /// `load(sector:)`, so pre-load placements render unflipped.
    private var sectorHeightPx: CGFloat = 0
    /// Follows the local player so the world scrolls around a centered character, matching
    /// the legacy 640×480 scrolling viewport.
    private let cameraNode = SKCameraNode()
    /// Entity index of the local player — the camera-follow target. Set when an entity of
    /// kind `.player` is first placed.
    private var cameraFollowID: Int16?

    public init(size: CGSize, assets: any SpriteAssets) {
        self.assets = assets
        super.init(size: size)
        anchorPoint = CGPoint(x: 0, y: 0)
        scaleMode = .resizeFill
        addChild(cameraNode)
        camera = cameraNode
        showSplash()
    }

    /// Centers the scrolling camera on a node's center given its anchor-(0,0) origin.
    private func centerCamera(onNodeOrigin origin: CGPoint, size: CGSize) {
        cameraNode.position = CGPoint(x: origin.x + size.width / 2, y: origin.y + size.height / 2)
    }

    /// Tears down the splash node and its text fallback.
    private func clearSplash() {
        splashNode?.removeFromParent()
        splashNode = nil
        splashLabelNode = nil
    }

    @available(*, unavailable)
    public required init?(coder _: NSCoder) {
        fatalError("WorldScene must be created with init(size:assets:)")
    }

    /// Swaps the rendered sector. When `awaitingPlayerPlacement` is `true` the held visual — the
    /// outgoing sector on a portal hop, or the splash on first login — stays on screen and the
    /// incoming sector is added hidden, until `placeEntity` places the player and swaps atomically,
    /// avoiding a frame of the new sector framed on its origin with no character. When `false` (the
    /// editor) the swap is immediate and the camera re-centers to view-center.
    public func load(sector: Sector, awaitingPlayerPlacement: Bool = false) {
        if awaitingPlayerPlacement {
            // Hold the current visual on screen until `placeEntity` reveals the new sector centered
            // on the player. On a portal hop that visual is the outgoing sector (parked below); on
            // first login there is no outgoing sector, so the splash stays up as the held visual and
            // `revealHeldSectorIfPending` drops it at the swap. Either way no frame of the new sector
            // is shown framed on its origin with no character.
            previousRoot?.removeFromParent()
            previousRoot = sectorRoot
        } else {
            clearSplash()
            previousRoot?.removeFromParent()
            sectorRoot?.removeFromParent()
            previousRoot = nil
        }
        entityRenderStates.removeAll()
        bubbleNodes.removeAll()
        cameraFollowID = nil
        sectorHeightPx = CGFloat(sector.pixelHeight)

        let root = SKNode()
        renderTiles(sector: sector, into: root, assets: assets)
        root.isHidden = awaitingPlayerPlacement
        addChild(root)
        sectorRoot = root
        pendingPlayerReveal = awaitingPlayerPlacement
        if !awaitingPlayerPlacement {
            // Default the camera to view-center (scene origin-anchored) so consumers without a
            // player — the editor — keep an origin-aligned canvas for click mapping. The player
            // client's `placeEntity` re-centers on the character immediately after load. During a
            // held switch the camera stays on the outgoing sector until the swap re-centers it.
            cameraNode.position = CGPoint(x: size.width / 2, y: size.height / 2)
        }
    }

    /// Flips legacy top-left Y (binary / wire coords) to SpriteKit Y-up. Assumes anchor
    /// (0, 0); subtracts `nodeHeight` so the node's top edge aligns with the legacy top edge.
    private func sceneY(forLegacyY legacyY: CGFloat, nodeHeight: CGFloat) -> CGFloat {
        sectorHeightPx - legacyY - nodeHeight
    }

    public func placeEntity(_ entity: WorldEntity) {
        let legacyPosition = CGPoint(x: CGFloat(entity.position.x), y: CGFloat(entity.position.y))
        let state: EntityRenderState
        if let existing = entityRenderStates[entity.id] {
            state = existing
            state.kind = entity.kind
            state.figure = entity.figure
            state.facing = entity.facing
        } else {
            let node = SKSpriteNode()
            node.anchorPoint = CGPoint(x: 0, y: 0)
            state = EntityRenderState(
                node: node,
                kind: entity.kind,
                figure: entity.figure,
                facing: entity.facing,
                position: legacyPosition
            )
            sectorRoot?.addChild(node)
            entityRenderStates[entity.id] = state
        }

        // Size from the texture cell when available; otherwise fall back to the mask
        // footprint so the untextured nil-fallback node keeps the right collision shape.
        if let texture = assets.entityTexture(
            figureIndex: entity.figure,
            kind: entity.kind,
            facing: entity.facing,
            frame: 0
        ) {
            state.node.texture = texture
            state.node.size = texture.size()
        } else {
            state.node.size = CGSize(width: CGFloat(entity.maskSize.width), height: CGFloat(entity.maskSize.height))
        }

        if legacyPosition != state.lastPosition {
            state.pendingMotion = true
            state.lastPosition = legacyPosition
        }
        state.node.position = CGPoint(
            x: legacyPosition.x,
            y: sceneY(forLegacyY: legacyPosition.y, nodeHeight: state.node.size.height)
        )
        // Initial feet-line depth; `update(_:)` recomputes it from the live node position each
        // frame so a tweening peer's depth tracks its motion (mirrors per-frame `PrioritySetzen`).
        state.node.zPosition = ScreenDepth.entity(legacyY: legacyPosition.y, height: state.node.size.height)
        state.renderedFacing = entity.facing
        state.renderedFrame = 0
        updateNamePlaque(for: state, entity: entity)

        if entity.kind == .player {
            cameraFollowID = entity.id
            centerCamera(onNodeOrigin: state.node.position, size: state.node.size)
            revealHeldSectorIfPending()
        }
    }

    /// Atomic swap once the local player lands in a freshly loaded sector: drops the held outgoing
    /// sector and reveals the new one, so there's no empty-origin frame between load and placement.
    private func revealHeldSectorIfPending() {
        guard pendingPlayerReveal else { return }
        previousRoot?.removeFromParent()
        previousRoot = nil
        // On first login the splash was the held visual kept up during the deferred load; drop it
        // now so the first game frame is the sector already centered on the player.
        clearSplash()
        sectorRoot?.isHidden = false
        pendingPlayerReveal = false
        if let alpha = pendingTintAlpha {
            (tintNode ?? makeTintNode()).alpha = alpha
            pendingTintAlpha = nil
        }
    }

    /// Creates the entity's name plaque on first placement (players + NPCs; monsters get none),
    /// and re-pins it centered 1px below the sprite's feet. The local player's plaque is bold.
    private func updateNamePlaque(for state: EntityRenderState, entity: WorldEntity) {
        let background: SKColor
        let bold: Bool
        switch entity.kind {
        case .player:
            background = Self.playerPlaqueColor
            bold = true
        case .peer:
            background = Self.playerPlaqueColor
            bold = false
        case .npc:
            background = Self.npcPlaqueColor
            bold = false
        case .monster:
            return
        }
        if state.namePlaque == nil {
            let plaque = NamePlaqueNode(name: entity.name, background: background, bold: bold)
            plaque.zPosition = Self.namePlateZ
            state.node.addChild(plaque)
            state.namePlaque = plaque
        }
        state.namePlaque?.position = CGPoint(x: state.node.size.width / 2, y: -1)
    }

    public func updatePosition(entityID: Int16, to position: GridPoint, facing: Direction) {
        guard let state = entityRenderStates[entityID] else {
            WorldScene.logger.debug("updatePosition called for unknown entity \(entityID)")
            return
        }
        let legacyPosition = CGPoint(x: CGFloat(position.x), y: CGFloat(position.y))
        if legacyPosition != state.lastPosition {
            state.pendingMotion = true
            state.lastPosition = legacyPosition
        }
        state.facing = facing
        state.node.position = CGPoint(
            x: legacyPosition.x,
            y: sceneY(forLegacyY: legacyPosition.y, nodeHeight: state.node.size.height)
        )
        if entityID == cameraFollowID {
            centerCamera(onNodeOrigin: state.node.position, size: state.node.size)
        }
    }

    /// Animates the entity sprite from its current screen position to the new grid position
    /// over `duration` seconds. `duration` should match the server tick period so the action
    /// completes before the next position arrives; callers driving an authoritative replay
    /// pass the wire tick rate (legacy server is 50 ms = 0.05 s).
    public func animateEntity(_ id: Int16, to position: GridPoint, facing: Direction, duration: TimeInterval) {
        guard let state = entityRenderStates[id] else {
            WorldScene.logger.debug("animateEntity called for unknown entity \(id)")
            return
        }
        // Position delta is the moving signal; tempo is intentionally not consumed here.
        let legacyPosition = CGPoint(x: CGFloat(position.x), y: CGFloat(position.y))
        if legacyPosition != state.lastPosition {
            state.pendingMotion = true
            state.lastPosition = legacyPosition
        }
        state.facing = facing
        state.node.removeAllActions()
        let target = CGPoint(
            x: legacyPosition.x,
            y: sceneY(forLegacyY: legacyPosition.y, nodeHeight: state.node.size.height)
        )
        state.node.run(SKAction.move(to: target, duration: duration))
    }

    /// Per-frame walk-cycle driver. Advances each entity's walk frame while it has moved
    /// within `motionGraceWindow`, reverting to the standing pose (frame 0) when idle, and
    /// rebinds the cell texture only when the facing or frame actually changed.
    override public func update(_ currentTime: TimeInterval) {
        guard let last = lastUpdateTime else {
            lastUpdateTime = currentTime
            return
        }
        let dt = min(currentTime - last, 0.1)
        lastUpdateTime = currentTime

        for (_, state) in entityRenderStates {
            if state.pendingMotion {
                state.lastMotionTime = currentTime
                state.pendingMotion = false
            }
            let isMoving = (currentTime - state.lastMotionTime) < Self.motionGraceWindow
            let targetFrame: Int
            if isMoving {
                state.walkPhase += dt
                targetFrame = Int(state.walkPhase / Self.framePeriod) % Self.walkFrameCount
            } else {
                state.walkPhase = 0
                targetFrame = 0
            }
            if state.renderedFacing != state.facing || state.renderedFrame != targetFrame {
                if let texture = assets.entityTexture(
                    figureIndex: state.figure,
                    kind: state.kind,
                    facing: state.facing,
                    frame: targetFrame
                ) {
                    state.node.texture = texture
                }
                state.renderedFacing = state.facing
                state.renderedFrame = targetFrame
            }
            // Recompute feet-line depth from the live (possibly mid-tween) scene position so the
            // entity sorts against objects and peers as it moves, like the original per-frame pass.
            let legacyY = sectorHeightPx - state.node.position.y - state.node.size.height
            state.node.zPosition = ScreenDepth.entity(legacyY: legacyY, height: state.node.size.height)
        }
    }

    /// Removes the entity's sprite node and clears its bubble, if any. Called on `.leave`.
    public func removeEntity(id: Int16) {
        if let state = entityRenderStates.removeValue(forKey: id) {
            state.node.removeFromParent()
        }
        if let bubble = bubbleNodes.removeValue(forKey: id) {
            bubble.removeFromParent()
        }
    }

    /// Lifecycle-test seam: visible to `@testable import SomnioUI`, kept out of the public
    /// surface. Exists only so render-state lifecycle tests can assert clear-on-leave/load.
    func _entityRenderStateContains(_ id: Int16) -> Bool {
        entityRenderStates[id] != nil
    }

    /// Overlay-layering test seam: surfaced through the `_overlayProbe(for:)` accessor, visible to
    /// `@testable import SomnioUI` and kept out of the public surface (mirrors
    /// `_entityRenderStateContains`). Exposes accumulated z + parent identity so overlay-depth tests
    /// can assert the bubble sorts above the tint and the plate tracks its node.
    struct OverlayProbe {
        var bubbleParentIsEntityNode: Bool
        var bubbleEffectiveZ: CGFloat
        var tintEffectiveZ: CGFloat
        var namePlateParentIsEntityNode: Bool
        var namePlateEffectiveZ: CGFloat
    }

    func _overlayProbe(for entityID: Int16) -> OverlayProbe? {
        guard let state = entityRenderStates[entityID] else { return nil }
        let bubble = bubbleNodes[entityID]
        return OverlayProbe(
            bubbleParentIsEntityNode: bubble?.parent === state.node,
            bubbleEffectiveZ: bubble.map { effectiveZ(of: $0) } ?? 0,
            tintEffectiveZ: tintNode.map { effectiveZ(of: $0) } ?? 0,
            namePlateParentIsEntityNode: state.namePlaque?.parent === state.node,
            namePlateEffectiveZ: state.namePlaque.map { effectiveZ(of: $0) } ?? 0
        )
    }

    /// Sum of a node's zPosition and all its ancestors' — SpriteKit's accumulated (global) z used
    /// to sort across sibling subtrees. Test-only helper backing `_overlayProbe`.
    private func effectiveZ(of node: SKNode) -> CGFloat {
        var total: CGFloat = 0
        var current: SKNode? = node
        while let here = current {
            total += here.zPosition
            current = here.parent
        }
        return total
    }

    /// Held-sector-swap test seam: visible to `@testable import SomnioUI`, kept out of the public
    /// surface (mirrors `_overlayProbe`). Exposes the swap state machine's observable flags so the
    /// load/reveal/showSplash transitions and the deferred destination tint can be asserted
    /// headlessly.
    struct HeldSwapProbe {
        var sectorRootHidden: Bool
        var hasParkedPreviousRoot: Bool
        var pendingPlayerReveal: Bool
        var splashPresent: Bool
        var pendingTintAlpha: CGFloat?
        var appliedTintAlpha: CGFloat?
    }

    func _heldSwapProbe() -> HeldSwapProbe {
        HeldSwapProbe(
            sectorRootHidden: sectorRoot?.isHidden ?? false,
            hasParkedPreviousRoot: previousRoot != nil,
            pendingPlayerReveal: pendingPlayerReveal,
            splashPresent: splashNode != nil,
            pendingTintAlpha: pendingTintAlpha,
            appliedTintAlpha: tintNode?.alpha
        )
    }

    /// Entity-node test seam (mirrors `_overlayProbe`): exposes a placed entity's node position,
    /// whether it has a running `SKAction` (a tween in flight), and whether the camera is centered on
    /// it — so reconciliation tests can assert the self player is moved by a direct set with camera
    /// follow rather than a competing tween.
    struct EntityNodeProbe {
        var nodePosition: CGPoint
        var hasRunningActions: Bool
        var cameraCenteredOnNode: Bool
    }

    func _entityNodeProbe(for entityID: Int16) -> EntityNodeProbe? {
        guard let state = entityRenderStates[entityID] else { return nil }
        let nodeCenter = CGPoint(
            x: state.node.position.x + state.node.size.width / 2,
            y: state.node.position.y + state.node.size.height / 2
        )
        return EntityNodeProbe(
            nodePosition: state.node.position,
            hasRunningActions: state.node.hasActions(),
            cameraCenteredOnNode: cameraNode.position == nodeCenter
        )
    }

    /// Ground-tile-map test seam (mirrors `_entityNodeProbe`): locates the `SKTileMapNode` in
    /// `sectorRoot` and snapshots its grid shape and placement, or `nil` on the no-asset-pack path
    /// where no tile map is built. Visible to `@testable import SomnioUI`, kept off the public
    /// surface because `sectorRoot` is private.
    struct GroundTileMapProbe {
        var numberOfColumns: Int
        var numberOfRows: Int
        var tileSize: CGSize
        var anchorPoint: CGPoint
        var position: CGPoint
        var zPosition: CGFloat
    }

    func _groundTileMapProbe() -> GroundTileMapProbe? {
        guard let map = sectorRoot?.children.compactMap({ $0 as? SKTileMapNode }).first else { return nil }
        return GroundTileMapProbe(
            numberOfColumns: map.numberOfColumns,
            numberOfRows: map.numberOfRows,
            tileSize: map.tileSize,
            anchorPoint: map.anchorPoint,
            position: map.position,
            zPosition: map.zPosition
        )
    }

    /// Renders pre-wrapped speech bubble lines above the entity's sprite. `lifetimeMs` is
    /// integer milliseconds matching the legacy `2000 + lines × 1000` rule; callers pass
    /// the result of `SpeechBubbleText.wrap`.
    public func showSpeechBubble(above entityID: Int16, lines: [String], lifetimeMs: Int) {
        guard let anchor = entityRenderStates[entityID]?.node else { return }
        bubbleNodes[entityID]?.removeFromParent()
        let bubble = SpeechBubbleNode(
            lines: lines,
            lifetime: TimeInterval(lifetimeMs) / 1000.0,
            template: assets.speechBubble()
        )
        // Parent under the entity node so the bubble auto-follows the speaker via the node's
        // position and `animateEntity` tweens — no per-frame repositioning. The bubble's origin is
        // its tail tip, so place it centered over the sprite, just above the head; the balloon then
        // rises centered above. `bubbleZ` forces it above the day/night tint.
        bubble.position = CGPoint(
            x: anchor.size.width / 2,
            y: anchor.size.height + Self.bubbleHeadGap
        )
        bubble.zPosition = Self.bubbleZ
        anchor.addChild(bubble)
        bubbleNodes[entityID] = bubble
    }

    public func updateDayNightTint(hour: Int16, minute: Int16, sectorLight: LightSetting) {
        let ambient = DayNightTint.ambientLight(hour: hour, minute: minute, sectorLight: sectorLight)
        let alpha = max(0, min(1, 1 - ambient / 100))
        guard !pendingPlayerReveal else {
            // Mid-switch: stash the destination tint and keep the outgoing sector's lighting until
            // the reveal, so the parked old sector isn't recolored a few frames before it leaves.
            pendingTintAlpha = alpha
            return
        }
        let tint = tintNode ?? makeTintNode()
        tint.alpha = alpha
    }

    public func showSplash() {
        sectorRoot?.removeFromParent()
        sectorRoot = nil
        // Drop any sector parked for an in-flight switch the splash interrupts (e.g. Leave Game).
        previousRoot?.removeFromParent()
        previousRoot = nil
        pendingPlayerReveal = false
        pendingTintAlpha = nil
        entityRenderStates.removeAll()
        bubbleNodes.removeAll()
        cameraFollowID = nil
        // Center the camera on the full-bleed splash (anchored at origin, sized to the scene).
        cameraNode.position = CGPoint(x: size.width / 2, y: size.height / 2)
        let node = splashNode ?? SKSpriteNode()
        node.size = size
        node.position = CGPoint(x: 0, y: 0)
        node.anchorPoint = CGPoint(x: 0, y: 0)
        node.zPosition = 0
        if let texture = assets.splash() {
            node.texture = texture
            splashLabelNode?.removeFromParent()
            splashLabelNode = nil
        } else {
            // No splash asset: show the title text centered over the scene background instead
            // of a blank node, matching the PoC's text fallback.
            node.texture = nil
            let label = splashLabelNode ?? makeSplashLabel()
            label.position = CGPoint(x: size.width / 2, y: size.height / 2)
            if label.parent == nil {
                node.addChild(label)
            }
            splashLabelNode = label
        }
        if splashNode == nil {
            addChild(node)
            splashNode = node
        }
    }

    private func makeSplashLabel() -> SKLabelNode {
        let label = SKLabelNode(text: "Somnio")
        label.fontName = "Helvetica-Bold"
        label.fontSize = 48
        label.fontColor = .white
        label.horizontalAlignmentMode = .center
        label.verticalAlignmentMode = .center
        label.zPosition = 1
        return label
    }

    private func makeTintNode() -> SKSpriteNode {
        // Child of the camera (not the scene) so the full-viewport tint tracks the scrolling
        // camera; anchored at its center because the camera frames the viewport on its origin.
        let node = SKSpriteNode(color: .black, size: size)
        node.anchorPoint = CGPoint(x: 0.5, y: 0.5)
        node.position = CGPoint(x: 0, y: 0)
        node.zPosition = 1000
        node.alpha = 0
        node.blendMode = .alpha
        cameraNode.addChild(node)
        tintNode = node
        return node
    }
}
