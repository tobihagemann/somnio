/**
 * Mirror of `Sources/SomnioScene3D/WorldScene3D.swift`.
 *
 * Deliberate divergences from the Swift renderer are marked at the site that diverges; anything
 * unmarked is a port. The largest is the floor-patch UV sign, which three.js requires because its
 * `PlaneGeometry` lays out V opposite to the Swift `MeshDescriptor`.
 */
import * as THREE from 'three'
import type { WorldRenderSurface } from '@/client/renderSurface'
import { SOMNIO_CONSTANTS } from '@/core/constants'
import { FLOAT_PI, f32 } from '@/core/float'
import { relativeDirection } from '@/core/tempo'
import type { Tempo } from '@/core/tempo'
import { headingFromVector, headingRadians } from '@/core/heading'
import type { Heading } from '@/core/heading'
import type { GridPoint, GridSize } from '@/core/geometry'
import { sectorPixelHeight, sectorPixelWidth } from '@/core/sector'
import type { LightSetting, Sector } from '@/core/sector'
import { gridRounded } from '@/core/worldEntity'
import type { SubpixelPoint, WorldEntity } from '@/core/worldEntity'
import {
  CLIP_TRANSITION_DURATION,
  MAX_TICK_DELTA,
  MOTION_GRACE_WINDOW,
  movementPose,
  resolveClipName,
} from './animation'
import type { AnimationPose } from './animation'
import {
  ORTHO_RIG,
  cameraPosition,
  clampedScale,
  frustumBounds,
  scaleForZoomFactor,
  worldPosition,
} from './cameraRig'
import { ENVIRONMENT_FILL_INTENSITY, SUN_SHADOW, sunState } from './dayNightSun'
import { namePlaqueBackground, renderNamePlaque, renderSpeechBubble } from './overlayArt'
import type { RasterArt } from './overlayArt'
import {
  FLOOR_MATERIAL_TILE_METERS,
  FLOOR_PATCH_LIFT,
  characterScale,
  entityWorldPosition,
  floorPatchUVRect,
  objectAnchorBottomY,
  objectNodePosition,
  objectYawRadians,
  textureAspect,
} from './placement'
import type { ModelAssets } from './modelAssets'
import { yawStep } from './yawSlew'

/**
 * Per-entity render state the scene mutates each frame.
 *
 * `WorldEntity` is a value rebuilt from every inbound frame, so the walk clocks and the slewed
 * yaw cannot live there — they live here, keyed by sector-local entity index, mirroring the
 * native renderer's split for the same reason.
 */
interface EntityRenderState {
  /** Translation only. Overlays hang off this, so it must never carry the facing yaw. */
  node: THREE.Object3D
  /** Carries the yaw and the swappable model, so a post-prewarm swap never moves the overlays. */
  modelHolder: THREE.Object3D
  mixer: THREE.AnimationMixer | undefined
  action: THREE.AnimationAction | undefined
  kind: WorldEntity['kind']
  figure: number
  name: string
  maskSize: GridSize
  facing: Heading
  tempo: Tempo
  lastPosition: GridPoint
  travelHeading: Heading | undefined
  currentYaw: number
  lastMotionTime: number
  pendingMotion: boolean
  /** Seconds of motion still owed to an in-flight tween, so the walk clip runs the whole glide. */
  remainingTweenMotion: number
  tween: { start: THREE.Vector3; target: THREE.Vector3; total: number; remaining: number } | undefined
  isPlaceholder: boolean
  /** Label under the feet; created once on first placement and rebuilt on a kind or name change. */
  namePlaque: THREE.Object3D | undefined
  pose: AnimationPose | undefined
}

interface PlacedObject {
  node: THREE.Object3D
  object: Sector['objects'][number]
  anchorBottomY: number
  isPlaceholder: boolean
}

const PLACEHOLDER_MATERIAL = new THREE.MeshStandardMaterial({ color: 0x808080, roughness: 1 })

/** Shared zero vector for basis construction; never mutated. */
const ORIGIN = new THREE.Vector3()

/**
 * Enrols a subtree in shadow casting.
 *
 * Called per added subtree rather than once over the scene, because models resolve asynchronously
 * — a single sweep after load would miss every clone the prewarm has not produced yet, and those
 * are exactly the props whose missing shadows read as floating.
 */
function enableShadows(root: THREE.Object3D): void {
  root.traverse((object) => {
    if (!(object as THREE.Mesh).isMesh) return
    object.castShadow = true
    object.receiveShadow = true
  })
}

/**
 * Three.js implementation of the ten-method render surface.
 *
 * Real 3D depth: objects and entities sit on the floor at their world XZ and the depth buffer
 * gives draw order for free — no painter's algorithm and no Y-flip.
 */
export class WorldScene implements WorldRenderSurface {
  readonly scene = new THREE.Scene()
  readonly camera: THREE.OrthographicCamera

  private readonly assets: ModelAssets
  private readonly sun = new THREE.DirectionalLight(0xffffff, 1)
  private readonly ambient = new THREE.DirectionalLight(0xffffff, 1)
  private readonly environmentFill = new THREE.AmbientLight(0xffffff, ENVIRONMENT_FILL_INTENSITY)
  /** Retained so `repositionSun` can re-anchor the light without recomputing the day/night state. */
  private readonly sunDirection = new THREE.Vector3(0, 1, 0)
  private sectorRoot: THREE.Object3D | undefined
  /** The outgoing sector, parked on screen during a held swap. */
  private previousRoot: THREE.Object3D | undefined
  private pendingPlayerReveal = false
  /** Day/night state that arrived while a sector was held, applied at the reveal. */
  private pendingSunState: { hour: number; minute: number; light: LightSetting } | undefined
  private readonly entityStates = new Map<number, EntityRenderState>()
  private readonly placedObjects: PlacedObject[] = []
  private readonly floorPatchStates: {
    mesh: THREE.Mesh
    patch: Sector['floorPatches'][number]
    isFallback: boolean
  }[] = []
  private readonly bubbles = new Map<number, { node: THREE.Object3D; remaining: number }>()
  private floorState:
    | { mesh: THREE.Mesh; materialID: string; isFallback: boolean; widthMeters: number; depthMeters: number }
    | undefined
  private sceneClock = 0
  private cameraFollowID: number | undefined
  private focus = new THREE.Vector3()
  /** Scratch for `repositionSun`, which runs once a frame behind the camera follow. */
  private readonly shadowAnchor = new THREE.Vector3()
  private readonly shadowBasis = new THREE.Matrix4()
  private readonly shadowOrientation = new THREE.Quaternion()
  private readonly shadowOrientationInverse = new THREE.Quaternion()
  private zoomFactor = 1
  private aspect = 1

  constructor(assets: ModelAssets, aspect = 1) {
    this.assets = assets
    this.aspect = aspect
    const bounds = frustumBounds(ORTHO_RIG.defaultScale, aspect)
    this.camera = new THREE.OrthographicCamera(
      bounds.left,
      bounds.right,
      bounds.top,
      bounds.bottom,
      ORTHO_RIG.nearClip,
      ORTHO_RIG.farClip
    )
    this.configureSunShadow()
    // The target's world matrix is what gives a directional light its direction, and an object
    // outside the graph never gets one updated.
    this.scene.add(this.sun, this.sun.target, this.ambient, this.environmentFill)
    // The void outside the sector floor, so every sector sits on black rather than the default
    // clear colour — including during a sector swap.
    const backdrop = new THREE.Mesh(
      new THREE.PlaneGeometry(400, 400),
      new THREE.MeshBasicMaterial({ color: 0x000000 })
    )
    backdrop.rotation.x = -Math.PI / 2
    backdrop.position.y = -0.005
    this.scene.add(backdrop)
    this.applySun(12, 0, { indoor: false, brightness: 100 })
    this.focusCamera(new THREE.Vector3())
  }

  /**
   * Recomputes the frustum on resize holding the **vertical world extent constant**, letting
   * aspect drive width.
   *
   * This is a gameplay contract, not a rendering detail: every window size must show the same
   * vertical slice of world, so a bigger window magnifies rather than reveals. Tying the frustum
   * to pixel height or `devicePixelRatio` silently hands large-window players more visible world.
   */
  setViewportAspect(aspect: number): void {
    this.aspect = aspect
    this.applyFraming()
  }

  applyZoomFactor(factor: number): void {
    this.zoomFactor = factor
    this.applyFraming()
  }

  private applyFraming(): void {
    const bounds = frustumBounds(scaleForZoomFactor(this.zoomFactor), this.aspect)
    this.camera.left = bounds.left
    this.camera.right = bounds.right
    this.camera.top = bounds.top
    this.camera.bottom = bounds.bottom
    this.camera.updateProjectionMatrix()
  }

  /** Warms the cache, then re-resolves everything still rendering a placeholder. */
  async prewarm(): Promise<void> {
    await this.assets.prewarm()
    this.refreshResolvedModels()
  }

  // MARK: - WorldRenderSurface

  /**
   * With `awaitingPlayerPlacement`, the outgoing sector is **held on screen** and the incoming
   * one is added hidden, until `placeEntity` places the local player and swaps atomically.
   * Without the hold, a portal hop shows a frame of the new sector framed on its origin with no
   * character in it — brief, but exactly the kind of flash that reads as a glitch.
   */
  load(sector: Sector, awaitingPlayerPlacement: boolean): void {
    if (awaitingPlayerPlacement) {
      disposeSubtree(this.previousRoot)
      this.previousRoot = this.sectorRoot
    } else {
      disposeSubtree(this.previousRoot)
      disposeSubtree(this.sectorRoot)
      this.previousRoot = undefined
    }
    this.resetSectorState()

    const root = new THREE.Object3D()
    const floorCenter = this.buildFloor(sector, root)
    this.buildObjects(sector, root)
    root.visible = !awaitingPlayerPlacement
    this.scene.add(root)
    this.sectorRoot = root
    this.pendingPlayerReveal = awaitingPlayerPlacement
    if (!awaitingPlayerPlacement) {
      // Frames a sector for a consumer with no player arriving; a surface that previewed one
      // without joining it would otherwise open framed on the world origin with nothing in view.
      // Mirrors `WorldScene3D.focusCamera(on: floorCenter)` on the same branch.
      this.focusCamera(floorCenter)
    }
  }

  /** Atomic swap once the local player lands: drop the held sector and show the new one. */
  private revealHeldSectorIfPending(): void {
    if (!this.pendingPlayerReveal) return
    disposeSubtree(this.previousRoot)
    this.previousRoot = undefined
    if (this.sectorRoot !== undefined) this.sectorRoot.visible = true
    this.pendingPlayerReveal = false
    // Applied in the same frame the new sector becomes visible, so the light change and the geometry
    // change land together rather than one flashing ahead of the other.
    const pending = this.pendingSunState
    if (pending !== undefined) {
      this.pendingSunState = undefined
      this.applySun(pending.hour, pending.minute, pending.light)
    }
  }

  placeEntity(entity: WorldEntity): void {
    let state = this.entityStates.get(entity.id)
    if (state === undefined) {
      const node = new THREE.Object3D()
      const modelHolder = new THREE.Object3D()
      node.add(modelHolder)
      this.sectorRoot?.add(node)
      state = {
        node,
        modelHolder,
        mixer: undefined,
        action: undefined,
        kind: entity.kind,
        figure: entity.figure,
        name: entity.name,
        maskSize: entity.maskSize,
        facing: entity.facing,
        tempo: entity.tempo,
        lastPosition: entity.position,
        travelHeading: undefined,
        currentYaw: headingRadians(entity.facing),
        lastMotionTime: Number.NEGATIVE_INFINITY,
        pendingMotion: false,
        remainingTweenMotion: 0,
        tween: undefined,
        isPlaceholder: true,
        namePlaque: undefined,
        pose: undefined,
      }
      this.entityStates.set(entity.id, state)
      this.resolveEntityModel(state)
    }
    // Captured before the branch below overwrites `state.kind`, because the plaque needs the *old*
    // kind to know it changed. `WorldScene3D` orders the two checks the other way round to the same
    // end; reading `state.kind` after the assignment can only ever compare a value to itself.
    const kindChanged = state.kind !== entity.kind
    if (kindChanged || state.figure !== entity.figure) {
      state.kind = entity.kind
      state.figure = entity.figure
      state.maskSize = entity.maskSize
      this.resolveEntityModel(state)
    }
    // Rebuilt on a kind or name change, because both pick the plaque's fill and its width.
    if (state.namePlaque === undefined || kindChanged || state.name !== entity.name) {
      state.name = entity.name
      this.rebuildNamePlaque(state)
    }

    state.facing = entity.facing
    state.maskSize = entity.maskSize
    if (entity.position.x !== state.lastPosition.x || entity.position.y !== state.lastPosition.y) {
      state.pendingMotion = true
      state.lastPosition = entity.position
    }
    state.tween = undefined
    const world = entityWorldPosition(entity.position, entity.maskSize)
    state.node.position.set(world.x, world.y, world.z)
    state.modelHolder.rotation.y = state.currentYaw

    if (entity.kind === 'player') {
      this.cameraFollowID = entity.id
      this.focusCamera(state.node.position)
      this.revealHeldSectorIfPending()
    }
  }

  updatePosition(entityID: number, position: GridPoint, facing: Heading): void {
    const state = this.entityStates.get(entityID)
    if (state === undefined) return
    // An authoritative snap is a position discontinuity: any carried travel direction is the
    // meaningless rejected-move direction, so it is cleared before forwarding.
    state.travelHeading = undefined
    this.updateSubpixelPosition(entityID, { x: position.x, y: position.y }, facing, undefined)
  }

  updateSubpixelPosition(
    entityID: number,
    position: SubpixelPoint,
    facing: Heading,
    travel: Heading | undefined
  ): void {
    const state = this.entityStates.get(entityID)
    if (state === undefined) return
    // `gridRounded`, not `Math.round`: Swift rounds half away from zero, so at y = -2.5 the two
    // disagree and `pendingMotion` would not flip — the walk cycle simply would not start on that
    // step. This is the site `WorldScene3D.updatePosition` mirrors.
    const grid = gridRounded(position)
    if (grid.x !== state.lastPosition.x || grid.y !== state.lastPosition.y) {
      state.pendingMotion = true
      state.lastPosition = grid
    }
    state.facing = facing
    // Only overwrite on a real travel step: a stationary tick passes `undefined` so the last
    // direction persists across the grace window and the clip does not drop mid-glide.
    if (travel !== undefined) state.travelHeading = travel
    state.tween = undefined
    const world = entityWorldPosition(position, state.maskSize)
    state.node.position.set(world.x, world.y, world.z)
    if (entityID === this.cameraFollowID) this.focusCamera(state.node.position)
  }

  animateEntity(entityID: number, position: GridPoint, facing: Heading, durationSeconds: number): void {
    const state = this.entityStates.get(entityID)
    if (state === undefined) return
    if (position.x !== state.lastPosition.x || position.y !== state.lastPosition.y) {
      state.pendingMotion = true
      state.remainingTweenMotion = durationSeconds
      // Peers carry no continuous vector, so their travel heading comes from the grid delta.
      const dx = position.x - state.lastPosition.x
      const dy = position.y - state.lastPosition.y
      state.travelHeading = headingFromVector(dx, dy)
      state.lastPosition = position
    }
    state.facing = facing
    const world = entityWorldPosition(position, state.maskSize)
    state.tween = {
      start: state.node.position.clone(),
      target: new THREE.Vector3(world.x, world.y, world.z),
      total: durationSeconds,
      remaining: durationSeconds,
    }
  }

  updateTempo(entityID: number, tempo: Tempo): void {
    const state = this.entityStates.get(entityID)
    if (state !== undefined) state.tempo = tempo
  }

  updateDayNightTint(hour: number, minute: number, sectorLight: LightSetting): void {
    // Held back while a sector is parked on screen. `handleEnterSector` loads the destination and
    // then immediately applies *its* light, so applying it here would relight the still-visible
    // outgoing sector — the town square darkening to the inn's indoor key for the frames before the
    // swap, which is the exact flash the hold exists to prevent. The state is stashed and applied at
    // the atomic reveal instead, as `WorldScene3D.pendingSunState` does.
    if (this.pendingPlayerReveal) {
      this.pendingSunState = { hour, minute, light: sectorLight }
      return
    }
    this.applySun(hour, minute, sectorLight)
  }

  showSpeechBubble(entityID: number, lines: string[], lifetimeMs: number): void {
    const state = this.entityStates.get(entityID)
    if (state === undefined || lines.length === 0) return
    // Disposed, not just detached: speaking twice inside one lifetime window would otherwise leak
    // a supersampled canvas texture per message, which is unbounded within a single sector.
    disposeSubtree(this.bubbles.get(entityID)?.node)
    const node = speechBubbleQuad(lines)
    // Measure the model only — the persistent name plaque hanging off the node would otherwise
    // stretch the bounds and push the bubble up.
    const headHeight = new THREE.Box3().setFromObject(state.modelHolder).max.y
    node.position.set(0, Math.max(headHeight, 0) + BUBBLE_HEAD_GAP, 0)
    state.node.add(node)
    this.bubbles.set(entityID, { node, remaining: lifetimeMs / 1000 })
  }

  removeEntity(entityID: number): void {
    const state = this.entityStates.get(entityID)
    disposeSubtree(state?.node)
    this.entityStates.delete(entityID)
    this.bubbles.delete(entityID)
  }

  showSplash(): void {
    disposeSubtree(this.sectorRoot)
    this.sectorRoot = undefined
    // Drop any sector parked for a switch the splash interrupts (a Leave Game mid-hop).
    disposeSubtree(this.previousRoot)
    this.previousRoot = undefined
    this.pendingPlayerReveal = false
    this.resetSectorState()
    this.floorState = undefined
    this.focusCamera(new THREE.Vector3())
  }

  /**
   * Clears every collection keyed to the sector being left.
   *
   * One method rather than a copy per caller, because a field missed on one path is invisible until
   * it leaks: an entry left in `floorPatchStates` is one `refreshResolvedModels` still walks, so a
   * mid-prewarm exit rebuilds that patch into the detached root where it is never drawn and never
   * disposed. Anything sector-scoped belongs here, so `load` and `showSplash` cannot disagree.
   */
  private resetSectorState(): void {
    this.entityStates.clear()
    this.bubbles.clear()
    this.placedObjects.length = 0
    this.floorPatchStates.length = 0
    this.cameraFollowID = undefined
    // Day/night state is sector-scoped too: a tint stashed for a destination that is being abandoned
    // would otherwise be applied at the *next* reveal, lighting one sector by another's setting.
    this.pendingSunState = undefined
  }

  // MARK: - Per-frame

  /** Pure accumulation over per-entity state, so yaw and pose behaviour is testable directly. */
  tick(deltaTimeSeconds: number): void {
    const dt = Math.min(deltaTimeSeconds, MAX_TICK_DELTA)
    this.sceneClock += dt

    for (const state of this.entityStates.values()) {
      if (state.tween !== undefined) {
        const tween = state.tween
        tween.remaining = Math.max(0, tween.remaining - dt)
        // Narrowed once around the whole expression, mirroring Swift's `Float(1 - remaining / total)`:
        // both operands are `TimeInterval`, so the subtraction and division happen in double there too.
        const fraction = tween.total > 0 ? f32(1 - tween.remaining / tween.total) : 1
        state.node.position.lerpVectors(tween.start, tween.target, fraction)
        if (tween.remaining <= 0) state.tween = undefined
      }
      if (state.pendingMotion) {
        state.lastMotionTime = this.sceneClock
        state.pendingMotion = false
      }
      // Drain owed tween motion so a gliding entity counts as moving for the whole glide, not
      // just the grace window after its single position delta.
      if (state.remainingTweenMotion > 0) {
        state.remainingTweenMotion -= dt
        state.lastMotionTime = this.sceneClock
      }
      const isMoving = this.sceneClock - state.lastMotionTime < MOTION_GRACE_WINDOW

      const targetYaw = headingRadians(state.facing)
      if (state.currentYaw !== targetYaw) {
        state.currentYaw = yawStep(state.currentYaw, targetYaw, dt)
        state.modelHolder.rotation.y = state.currentYaw
      }

      const direction =
        state.travelHeading === undefined ? 'forward' : relativeDirection(state.travelHeading, state.facing)
      this.applyPose(isMoving ? movementPose(state.kind, state.tempo, direction) : 'idle', state)
      state.mixer?.update(dt)
    }

    for (const [id, bubble] of this.bubbles) {
      bubble.remaining -= dt
      if (bubble.remaining <= 0) {
        disposeSubtree(bubble.node)
        this.bubbles.delete(id)
      }
    }
  }

  // MARK: - Internals

  private applyPose(pose: AnimationPose, state: EntityRenderState): void {
    if (state.pose === pose || state.mixer === undefined) return
    // Recorded before the lookup, as `WorldScene3D.applyPose` does. A model whose clip library has
    // no name for this pose returns below without ever reaching the assignment otherwise, so the
    // guard above never latches and `clipsFor` plus `resolveClipName` re-run every frame for as
    // long as that entity holds the pose.
    state.pose = pose
    const clips = this.assets.clipsFor(state.modelHolder.children[0] ?? state.modelHolder)
    const name = resolveClipName(
      pose,
      clips.map((clip) => clip.name)
    )
    if (name === undefined) return
    const clip = clips.find((candidate) => candidate.name === name)
    if (clip === undefined) return
    const next = state.mixer.clipAction(clip)
    // Clips are cadence-tuned as authored, so they loop verbatim with no rate scaling.
    next.setLoop(THREE.LoopRepeat, Infinity)
    next.reset()
    if (state.action !== undefined && state.action !== next) {
      next.crossFadeFrom(state.action, CLIP_TRANSITION_DURATION, false)
    }
    next.play()
    state.action = next
  }

  /** Players and NPCs get a plaque; monsters get none, and the local player's text is bold. */
  private rebuildNamePlaque(state: EntityRenderState): void {
    disposeSubtree(state.namePlaque)
    state.namePlaque = undefined
    const background = namePlaqueBackground(state.kind)
    if (background === undefined) return
    const plaque = namePlaqueQuad(state.name, background, state.kind === 'player')
    state.node.add(plaque)
    state.namePlaque = plaque
  }

  private resolveEntityModel(state: EntityRenderState): void {
    // Disposed rather than merely detached: a placeholder owns its `BoxGeometry`, and a clone owns
    // its skeleton, so dropping either here would put it past the reach of any later sector cleanup.
    for (const child of [...state.modelHolder.children]) disposeSubtree(child)
    state.pose = undefined
    state.action = undefined
    const model = this.assets.entity(state.kind, state.figure)
    if (model === undefined) {
      state.modelHolder.scale.setScalar(1)
      const placeholder = entityPlaceholder(state.maskSize)
      enableShadows(placeholder)
      state.modelHolder.add(placeholder)
      state.isPlaceholder = true
      state.mixer = undefined
      return
    }
    enableShadows(model)
    state.modelHolder.add(model)
    state.modelHolder.scale.setScalar(characterScale(state.maskSize))
    state.mixer = new THREE.AnimationMixer(model)
    state.isPlaceholder = false
  }

  /** Returns the floor's centre, which `load` frames the camera on when no player will arrive. */
  private buildFloor(sector: Sector, root: THREE.Object3D): THREE.Vector3 {
    // Through the accessors, as `WorldScene3D.makeFloor` uses `sector.pixelWidth`/`pixelHeight`:
    // the tile-to-pixel rule has one home, so the floor mesh cannot drift from the collision bounds.
    const widthMeters = f32(f32(sectorPixelWidth(sector)) * ORTHO_RIG.worldUnitsPerPixel)
    const depthMeters = f32(f32(sectorPixelHeight(sector)) * ORTHO_RIG.worldUnitsPerPixel)
    const material = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0 })
    const texture = this.applyFloorTexture(material, sector.floorMaterialID, widthMeters, depthMeters)
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(widthMeters, depthMeters), material)
    markOwned(floor, { geometry: true, material: true })
    // Receives but does not cast: a ground plane casting into its own depth comparison is the
    // classic source of shadow acne, and there is nothing below it to catch a shadow anyway.
    floor.receiveShadow = true
    floor.rotation.x = -Math.PI / 2
    // The plane is centred at its origin; offset by half so the sector's top-left pixel maps to a
    // floor corner, matching `worldPosition`.
    floor.position.set(widthMeters / 2, 0, depthMeters / 2)
    root.add(floor)
    // The metres are retained, not just the material id: the post-prewarm heal has to recompute the
    // UV repeat from the same bounds, and there is nothing else to derive them from at that point.
    this.floorState = {
      mesh: floor,
      materialID: sector.floorMaterialID,
      isFallback: texture === undefined,
      widthMeters,
      depthMeters,
    }

    for (const patch of sector.floorPatches) {
      const mesh = this.buildFloorPatch(patch)
      root.add(mesh)
      // Recorded like the placed objects, so a patch that loaded before the texture cache warmed
      // heals with the rest instead of staying a flat grey rectangle where an authored street is.
      // Rebuilt rather than re-textured in place: the sector-space UVs depend on the texture's
      // aspect, so the attribute has to be recomputed alongside the map.
      this.floorPatchStates.push({
        mesh,
        patch,
        isFallback: this.assets.floorTexture(patch.floorMaterialID) === undefined,
      })
    }

    return floor.position.clone()
  }

  /**
   * Points `material` at the floor texture for `materialID`, tiled to the sector's bounds. Returns
   * the resolved texture, or `undefined` when the cache has not warmed and the grey fallback applies.
   *
   * Shared by `buildFloor` and the post-prewarm heal — the same reason the Swift original routes both
   * through one `floorMaterial(texture:widthMeters:depthMeters:)`. Assigning the cached texture
   * directly instead would leave `repeat` at its `(1, 1)` default, stretching a single tile across the
   * whole sector: a healed floor that looks worse than the placeholder it replaced.
   */
  private applyFloorTexture(
    material: THREE.MeshStandardMaterial,
    materialID: string,
    widthMeters: number,
    depthMeters: number
  ): THREE.Texture | undefined {
    const texture = this.assets.floorTexture(materialID)
    if (texture === undefined) {
      material.color = new THREE.Color(0x808080)
      material.map = null
      return undefined
    }
    // Cloned so the per-sector repeat never mutates the shared cache entry.
    const repeat = texture.clone()
    repeat.needsUpdate = true
    // A non-square source keeps its authored aspect: the V repeat shrinks with height/width.
    // Narrowed like `floorPatchUVRect`, which computes this same ratio for patch quads: Swift
    // runs it entirely in `Float` (`WorldScene3D.floorMaterial`), so a patch and the floor it
    // sits on must reach the identical repeat or their texture grids drift apart at the seam.
    repeat.repeat.set(
      f32(widthMeters / FLOOR_MATERIAL_TILE_METERS),
      f32(
        depthMeters /
          f32(FLOOR_MATERIAL_TILE_METERS * textureAspect(texture.image as { width: number; height: number }))
      )
    )
    material.color = new THREE.Color(0xffffff)
    material.map = repeat
    material.needsUpdate = true
    return texture
  }

  private buildFloorPatch(patch: Sector['floorPatches'][number]): THREE.Mesh {
    const texture = this.assets.floorTexture(patch.floorMaterialID)
    const unit = ORTHO_RIG.worldUnitsPerPixel
    const width = f32(f32(patch.width) * unit)
    const depth = f32(f32(patch.height) * unit)
    const geometry = new THREE.PlaneGeometry(width, depth)
    const uv = floorPatchUVRect(
      patch,
      textureAspect(texture?.image as { width: number; height: number } | undefined)
    )
    // Sector-space UVs, so abutting same-material rects continue one seamless grid rather than
    // resetting the texture phase at every seam.
    //
    // V is **negated**, not swapped. `PlaneGeometry` emits indices 0/1 as the local +Y row, which
    // `rotation.x = -pi/2` maps to world -Z — the *smaller* sector y. So V has to decrease as sector
    // y grows, matching the base floor, which uses the default plane UVs (+Y carries v=1). Assigning
    // `origin.y` to the -Z row instead — the arrangement `WorldScene3D.swift` uses, where the
    // descriptor's own vertex order runs the other way — would flip every patch against the floor
    // beneath it. Negating keeps that orientation while making V a function of sector y alone:
    // without it the intercept depends on the patch's own position and height, so each quad mirrors
    // about its own centre and vertically abutting rects meet at two different phases.
    const attribute = geometry.getAttribute('uv') as THREE.BufferAttribute
    const corners = [
      [uv.origin.x, -uv.origin.y],
      [uv.origin.x + uv.span.x, -uv.origin.y],
      [uv.origin.x, -(uv.origin.y + uv.span.y)],
      [uv.origin.x + uv.span.x, -(uv.origin.y + uv.span.y)],
    ]
    corners.forEach(([u, v], index) => attribute.setXY(index, u!, v!))
    attribute.needsUpdate = true

    // Cloned for the same reason the base floor clones, even though a patch needs no `repeat`: the
    // mesh owns its material, and disposal takes the material's map with it. Handing over the cache
    // entry itself would leave the next sector that paints this material re-uploading the texture and
    // regenerating its mipmaps on the first drawn frame.
    const patchTexture = texture?.clone()
    if (patchTexture !== undefined) patchTexture.needsUpdate = true
    const material = new THREE.MeshStandardMaterial({
      roughness: 1,
      metalness: 0,
      // Culling off so the quad renders regardless of triangle winding.
      side: THREE.DoubleSide,
      ...(patchTexture === undefined ? { color: new THREE.Color(0x808080) } : { map: patchTexture }),
    })
    const mesh = new THREE.Mesh(geometry, material)
    markOwned(mesh, { geometry: true, material: true })
    mesh.receiveShadow = true
    mesh.rotation.x = -Math.PI / 2
    const centre = worldPosition(patch.x + patch.width / 2, patch.y + patch.height / 2)
    mesh.position.set(centre.x, FLOOR_PATCH_LIFT, centre.z)
    return mesh
  }

  private buildObjects(sector: Sector, root: THREE.Object3D): void {
    for (const object of [...sector.objects].sort((a, b) => a.priority - b.priority)) {
      const node = new THREE.Object3D()
      const resolved = this.assets.object(object.modelID)
      if (resolved !== undefined) {
        attachResolvedObject(node, resolved, object)
      } else {
        node.add(objectPlaceholder(object))
      }
      enableShadows(node)
      const anchorBottomY = objectAnchorBottomY(object, sector.collisionMasks)
      this.alignObject(node, object, anchorBottomY)
      root.add(node)
      this.placedObjects.push({ node, object, anchorBottomY, isPlaceholder: resolved === undefined })
    }
  }

  private alignObject(node: THREE.Object3D, object: Sector['objects'][number], anchorBottomY: number): void {
    const depth = new THREE.Box3().setFromObject(node).getSize(new THREE.Vector3()).z
    const position = objectNodePosition(object, anchorBottomY, depth)
    node.position.set(position.x, position.y, position.z)
  }

  /**
   * Post-prewarm pass: swaps every placeholder for the now-cached model in place, so an arrival
   * that wins the race against prewarm self-heals instead of leaving permanent grey boxes.
   */
  private refreshResolvedModels(): void {
    for (const placed of this.placedObjects) {
      if (!placed.isPlaceholder) continue
      const model = this.assets.object(placed.object.modelID)
      if (model === undefined) continue
      // The placeholder owns its `BoxGeometry`, so it is disposed rather than just unparented.
      for (const child of [...placed.node.children]) disposeSubtree(child)
      attachResolvedObject(placed.node, model, placed.object)
      enableShadows(model)
      // The real prop's footprint depth differs from the placeholder's, so the anchor has to be
      // reapplied against the new bounds.
      this.alignObject(placed.node, placed.object, placed.anchorBottomY)
      placed.isPlaceholder = false
    }
    for (const state of this.entityStates.values()) {
      if (state.isPlaceholder) this.resolveEntityModel(state)
    }
    // The floor heals like every placed model rather than staying grey: a sector that loaded
    // before the texture cache warmed would otherwise keep its fallback tint for the session.
    const floor = this.floorState
    if (floor?.isFallback === true) {
      const material = floor.mesh.material as THREE.MeshStandardMaterial
      const resolved = this.applyFloorTexture(
        material,
        floor.materialID,
        floor.widthMeters,
        floor.depthMeters
      )
      floor.isFallback = resolved === undefined
    }
    for (const state of this.floorPatchStates) {
      if (!state.isFallback) continue
      if (this.assets.floorTexture(state.patch.floorMaterialID) === undefined) continue
      const parent = state.mesh.parent
      const rebuilt = this.buildFloorPatch(state.patch)
      parent?.add(rebuilt)
      disposeSubtree(state.mesh)
      state.mesh = rebuilt
      state.isFallback = false
    }
  }

  private configureSunShadow(): void {
    this.sun.castShadow = true
    this.sun.shadow.mapSize.set(SUN_SHADOW.mapSize, SUN_SHADOW.mapSize)
    this.sun.shadow.normalBias = SUN_SHADOW.normalBias
    const shadowCamera = this.sun.shadow.camera
    shadowCamera.near = SUN_SHADOW.near
    shadowCamera.far = SUN_SHADOW.far
    shadowCamera.left = -SUN_SHADOW.orthographicScale
    shadowCamera.right = SUN_SHADOW.orthographicScale
    shadowCamera.top = SUN_SHADOW.orthographicScale
    shadowCamera.bottom = -SUN_SHADOW.orthographicScale
    shadowCamera.updateProjectionMatrix()
  }

  /**
   * Carries the sun's shadow volume with the camera focus, mirroring `repositionSun`.
   *
   * Both ends move together, which is the point: three.js derives a directional light's direction
   * from `position - target.position`, so anchoring the light at the world origin while the target
   * follows the player would swing the light angle further off the authored direction the further
   * the player walked from the sector's corner.
   */
  private repositionSun(): void {
    // The shadow map's texel grid lives in the light's own view plane, so that is where the anchor
    // has to be quantized. Rounding world XYZ instead leaves a fractional-texel phase on every step
    // — 0.5 world units is 21.33 texels at this scale, and the projection into the light plane
    // scales it again by the direction cosines — so the map re-samples the same silhouette against a
    // different sub-texel phase each frame and the edge pixels flip. Standing still the anchor is
    // constant and the phase is fixed, which is why it only shows while walking.
    const texel = (2 * SUN_SHADOW.orthographicScale) / SUN_SHADOW.mapSize
    // `Matrix4.lookAt` only uses `eye - target` normalized, so passing the direction against the
    // origin yields exactly the basis `DirectionalLightShadow` will build from the real position —
    // including its nudge for a light pointing straight down the up axis.
    this.shadowBasis.lookAt(this.sunDirection, ORIGIN, this.sun.up)
    this.shadowOrientation.setFromRotationMatrix(this.shadowBasis)
    const anchor = this.shadowAnchor.copy(this.focus)
    anchor.applyQuaternion(this.shadowOrientationInverse.copy(this.shadowOrientation).invert())
    // Only the two axes spanning the map. Quantizing depth as well would jitter the near/far range
    // against the geometry for no sampling benefit.
    anchor.x = Math.round(anchor.x / texel) * texel
    anchor.y = Math.round(anchor.y / texel) * texel
    anchor.applyQuaternion(this.shadowOrientation)

    this.sun.target.position.copy(anchor)
    this.sun.target.updateMatrixWorld()
    this.sun.position.copy(anchor).addScaledVector(this.sunDirection, SUN_SHADOW.distance)
  }

  private applySun(hour: number, minute: number, light: LightSetting): void {
    const state = sunState(hour, minute, light)
    this.sunDirection.set(state.direction.x, state.direction.y, state.direction.z)
    this.repositionSun()
    this.sun.intensity = state.sunIntensity / 1000
    this.sun.color.setRGB(state.sunColor.r, state.sunColor.g, state.sunColor.b)
    // A fixed low fill standing in for sky ambience, so the shadow side never drops to black.
    this.ambient.position.set(-0.3, 1, -0.4).multiplyScalar(30)
    this.ambient.intensity = state.ambientIntensity / 1000
  }

  private focusCamera(focus: THREE.Vector3): void {
    this.focus.copy(focus)
    const position = cameraPosition({ x: focus.x, y: focus.y, z: focus.z })
    this.camera.position.set(position.x, position.y, position.z)
    this.camera.lookAt(focus)
    this.repositionSun()
  }

  /** Test seam: the scale the camera is currently framed at. */
  _cameraScale(): number {
    return clampedScale(this.camera.top)
  }

  /** Test seam: how many placed objects still render placeholders. */
  _placeholderObjectCount(): number {
    return this.placedObjects.filter((placed) => placed.isPlaceholder).length
  }

  /** Test seam: the pose last selected for an entity. */
  _poseFor(entityID: number): AnimationPose | undefined {
    return this.entityStates.get(entityID)?.pose
  }

  /**
   * Test seam: an entity node's world position, so a tween's progress is observable.
   *
   * Needed because the tick clamp is only assertable against *how far* an entity moved — the node
   * existing says nothing about whether a stalled frame was bounded.
   */
  _positionFor(entityID: number): { x: number; y: number; z: number } | undefined {
    const node = this.entityStates.get(entityID)?.node
    if (node === undefined) return undefined
    return { x: node.position.x, y: node.position.y, z: node.position.z }
  }

  /** Test seam: the model holder's slewed yaw, which the overlays must never inherit. */
  _yawFor(entityID: number): number | undefined {
    return this.entityStates.get(entityID)?.modelHolder.rotation.y
  }

  /**
   * Test seam: the entity node's own yaw, which must stay identity.
   *
   * The counterpart to `_yawFor`, and separate from it on purpose — the plaque and the speech
   * bubble hang off this node, so a facing yaw reaching it tilts them with the character. Reading
   * the holder cannot see that: both would turn together and the holder's value would look right.
   * `EntityNodeProbe.nodeOrientation` exists in `WorldScene3D` for the same reason.
   */
  _nodeYawFor(entityID: number): number | undefined {
    return this.entityStates.get(entityID)?.node.rotation.y
  }

  /**
   * Test seam: an entity's live speech-bubble node.
   *
   * The bubble is the scene's highest-frequency allocator — one supersampled `CanvasTexture` per
   * chat line — and it is replaced, expired, and torn down through three separate paths. Reaching it
   * by name is what lets a test spy on the texture it is about to lose; searching the graph for it
   * cannot distinguish a bubble from the name plaque hanging off the same node.
   */
  _bubbleNodeFor(entityID: number): THREE.Object3D | undefined {
    return this.bubbles.get(entityID)?.node
  }
}

function entityPlaceholder(maskSize: GridSize): THREE.Object3D {
  const width = f32(f32(maskSize.width) * ORTHO_RIG.worldUnitsPerPixel)
  const height = f32(f32(maskSize.height) * ORTHO_RIG.worldUnitsPerPixel)
  const box = new THREE.Mesh(new THREE.BoxGeometry(width, height, width / 2), PLACEHOLDER_MATERIAL)
  // Own geometry, shared material — disposing `PLACEHOLDER_MATERIAL` would blank every other one.
  markOwned(box, { geometry: true, material: false })
  box.position.y = height / 2
  return box
}

/**
 * Parents a resolved prop model under its placed node, applying the authored yaw.
 *
 * Shared by the cold load and the prewarm heal, because only a *resolved* model may take that yaw:
 * a placeholder is built from `sourceWidth`/`sourceHeight`, which already carry the rotated
 * footprint extents, so rotating one again would swap its axes for 90/270-degree placements. The
 * two paths produce the same prop, and a yaw-convention change applied to one and missed on the
 * other renders correctly on a cold load and wrong after a heal.
 */
function attachResolvedObject(
  node: THREE.Object3D,
  model: THREE.Object3D,
  object: Sector['objects'][number]
): void {
  model.rotation.y += objectYawRadians(object)
  node.add(model)
}

function objectPlaceholder(object: Sector['objects'][number]): THREE.Object3D {
  const width = f32(f32(object.sourceWidth) * ORTHO_RIG.worldUnitsPerPixel)
  const depth = f32(f32(object.sourceHeight) * ORTHO_RIG.worldUnitsPerPixel)
  // Keep the `f32` even though no test can distinguish it: `groundCellSize` is 32, so this
  // multiply only shifts the exponent and is exact either way. It states the contract the other
  // two narrowings here carry, and it starts mattering the moment the cell size is not a power of
  // two.
  const height = f32(f32(SOMNIO_CONSTANTS.groundCellSize) * ORTHO_RIG.worldUnitsPerPixel)
  const box = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), PLACEHOLDER_MATERIAL)
  markOwned(box, { geometry: true, material: false })
  box.position.y = height / 2
  return box
}

/** `overlayScale` — overlay artwork is drawn a little under 1:1 with legacy pixels. */
const OVERLAY_SCALE = f32(0.8)

/**
 * Fixed screen-aligned orientation for overlay quads: the camera's **own** orientation, which is
 * what `overlayOrientation` uses natively.
 *
 * Constant because the rig is locked — only the camera's position follows the player. Rebuilding it
 * from `pitchDegrees`/`yawDegrees` as Euler angles instead looks right and is not: those describe
 * the rig's offset direction, not the look rotation, and a quad carrying them sits at a residual
 * yaw that foreshortens its width. The artwork then reads as a squeezed balloon with its last word
 * apparently cut off, which is a texture-mapping symptom of a rotation bug.
 */
const OVERLAY_ORIENTATION = (() => {
  const eye = cameraPosition({ x: 0, y: 0, z: 0 })
  // `Matrix4.lookAt` uses the camera convention (-Z forward). A `PlaneGeometry` faces +Z, so the
  // camera's rotation turns the plane's front back toward the eye.
  const matrix = new THREE.Matrix4().lookAt(
    new THREE.Vector3(eye.x, eye.y, eye.z),
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, 1, 0)
  )
  return new THREE.Quaternion().setFromRotationMatrix(matrix)
})()
/** Gap between the speaker's head and the balloon's tail tip. */
const BUBBLE_HEAD_GAP = f32(0.2)
/**
 * Gap between the feet anchor and the top of the name plaque.
 *
 * The narrowing is currently indistinguishable from a plain `0.15` in the plaque's vertical offset,
 * because the plaque height is a fixed 18 px there and the double rounding happens to agree. Change
 * `NAME_PLAQUE.fontSize` and it starts mattering, with nothing to announce that it has.
 */
const PLAQUE_FEET_GAP = f32(0.15)
/** Advance past the point where the below-the-feet quad clears the floor plane. */
const PLAQUE_FLOOR_CLEARANCE = f32(0.15)

/**
 * `userData` keys marking which GPU resources a mesh allocated itself, and may therefore dispose.
 *
 * Two flags rather than one because ownership genuinely differs: the placeholders allocate their own
 * `BoxGeometry` but share the module-level `PLACEHOLDER_MATERIAL`, so disposing their material would
 * blank every other placeholder in the scene.
 */
const OWNS_GEOMETRY = 'somnioOwnsGeometry'
const OWNS_MATERIAL = 'somnioOwnsMaterial'

/** Marks a mesh's allocations as this file's to release. */
function markOwned(mesh: THREE.Mesh, options: { geometry: boolean; material: boolean }): void {
  mesh.userData[OWNS_GEOMETRY] = options.geometry
  mesh.userData[OWNS_MATERIAL] = options.material
}

/**
 * Releases the GPU resources a detached subtree owned, then detaches it.
 *
 * `removeFromParent()` alone drops the reference but leaves the geometry, material, and texture in
 * `WebGLRenderer`'s internal maps, so every sector hop and every chat bubble would accumulate VRAM
 * until the context is lost — the world going black with nothing the player can act on. Three.js
 * documents disposal as the caller's job for exactly this reason.
 *
 * A model clone's `geometry` and `material` are skipped, because `SkeletonUtils.clone` shares both
 * with the cached prototype and disposing a clone's would break every other clone *and* the cache
 * entry. Its **skeleton** is the exception, and the reason this traversal cannot key on the ownership
 * flags alone: `SkeletonUtils.clone` assigns `sourceMesh.skeleton.clone()`, so every clone gets its
 * own `Skeleton`, and `WebGLRenderer` lazily allocates a per-`Skeleton` bone `DataTexture` on first
 * render. Nothing in three.js reclaims it — there is no `FinalizationRegistry`, so collecting the JS
 * wrapper leaves the GL texture allocated, and `Skeleton.dispose()` is the only release path. A clone
 * therefore owns exactly one GPU resource while carrying neither flag.
 *
 * This is the single detach-and-dispose entry point on purpose. A bare `removeFromParent()` on a
 * flagged mesh puts it beyond the reach of any later sector cleanup, so the flags stop meaning
 * anything; every site that drops a node routes through here instead.
 */
function disposeSubtree(root: THREE.Object3D | undefined): void {
  if (root === undefined) return
  root.traverse((object) => {
    const skinned = object as THREE.SkinnedMesh
    if (skinned.isSkinnedMesh) skinned.skeleton?.dispose()
    const mesh = object as THREE.Mesh
    if (mesh.userData[OWNS_GEOMETRY] === true) mesh.geometry.dispose()
    if (mesh.userData[OWNS_MATERIAL] !== true) return
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      // Safe to take the map with the material because every owned material holds a texture this
      // file minted: the floor and its patches clone their cached entry, and each overlay rasterizes
      // a fresh `CanvasTexture`. Disposing a cache entry directly would corrupt nothing, but
      // `WebGLTextures` clears its `__version` unconditionally, so the next sector using that
      // material would pay a full re-upload and mipmap regeneration on its first drawn frame.
      ;(material as THREE.MeshBasicMaterial).map?.dispose()
      material.dispose()
    }
  })
  root.removeFromParent()
}

/**
 * Overlay quad with a **fixed** screen-aligned orientation rather than a billboard.
 *
 * A billboard aims each quad at the camera *point*, which under an orthographic projection
 * leaves off-centre speakers visibly tilted — the camera rig is locked, so a constant
 * orientation is both correct and cheaper.
 *
 * Returns the container and the plate separately so the caller can position the plate inside the
 * screen-aligned frame, where +Y is camera-up and +Z is toward the camera.
 */
function overlayQuad(art: RasterArt): { container: THREE.Object3D; plate: THREE.Mesh; size: THREE.Vector2 } {
  const container = new THREE.Object3D()
  container.quaternion.copy(OVERLAY_ORIENTATION)
  const texture = new THREE.CanvasTexture(art.canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true })
  const size = new THREE.Vector2(
    f32(f32(f32(art.widthPixels) * ORTHO_RIG.worldUnitsPerPixel) * OVERLAY_SCALE),
    f32(f32(f32(art.heightPixels) * ORTHO_RIG.worldUnitsPerPixel) * OVERLAY_SCALE)
  )
  const plate = new THREE.Mesh(new THREE.PlaneGeometry(size.x, size.y), material)
  // Every overlay quad allocates its own canvas texture, material, and geometry.
  markOwned(plate, { geometry: true, material: true })
  container.add(plate)
  return { container, plate, size }
}

/** Balloon anchored at its tail tip, so the caller pins the tip and the body rises above it. */
function speechBubbleQuad(lines: readonly string[]): THREE.Object3D {
  const { container, plate, size } = overlayQuad(renderSpeechBubble(lines))
  plate.position.y = size.y / 2
  return container
}

/**
 * Name plaque hanging just below the feet anchor.
 *
 * Hanging at negative Y alone would dip the quad below the floor plane, which always occludes
 * below-ground content under the downward 3/4 camera. The toward-camera Z advance compensates —
 * invisible under the orthographic projection, but it lifts the quad's world height above the
 * floor and draws it in front of the speaker.
 */
function namePlaqueQuad(name: string, background: string, bold: boolean): THREE.Object3D {
  const { container, plate, size } = overlayQuad(renderNamePlaque(name, background, bold))
  // Swift computes this whole chain in `Float` (`tan(pitch)` resolves to the `tanf` overload), so
  // every step narrows. The halving stays unnarrowed on purpose: division by 2 is exact in binary,
  // so `f32` around it would be noise rather than parity.
  const drop = f32(size.y + PLAQUE_FEET_GAP)
  const pitch = f32(f32(ORTHO_RIG.pitchDegrees * FLOAT_PI) / 180)
  plate.position.set(
    0,
    -f32(size.y / 2 + PLAQUE_FEET_GAP),
    f32(f32(drop / f32(Math.tan(pitch))) + PLAQUE_FLOOR_CLEARANCE)
  )
  return container
}
