import { describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { WorldScene } from '@/scene/worldScene'
import type { ModelAssets } from '@/scene/modelAssets'
import { ORTHO_RIG, cameraPosition } from '@/scene/cameraRig'
import { SUN_SHADOW } from '@/scene/dayNightSun'
import { MAX_TICK_DELTA } from '@/scene/animation'
import { FLOOR_PATCH_LIFT } from '@/scene/placement'
import {
  NAME_PLAQUE,
  baselineBelowBoxTop,
  baselineInCenteredBox,
  namePlaqueBackground,
  nativeLineBoxHeight,
  renderNamePlaque,
  speechBubbleFrameSize,
} from '@/scene/overlayArt'
import { sectorFromWire, sectorPixelHeight, sectorPixelWidth } from '@/core/sector'
import { FLOAT_PI, SOMNIO_CONSTANTS, f32 } from '@/core'
import type { WireSector } from '@/protocol'
import type { WorldEntity } from '@/core/worldEntity'

/**
 * Graph-level coverage. Pixels are not unit-testable without a GPU, but the placement, framing,
 * and self-heal decisions all live in the scene graph and are.
 */

/** Assets that resolve nothing, so everything renders a placeholder until `resolving()` swaps in. */
function emptyAssets(): ModelAssets {
  return {
    prewarm: async () => {},
    entity: () => undefined,
    object: () => undefined,
    floorTexture: () => undefined,
    clipsFor: () => [],
  }
}

function resolvingAssets(): ModelAssets {
  return {
    prewarm: async () => {},
    entity: () => new THREE.Object3D(),
    object: () => new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1)),
    floorTexture: () => undefined,
    clipsFor: () => [],
  }
}

function wireSector(overrides: Partial<WireSector> = {}): WireSector {
  return {
    name: 'EdariaMitte',
    version: 1,
    dimensions: { width: 4, height: 4 },
    floorMaterialID: 'grass-meadow',
    light: { indoor: false, brightness: 100 },
    objects: [],
    collisionMasks: [],
    portals: [],
    npcs: [],
    monsterSpawns: [],
    floorPatches: [],
    ...overrides,
  }
}

/**
 * Sector roots, identified by carrying the floor plane. The scene also holds the lights and the
 * backdrop, so a bare `children.length` cannot tell a parked root from the furniture.
 */
function sectorRootCount(scene: WorldScene): number {
  return scene.scene.children.filter((child) =>
    child.children.some((grandchild) => {
      const mesh = grandchild as THREE.Mesh
      return mesh.isMesh === true && mesh.geometry instanceof THREE.PlaneGeometry
    })
  ).length
}

function playerEntity(id = 1): WorldEntity {
  return {
    id,
    kind: 'player',
    figure: 0,
    gender: 0,
    position: { x: 100, y: 100 },
    facing: 0,
    tempo: 2,
    maskSize: { width: 32, height: 48 },
    name: 'Saibot',
  }
}

describe('camera framing', () => {
  it('starts at the default scale as a half-height', () => {
    const scene = new WorldScene(emptyAssets(), 1)
    expect(scene.camera.top).toBe(ORTHO_RIG.defaultScale)
    expect(scene.camera.bottom).toBe(-ORTHO_RIG.defaultScale)
  })

  /**
   * The MMO-fairness contract: resizing must not reveal more world vertically, only wider. A
   * handler that tied the frustum to pixel height would hand large-window players extra view.
   */
  it('holds the vertical extent constant across resizes and only widens', () => {
    const scene = new WorldScene(emptyAssets(), 1)
    const verticalBefore = scene.camera.top - scene.camera.bottom
    const widthBefore = scene.camera.right - scene.camera.left

    scene.setViewportAspect(2.5)

    expect(scene.camera.top - scene.camera.bottom).toBe(verticalBefore)
    expect(scene.camera.right - scene.camera.left).toBeGreaterThan(widthBefore)
  })

  it('magnifies on zoom rather than revealing more world', () => {
    const scene = new WorldScene(emptyAssets(), 1)
    scene.applyZoomFactor(2)
    expect(scene.camera.top).toBe(1.5)
  })

  /**
   * `load(sector, false)` frames the whole sector, mirroring `WorldScene3D.load(sector:awaitingPlayerPlacement:)`. The client
   * only ever passes `true` — `placeEntity` re-centres on the player straight after — so nothing in
   * the running app depends on this, and that is precisely why it needs a test: a surface that
   * previewed a sector without joining it would otherwise open framed on the world origin, with the
   * sector off to one side and no error to explain it.
   */
  it('frames the sector centre when no player will arrive', () => {
    const scene = new WorldScene(emptyAssets(), 1)
    const sector = sectorFromWire(wireSector({ dimensions: { width: 8, height: 6 } }))

    scene.load(sector, false)

    const centreX = f32(f32(sectorPixelWidth(sector)) * ORTHO_RIG.worldUnitsPerPixel) / 2
    const centreZ = f32(f32(sectorPixelHeight(sector)) * ORTHO_RIG.worldUnitsPerPixel) / 2
    expect(centreX).not.toBe(centreZ)
    // The camera sits at its rig offset *from* the focus, so the focus is what the offset removes.
    const offset = cameraPosition({ x: 0, y: 0, z: 0 })
    expect(scene.camera.position.x - offset.x).toBeCloseTo(centreX, 6)
    expect(scene.camera.position.z - offset.z).toBeCloseTo(centreZ, 6)
  })

  /** The held-swap counterpart: the camera must stay put until the swap re-centres it. */
  it('leaves the camera alone while a sector is held for a player placement', () => {
    const scene = new WorldScene(emptyAssets(), 1)
    scene.load(sectorFromWire(wireSector()), false)
    const before = scene.camera.position.clone()

    scene.load(sectorFromWire(wireSector({ name: 'Nordwiese', dimensions: { width: 40, height: 40 } })), true)

    expect(scene.camera.position.x).toBe(before.x)
    expect(scene.camera.position.z).toBe(before.z)
  })
})

describe('sector loading', () => {
  it('builds a floor and one node per object', () => {
    const scene = new WorldScene(emptyAssets(), 1)
    const sector = sectorFromWire(
      wireSector({
        objects: [
          { x: 0, y: 0, modelID: 'barrel', sourceWidth: 32, sourceHeight: 32, priority: 1, rotation: 0 },
          { x: 64, y: 0, modelID: 'chest', sourceWidth: 32, sourceHeight: 32, priority: 0, rotation: 90 },
        ],
      })
    )

    scene.load(sector, false)

    expect(scene._placeholderObjectCount()).toBe(2)
  })

  /**
   * The continuity contract, on the axis nothing checked: two patches abutting *vertically* must
   * meet at one V value, so the texture grid runs unbroken across the seam.
   *
   * The hazard is that V can be an affine function of the row and still be wrong — if its intercept
   * depends on the patch's own position and height, each quad mirrors about its own centre and the
   * grid phase jumps at every horizontal seam. That is invisible in a single-patch render, and every
   * shipped fixture happens to share `2*y + height` within its sector, so only two patches with
   * different vertical centres can distinguish the two shapes.
   */
  it('gives vertically abutting patches one shared V at their seam', () => {
    const scene = new WorldScene(emptyAssets(), 1)
    const sector = sectorFromWire(
      wireSector({
        floorPatches: [
          { floorMaterialID: 'cobble-town', x: 0, y: 0, width: 128, height: 64 },
          { floorMaterialID: 'cobble-town', x: 0, y: 64, width: 128, height: 448 },
        ],
      })
    )

    scene.load(sector, false)

    // Patch quads carry a rewritten uv attribute; the base floor and the backdrop do not.
    const patchUVs: Float32Array[] = []
    scene.scene.traverse((object) => {
      const mesh = object as THREE.Mesh
      if (!mesh.isMesh || !(mesh.geometry instanceof THREE.PlaneGeometry)) return
      const uv = mesh.geometry.getAttribute('uv') as THREE.BufferAttribute
      // A plane's default uv runs 0..1; a patch's is in sector space and negative on V.
      if ((uv.array as Float32Array)[1]! <= 0) patchUVs.push(uv.array as Float32Array)
    })
    expect(patchUVs).toHaveLength(2)

    // Indices 0/1 are the local +Y row, which `rotation.x = -pi/2` maps to world -Z: the patch's
    // north edge, at the smaller sector y. Indices 2/3 are its south edge.
    const [upper, lower] = patchUVs as [Float32Array, Float32Array]
    const upperSouthV = upper[5]
    const lowerNorthV = lower[1]
    expect(upperSouthV).toBeCloseTo(lowerNorthV!, 6)
  })

  it('renders floor patches as their own quads', () => {
    const scene = new WorldScene(emptyAssets(), 1)
    const sector = sectorFromWire(
      wireSector({
        floorPatches: [
          { floorMaterialID: 'cobble-town', x: 0, y: 0, width: 128, height: 128 },
          { floorMaterialID: 'cobble-town', x: 128, y: 0, width: 128, height: 128 },
        ],
      })
    )

    scene.load(sector, false)

    // Floor plus two patches.
    const meshes: THREE.Mesh[] = []
    scene.scene.traverse((node) => {
      if ((node as THREE.Mesh).isMesh === true) meshes.push(node as THREE.Mesh)
    })
    // The scene also carries the backdrop plane, so assert at least the floor + two patches.
    expect(meshes.length).toBeGreaterThanOrEqual(4)
  })

  /**
   * Patches are coplanar with the base floor unless something separates them, and two coplanar
   * quads z-fight — the symptom is a street that flickers between cobble and grass as the camera
   * moves. Nothing referenced the lift, so setting it to 0 passed the whole suite.
   */
  it('lifts patch quads clear of the base floor plane', () => {
    const scene = new WorldScene(emptyAssets(), 1)
    scene.load(
      sectorFromWire(
        wireSector({
          floorPatches: [{ floorMaterialID: 'cobble-town', x: 0, y: 0, width: 128, height: 128 }],
        })
      ),
      false
    )

    const planeHeights: number[] = []
    scene.scene.traverse((object) => {
      const mesh = object as THREE.Mesh
      if (mesh.isMesh && mesh.geometry instanceof THREE.PlaneGeometry) {
        planeHeights.push(mesh.position.y)
      }
    })
    expect(planeHeights).toContain(FLOOR_PATCH_LIFT)
    expect(FLOOR_PATCH_LIFT).toBeGreaterThan(0)
    // And the base floor is the thing it clears, so the two must not share a height.
    expect(planeHeights).toContain(0)
  })
})

describe('held sector swap', () => {
  /**
   * Without the hold, a portal hop shows one frame of the new sector framed on its origin with
   * no character in it.
   */
  it('keeps the incoming sector hidden until the player is placed', () => {
    const scene = new WorldScene(emptyAssets(), 1)
    scene.load(sectorFromWire(wireSector()), false)
    scene.placeEntity(playerEntity())

    scene.load(sectorFromWire(wireSector({ name: 'Nordwiese' })), true)
    const hidden = scene.scene.children.filter((child) => child.visible === false)
    expect(hidden.length).toBeGreaterThan(0)

    scene.placeEntity(playerEntity())
    expect(scene.scene.children.filter((child) => child.visible === false)).toHaveLength(0)
    // And the outgoing root is *gone*, not merely revealed alongside: a parked root is visible, so
    // a `visible === false` filter alone passes while both sectors render on top of each other.
    expect(sectorRootCount(scene)).toBe(1)
  })

  it('drops a parked sector when a splash interrupts the swap', () => {
    const scene = new WorldScene(emptyAssets(), 1)
    // Both sectors carry an object, so the placeholder count can actually fall to zero — with the
    // empty default it reads 0 before the splash as well, and the assertion measures nothing.
    const populated = wireSector({
      objects: [
        { x: 0, y: 0, modelID: 'barrel', sourceWidth: 32, sourceHeight: 32, priority: 0, rotation: 0 },
      ],
    })
    scene.load(sectorFromWire(populated), false)
    scene.load(sectorFromWire({ ...populated, name: 'Nordwiese' }), true)
    expect(scene._placeholderObjectCount()).toBeGreaterThan(0)

    scene.showSplash()

    expect(scene._placeholderObjectCount()).toBe(0)
  })
})

describe('post-prewarm self-heal', () => {
  /**
   * An arrival that wins the race against prewarm must not keep grey boxes for the session.
   */
  it('swaps placeholders for real models once the cache warms', async () => {
    const assets = emptyAssets()
    const scene = new WorldScene(assets, 1)
    scene.load(
      sectorFromWire(
        wireSector({
          objects: [
            { x: 0, y: 0, modelID: 'barrel', sourceWidth: 32, sourceHeight: 32, priority: 0, rotation: 0 },
          ],
        })
      ),
      false
    )
    expect(scene._placeholderObjectCount()).toBe(1)

    // The placeholder owns its `BoxGeometry`, so the swap has to free it rather than merely
    // unparenting it — once detached it is past the reach of any later sector cleanup, and a
    // membership assertion alone cannot tell the two apart.
    const placeholders: THREE.Mesh[] = []
    scene.scene.traverse((object) => {
      const mesh = object as THREE.Mesh
      if (mesh.isMesh && mesh.geometry instanceof THREE.BoxGeometry) placeholders.push(mesh)
    })
    expect(placeholders).toHaveLength(1)
    const placeholderDispose = vi.spyOn(placeholders[0]!.geometry, 'dispose')

    const warm = resolvingAssets()
    // Wrapped rather than assigned directly so the methods stay bound to `warm`.
    assets.object = (id) => warm.object(id)
    assets.entity = (kind, figure) => warm.entity(kind, figure)
    await scene.prewarm()

    expect(scene._placeholderObjectCount()).toBe(0)
    expect(placeholderDispose).toHaveBeenCalledTimes(1)
  })

  /**
   * The heal path has to apply the authored yaw exactly as the cold load does. It is the reason
   * `attachResolvedObject` exists — a yaw-convention change applied to one and missed on the other
   * renders correctly on a cold load and wrong after a heal, so a door faces the wrong way and a
   * shelf wall runs across the room instead of along it, but only for players whose sector loaded
   * before its models resolved.
   */
  it('applies the authored yaw when a model resolves through the heal, not only on a cold load', async () => {
    const assets = emptyAssets()
    const scene = new WorldScene(assets, 1)
    scene.load(
      sectorFromWire(
        wireSector({
          objects: [
            { x: 0, y: 0, modelID: 'door', sourceWidth: 32, sourceHeight: 32, priority: 0, rotation: 270 },
          ],
        })
      ),
      false
    )
    expect(scene._placeholderObjectCount()).toBe(1)

    const warm = resolvingAssets()
    assets.object = (id) => warm.object(id)
    assets.entity = (kind, figure) => warm.entity(kind, figure)
    await scene.prewarm()

    const yaws: number[] = []
    scene.scene.traverse((object) => {
      const mesh = object as THREE.Mesh
      if (mesh.isMesh && mesh.geometry instanceof THREE.BoxGeometry) yaws.push(mesh.rotation.y)
    })
    expect(yaws).toHaveLength(1)
    // 270 degrees counter-clockwise seen from above, the authored convention for a south-facing door.
    //
    // Exact rather than approximate, because the Swift original computes the whole angle in `Float`
    // (`simd_quatf(angle: Float(object.rotation) * .pi / 180, ...)`) and `Float.pi` rounds toward
    // zero where `Math.PI` does not — so the un-narrowed expression is a different number, and a
    // `toBeCloseTo` cannot tell them apart.
    expect(yaws[0]).toBe(f32(f32(270 * FLOAT_PI) / 180))
    expect(f32(f32(270 * FLOAT_PI) / 180)).not.toBe((270 * Math.PI) / 180)
  })
})

/**
 * The renderer mirrors a Swift original that computes in `Float`, and `Web/src/core/float.ts`
 * exists so the two cannot drift. These pin the narrowings that carry that contract: each is a
 * genuine numeric difference, not a formality — over the Int16 pixel range `f32(f32(px) * unit)`
 * differs from `px * unit` for 32,738 of 32,768 widths, first at px = 5.
 *
 * Every narrowed axis is asserted, not just the width, and the inputs are deliberately **not
 * square**: with 5 x 5 a mutation that drops the narrowing on one axis, or swaps two of them,
 * produces the value the other axis was going to be checked against and no assertion notices.
 */
describe('pixel-to-metre conversions narrow through Float, as the Swift original does', () => {
  /** `f32(f32(px) * unit)`, the renderer's own chain, and the un-narrowed value it must not be. */
  const narrowed = (pixels: number) => f32(f32(pixels) * ORTHO_RIG.worldUnitsPerPixel)
  const unnarrowed = (pixels: number) => pixels * ORTHO_RIG.worldUnitsPerPixel

  /** Every `PlaneGeometry` in the scene as `{width, height}`; the backdrop is a plane too. */
  function planeSizes(scene: WorldScene): { width: number; height: number }[] {
    const sizes: { width: number; height: number }[] = []
    scene.scene.traverse((object) => {
      const mesh = object as THREE.Mesh
      if (mesh.isMesh && mesh.geometry instanceof THREE.PlaneGeometry) {
        sizes.push({
          width: mesh.geometry.parameters.width,
          height: mesh.geometry.parameters.height,
        })
      }
    })
    return sizes
  }

  function firstBox(scene: WorldScene): THREE.BoxGeometry | undefined {
    let box: THREE.BoxGeometry | undefined
    scene.scene.traverse((object) => {
      const mesh = object as THREE.Mesh
      if (mesh.isMesh && mesh.geometry instanceof THREE.BoxGeometry) box = mesh.geometry
    })
    return box
  }

  it('sizes the floor plane with a narrowed product on both axes', () => {
    const scene = new WorldScene(emptyAssets(), 1)
    const sector = sectorFromWire(wireSector({ dimensions: { width: 5, height: 7 } }))
    scene.load(sector, false)

    // Through the same accessors the renderer uses, so the tile-to-pixel rule keeps one home.
    const widthPixels = sectorPixelWidth(sector)
    const heightPixels = sectorPixelHeight(sector)
    expect(widthPixels).not.toBe(heightPixels)
    expect(planeSizes(scene)).toContainEqual({
      width: narrowed(widthPixels),
      height: narrowed(heightPixels),
    })
    expect(planeSizes(scene)).not.toContainEqual({
      width: unnarrowed(widthPixels),
      height: unnarrowed(heightPixels),
    })
  })

  it('sizes an entity placeholder with a narrowed product on every axis', () => {
    const scene = new WorldScene(emptyAssets(), 1)
    scene.load(sectorFromWire(wireSector()), false)
    scene.placeEntity({ ...playerEntity(1), maskSize: { width: 5, height: 7 } })

    const box = firstBox(scene)
    expect(box).toBeDefined()
    // Depth is half the *width* rather than its own narrowing, which only an asymmetric mask can
    // tell apart from the height — see `entityPlaceholder`.
    expect(box!.parameters.width).toBe(narrowed(5))
    expect(box!.parameters.height).toBe(narrowed(7))
    expect(box!.parameters.depth).toBe(narrowed(5) / 2)
    expect(box!.parameters.width).not.toBe(unnarrowed(5))
    expect(box!.parameters.height).not.toBe(unnarrowed(7))
  })

  it('sizes an object placeholder with a narrowed product on every axis', () => {
    const scene = new WorldScene(emptyAssets(), 1)
    scene.load(
      sectorFromWire(
        wireSector({
          objects: [
            { x: 0, y: 0, modelID: 'barrel', sourceWidth: 5, sourceHeight: 7, priority: 0, rotation: 0 },
          ],
        })
      ),
      false
    )

    const box = firstBox(scene)
    expect(box).toBeDefined()
    // `sourceHeight` is a *ground* extent, so it lands on depth; the box's own height is one
    // ground cell. Asserting all three is what distinguishes the three separate narrowings.
    expect(box!.parameters.width).toBe(narrowed(5))
    expect(box!.parameters.depth).toBe(narrowed(7))
    expect(box!.parameters.width).not.toBe(unnarrowed(5))
    expect(box!.parameters.depth).not.toBe(unnarrowed(7))
    // The box's own height has no `not.toBe` partner and cannot get one: `groundCellSize` is 32, so
    // this multiply only shifts the exponent and the product is exact in binary32 either way.
    // Verified: f32(f32(32) * f32(0.02)) === f32(32) * f32(0.02).
    expect(box!.parameters.height).toBe(narrowed(SOMNIO_CONSTANTS.groundCellSize))
    expect(narrowed(SOMNIO_CONSTANTS.groundCellSize)).toBe(unnarrowed(SOMNIO_CONSTANTS.groundCellSize))
  })

  /** The one overlay quad whose size is measurable without a GPU: its geometry parameters. */
  function overlayQuadSizes(scene: WorldScene): { width: number; height: number }[] {
    const sizes: { width: number; height: number }[] = []
    scene.scene.traverse((object) => {
      const mesh = object as THREE.Mesh
      const material = mesh.material as THREE.MeshBasicMaterial | undefined
      if (
        mesh.isMesh &&
        material?.map?.image instanceof HTMLCanvasElement &&
        mesh.geometry instanceof THREE.PlaneGeometry
      ) {
        sizes.push({
          width: mesh.geometry.parameters.width,
          height: mesh.geometry.parameters.height,
        })
      }
    })
    return sizes
  }

  /**
   * `overlayScale` is `Float` in Swift (`WorldScene3D.overlayScale`) and 0.8 is not representable in
   * binary32, so leaving it a double shifts every overlay quad's size. The plaque is the reachable
   * one: its artwork dimensions come from the rasteriser rather than from a sector the test picks.
   */
  it('scales overlay artwork through a narrowed overlayScale', () => {
    const scene = new WorldScene(emptyAssets(), 1)
    scene.load(sectorFromWire(wireSector()), false)
    scene.placeEntity(playerEntity(1))

    // The same inputs the scene passes for a player plaque, so the artwork dimensions match.
    const art = renderNamePlaque(playerEntity(1).name, NAME_PLAQUE.playerBackground, true)
    const scaled = (pixels: number, scale: number) =>
      f32(f32(f32(pixels) * ORTHO_RIG.worldUnitsPerPixel) * scale)
    expect(overlayQuadSizes(scene)).toContainEqual({
      width: scaled(art.widthPixels, f32(0.8)),
      height: scaled(art.heightPixels, f32(0.8)),
    })
    // The un-narrowed constant lands somewhere else entirely, which is what makes this a contract
    // rather than a restatement.
    expect(scaled(art.widthPixels, f32(0.8))).not.toBe(scaled(art.widthPixels, 0.8))
  })

  /**
   * The three overlay gaps are `Float` in Swift too, and none of 0.2/0.15/0.15 is representable in
   * binary32. They reach the scene as *positions* rather than sizes, so they need their own pins.
   */
  it('offsets the plaque with narrowed gap and clearance constants', () => {
    const scene = new WorldScene(emptyAssets(), 1)
    scene.load(sectorFromWire(wireSector()), false)
    scene.placeEntity(playerEntity(1))

    const size = overlayQuadSizes(scene)[0]
    if (size === undefined) throw new Error('the player plaque produced no overlay quad')
    let plate: THREE.Mesh | undefined
    scene.scene.traverse((object) => {
      const mesh = object as THREE.Mesh
      const material = mesh.material as THREE.MeshBasicMaterial | undefined
      if (mesh.isMesh && material?.map?.image instanceof HTMLCanvasElement) plate = mesh
    })
    expect(plate).toBeDefined()

    const feetGap = f32(0.15)
    const clearance = f32(0.15)
    const pitch = f32(f32(ORTHO_RIG.pitchDegrees * FLOAT_PI) / 180)
    const drop = f32(size.height + feetGap)
    expect(plate!.position.y).toBe(-f32(size.height / 2 + feetGap))
    expect(plate!.position.z).toBe(f32(f32(drop / f32(Math.tan(pitch))) + clearance))
    // The clearance term differs from the double answer, so that assertion is a contract and not a
    // restatement. The feet gap does *not*, at this plaque height, and so has no `not.toBe` partner:
    // the height is a fixed 18 px (`nativeLineBoxHeight(NAME_PLAQUE.fontSize) + 4`, independent of
    // the name), and `f32(h/2 + f32(0.15)) === f32(h/2 + 0.15)` there by innocuous double rounding.
    // It is not universally equivalent — a 14, 21, or 25 px plaque would separate the two.
    expect(f32(f32(drop / f32(Math.tan(pitch))) + clearance)).not.toBe(
      f32(drop / f32(Math.tan(pitch))) + 0.15
    )
    expect(-f32(size.height / 2 + feetGap)).toBe(-f32(size.height / 2 + 0.15))
  })

  /**
   * `bubbleHeadGap` sits between the speaker's head and the balloon tail. Measured off the model
   * holder's bounds, so an empty-bounds placeholder puts the head at a known height.
   */
  it('lifts a speech balloon above the head by a narrowed gap', () => {
    const scene = new WorldScene(emptyAssets(), 1)
    scene.load(sectorFromWire(wireSector()), false)
    scene.placeEntity({ ...playerEntity(1), maskSize: { width: 5, height: 7 } })
    scene.showSpeechBubble(1, ['Hallo'], 3000)

    // The balloon container is the node whose own children carry the canvas material; the plaque
    // hangs directly off the entity node, so the container is the one with a non-zero y.
    const lifted: number[] = []
    scene.scene.traverse((object) => {
      if (object.position.y > 0 && object.children.length > 0) lifted.push(object.position.y)
    })
    const headHeight = narrowed(7)
    expect(lifted).toContain(Math.max(headHeight, 0) + f32(0.2))
    expect(lifted).not.toContain(Math.max(headHeight, 0) + 0.2)
  })

  it('sizes a floor patch quad with a narrowed product on both axes', () => {
    const scene = new WorldScene(emptyAssets(), 1)
    // 5 px is the first width where the narrowed and unnarrowed products differ, and the patch
    // is the one quad whose dimensions come from the authored rect rather than the sector size.
    scene.load(
      sectorFromWire(
        wireSector({
          floorPatches: [{ floorMaterialID: 'cobble-street', x: 0, y: 0, width: 5, height: 7 }],
        })
      ),
      false
    )

    expect(planeSizes(scene)).toContainEqual({ width: narrowed(5), height: narrowed(7) })
    expect(planeSizes(scene)).not.toContainEqual({ width: unnarrowed(5), height: unnarrowed(7) })
  })
})

describe('shadow casting survives every path a model can reach the scene by', () => {
  /**
   * `enableShadows` is called on four paths and only the cold object load was pinned. The heal is
   * the one that matters most: `refreshResolvedModels` exists precisely for the race where an
   * entity or object is placed before its glTF finishes prewarming, and a clone that misses the
   * enrolment renders shadowless — which reads as the prop floating above the floor, the exact
   * asymmetry `attachResolvedObject`'s doc comment warns about for yaw.
   */
  it('enrols a character model resolved on the cold path', () => {
    // `resolvingAssets().entity` answers a bare `Object3D` with no mesh under it, which nothing
    // can cast a shadow from — so this needs a rig that actually carries geometry.
    const assets = resolvingAssets()
    assets.entity = () => new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1))
    const scene = new WorldScene(assets, 1)
    scene.load(sectorFromWire(wireSector()), false)
    scene.placeEntity(playerEntity(1))

    const meshes: THREE.Mesh[] = []
    scene.scene.traverse((object) => {
      const mesh = object as THREE.Mesh
      if (mesh.isMesh) meshes.push(mesh)
    })
    expect(meshes.some((mesh) => mesh.castShadow)).toBe(true)
  })

  it('enrols a placeholder standing in for an unresolved model', () => {
    const scene = new WorldScene(emptyAssets(), 1)
    scene.load(sectorFromWire(wireSector()), false)
    scene.placeEntity(playerEntity(1))

    let placeholderCasts = false
    scene.scene.traverse((object) => {
      const mesh = object as THREE.Mesh
      if (mesh.isMesh && mesh.geometry instanceof THREE.BoxGeometry && mesh.castShadow) {
        placeholderCasts = true
      }
    })
    expect(placeholderCasts).toBe(true)
  })

  it('enrols an object model that resolves through the heal, not only on a cold load', async () => {
    const assets = emptyAssets()
    const scene = new WorldScene(assets, 1)
    scene.load(
      sectorFromWire(
        wireSector({
          objects: [
            { x: 0, y: 0, modelID: 'door', sourceWidth: 32, sourceHeight: 32, priority: 0, rotation: 0 },
          ],
        })
      ),
      false
    )
    expect(scene._placeholderObjectCount()).toBe(1)

    const warm = resolvingAssets()
    assets.object = (id) => warm.object(id)
    assets.entity = (kind, figure) => warm.entity(kind, figure)
    await scene.prewarm()

    // The healed clone replaces the placeholder, so anything still casting is the resolved model.
    const meshes: THREE.Mesh[] = []
    scene.scene.traverse((object) => {
      const mesh = object as THREE.Mesh
      if (mesh.isMesh) meshes.push(mesh)
    })
    expect(meshes.some((mesh) => mesh.castShadow)).toBe(true)
  })
})

describe('entity yaw slews on the model holder only', () => {
  /**
   * The overlays hang off the stable node, so the facing yaw must live on the model holder. A
   * yaw on the node would tilt the name plaque and speech bubble with the character.
   */
  it('leaves the entity node unrotated while the holder turns', () => {
    const scene = new WorldScene(emptyAssets(), 1)
    scene.load(sectorFromWire(wireSector()), false)
    scene.placeEntity(playerEntity())

    scene.updatePosition(1, { x: 100, y: 100 }, 90)
    for (let step = 0; step < 30; step += 1) scene.tick(1 / 60)

    expect(scene._yawFor(1)).toBeGreaterThan(0)
    // The half that carries the contract: reading only the holder passes even if the node turns
    // too, because both would hold the same value and the overlays would tilt unnoticed.
    expect(scene._nodeYawFor(1)).toBe(0)
  })

  it('holds an idle pose when nothing moved', () => {
    const scene = new WorldScene(emptyAssets(), 1)
    scene.load(sectorFromWire(wireSector()), false)
    scene.placeEntity(playerEntity())

    scene.tick(0.5)

    // No model resolved, so no mixer and no pose is selected — but the tick must not throw.
    expect(scene._poseFor(1)).toBeUndefined()
  })
})

describe('tick clamps a stalled frame', () => {
  /**
   * Asserted against the tween's actual progress, not against a node existing: a 10-second frame and
   * a clamped frame must move the entity by exactly the same amount, which is only true while the
   * clamp is in place. Asserting the node exists would pass whether the clamp is present, removed,
   * or inverted.
   */
  it('never advances more than the max delta', () => {
    const stalled = new WorldScene(emptyAssets(), 1)
    stalled.load(sectorFromWire(wireSector()), false)
    stalled.placeEntity(playerEntity())
    stalled.animateEntity(1, { x: 200, y: 200 }, 0, 0.5)
    stalled.tick(10)

    const clamped = new WorldScene(emptyAssets(), 1)
    clamped.load(sectorFromWire(wireSector()), false)
    clamped.placeEntity(playerEntity())
    clamped.animateEntity(1, { x: 200, y: 200 }, 0, 0.5)
    clamped.tick(MAX_TICK_DELTA)

    const stalledPosition = stalled._positionFor(1)
    const clampedPosition = clamped._positionFor(1)
    expect(stalledPosition).toEqual(clampedPosition)

    // And the tween is genuinely mid-flight rather than both having completed, which would make the
    // equality above hold trivially. Compared against the tween's *endpoint in metres*, read off a
    // scene driven to completion: the previous `toBeLessThan(200)` compared a world coordinate of
    // about 4 m against a pixel count, so it held whatever the clamp did.
    const finished = new WorldScene(emptyAssets(), 1)
    finished.load(sectorFromWire(wireSector()), false)
    finished.placeEntity(playerEntity())
    finished.animateEntity(1, { x: 200, y: 200 }, 0, 0.5)
    for (let elapsed = 0; elapsed < 0.5; elapsed += MAX_TICK_DELTA) finished.tick(MAX_TICK_DELTA)

    // The untouched starting point, from a scene that placed the entity and never ticked.
    const unmoved = new WorldScene(emptyAssets(), 1)
    unmoved.load(sectorFromWire(wireSector()), false)
    unmoved.placeEntity(playerEntity())

    const origin = unmoved._positionFor(1)!
    const partway = clamped._positionFor(1)!
    const endpoint = finished._positionFor(1)!
    // One clamped frame of a 0.5 s tween is a fifth of the way: strictly past the start, strictly
    // short of the end. Both bounds are needed — either alone holds if the clamp is removed.
    expect(partway.x).toBeGreaterThan(origin.x)
    expect(partway.x).toBeLessThan(endpoint.x)
  })

  /**
   * Swift narrows the tween fraction once around the whole expression (`Float(1 - remaining /
   * total)`, `WorldScene3D.tick(deltaTime:)`) because `remaining` and `total` are both `TimeInterval`.
   * Leaving it a double puts every in-flight peer a fraction of a pixel off the native client's
   * answer for the same frame — invisible per frame, and exactly the drift `core/float.ts` exists
   * to prevent.
   *
   * One clamped frame into a 0.5 s tween is what makes the difference visible: the fraction is then
   * `1 - 0.4 / 0.5`, which a double evaluates as 0.19999999999999996 and `f32` rounds to exactly
   * 0.2. A single tick, because a second one would lerp from the same fixed `start` and the error
   * would not compound into something easier to see.
   */
  it('narrows the tween fraction the way Swift narrows it', () => {
    const scene = new WorldScene(emptyAssets(), 1)
    scene.load(sectorFromWire(wireSector()), false)
    scene.placeEntity(playerEntity())
    const start = scene._positionFor(1)!
    scene.animateEntity(1, { x: 200, y: 200 }, 0, 0.5)

    // The tween's endpoint, read off a scene driven to completion rather than recomputed here, so
    // the expectation cannot drift from `entityWorldPosition`. Driven in clamped frames — one
    // `tick(0.5)` would itself be clamped to `MAX_TICK_DELTA` and never arrive.
    const finished = new WorldScene(emptyAssets(), 1)
    finished.load(sectorFromWire(wireSector()), false)
    finished.placeEntity(playerEntity())
    finished.animateEntity(1, { x: 200, y: 200 }, 0, 0.5)
    for (let elapsed = 0; elapsed < 0.5; elapsed += MAX_TICK_DELTA) finished.tick(MAX_TICK_DELTA)
    const target = finished._positionFor(1)!
    expect(target.x).not.toBe(start.x)

    scene.tick(MAX_TICK_DELTA)

    const lerpX = (fraction: number) =>
      new THREE.Vector3().lerpVectors(
        new THREE.Vector3(start.x, start.y, start.z),
        new THREE.Vector3(target.x, target.y, target.z),
        fraction
      ).x
    const remaining = 0.5 - MAX_TICK_DELTA
    const asDouble = 1 - remaining / 0.5
    expect(f32(asDouble)).not.toBe(asDouble)
    expect(scene._positionFor(1)!.x).toBe(lerpX(f32(asDouble)))
    expect(scene._positionFor(1)!.x).not.toBe(lerpX(asDouble))
  })
})

describe('the sun travels with the camera focus', () => {
  /** Direction the light actually shines from, which is what shading reads. */
  function sunDirection(scene: WorldScene): THREE.Vector3 {
    const sun = scene.scene.getObjectByProperty('isDirectionalLight', true) as THREE.DirectionalLight
    return sun.position.clone().sub(sun.target.position).normalize()
  }

  /**
   * three.js derives a directional light's direction from `position - target.position`. Anchoring
   * the light at the world origin while the target follows the player swings that direction
   * further off the authored one the further the player walks from the sector's corner — the sun
   * would visibly rotate as you cross a map.
   */
  it('holds the authored direction as the focus moves across the sector', () => {
    const scene = new WorldScene(emptyAssets(), 1)
    scene.load(sectorFromWire(wireSector()), false)

    scene.placeEntity({ ...playerEntity(1), position: { x: 0, y: 0 } })
    const nearOrigin = sunDirection(scene)

    scene.placeEntity({ ...playerEntity(1), position: { x: 4000, y: 4000 } })
    const farAway = sunDirection(scene)

    expect(farAway.angleTo(nearOrigin)).toBeLessThan(1e-6)
  })

  /**
   * The anti-swim guard, and the axes it is measured on are the whole point.
   *
   * The shadow map's grid lives in the light's view plane, so quantizing world XYZ is not the same
   * thing: 0.5 world units is 21.33 texels at this scale, and projecting into the light plane scales
   * it again by the direction cosines, leaving a fractional-texel phase on every step. The map then
   * re-samples the same silhouette against a different phase each frame and the edge pixels flip —
   * only while the focus moves, since a still anchor holds one phase.
   *
   * Walked across many steps rather than sampled once: a single position lands on a texel boundary
   * for plenty of wrong bases by luck.
   */
  it('quantizes the shadow anchor to whole texels of the light plane as the focus moves', () => {
    const scene = new WorldScene(emptyAssets(), 1)
    scene.load(sectorFromWire(wireSector()), false)
    const sun = scene.scene.getObjectByProperty('isDirectionalLight', true) as THREE.DirectionalLight
    const texel = (2 * SUN_SHADOW.orthographicScale) / SUN_SHADOW.mapSize

    const phases: number[] = []
    for (let step = 0; step < 40; step += 1) {
      scene.placeEntity({ ...playerEntity(1), position: { x: 500 + step * 7, y: 500 + step * 3 } })
      // Derived from the light's own placement, not from the scene's internals, so a wrong basis in
      // `repositionSun` cannot cancel itself out here.
      const direction = sun.position.clone().sub(sun.target.position).normalize()
      const intoLight = new THREE.Quaternion()
        .setFromRotationMatrix(new THREE.Matrix4().lookAt(direction, new THREE.Vector3(), sun.up))
        .invert()
      const local = sun.target.position.clone().applyQuaternion(intoLight)
      phases.push(local.x / texel, local.y / texel)
    }

    for (const multiple of phases) {
      expect(Math.abs(multiple - Math.round(multiple))).toBeLessThan(1e-4)
    }
  })

  /**
   * The quantization test above cannot see a *wrong* anchor, and neither can the direction test:
   * `sun.position - sun.target.position` cancels the anchor exactly, and an anchor parked at the
   * origin has zero texel phase on every sample. Both stay green with the anchor pinned to (0,0,0),
   * which is the shape that matters — the shadow volume stops following the player, so every prop
   * more than half a shadow map from the sector origin loses its shadow entirely.
   *
   * So this observes the endpoint itself: it must move with the focus, and land within one texel
   * of it rather than anywhere at all.
   */
  it('anchors the shadow volume on the focus, within a texel, as the focus moves', () => {
    const scene = new WorldScene(emptyAssets(), 1)
    scene.load(sectorFromWire(wireSector()), false)
    const sun = scene.scene.getObjectByProperty('isDirectionalLight', true) as THREE.DirectionalLight
    const texel = (2 * SUN_SHADOW.orthographicScale) / SUN_SHADOW.mapSize

    scene.placeEntity({ ...playerEntity(1), position: { x: 300, y: 300 } })
    const near = sun.target.position.clone()

    scene.placeEntity({ ...playerEntity(1), position: { x: 3000, y: 3000 } })
    const far = sun.target.position.clone()

    // 2700 px on each axis at `worldUnitsPerPixel`, so the anchor must travel the same distance the
    // player did — quantized to whole texels, hence the tolerance. An anchor pinned to the origin
    // travels 0 and fails the first assertion; one that tracks something other than the focus
    // fails the second.
    const expected = Math.hypot(2700 * ORTHO_RIG.worldUnitsPerPixel, 2700 * ORTHO_RIG.worldUnitsPerPixel)
    expect(near.distanceTo(far)).toBeGreaterThan(1)
    expect(Math.abs(near.distanceTo(far) - expected)).toBeLessThanOrEqual(2 * texel)
  })

  it('casts shadows from the sun onto the floor', () => {
    const scene = new WorldScene(emptyAssets(), 1)
    const object = {
      x: 0,
      y: 0,
      modelID: 'barrel',
      sourceWidth: 32,
      sourceHeight: 32,
      priority: 1,
      rotation: 0,
    }
    scene.load(sectorFromWire(wireSector({ objects: [object] })), false)
    const sun = scene.scene.getObjectByProperty('isDirectionalLight', true) as THREE.DirectionalLight
    expect(sun.castShadow).toBe(true)

    const meshes: THREE.Mesh[] = []
    scene.scene.traverse((object) => {
      if ((object as THREE.Mesh).isMesh) meshes.push(object as THREE.Mesh)
    })
    // Per mesh, not `some(...)`: the prop both casts and receives, so a bare "something receives"
    // held even with the floor's flag removed — and the floor is the only surface a shadow lands on.
    const floor = meshes.find(
      (mesh) =>
        mesh.geometry instanceof THREE.PlaneGeometry &&
        mesh.geometry.parameters.width ===
          f32(f32(sectorPixelWidth(sectorFromWire(wireSector()))) * ORTHO_RIG.worldUnitsPerPixel)
    )
    expect(floor).toBeDefined()
    expect(floor!.receiveShadow).toBe(true)
    // A ground plane casting into its own depth comparison is the classic source of shadow acne,
    // and there is nothing below it to catch a shadow anyway.
    expect(floor!.castShadow).toBe(false)

    const placeholder = meshes.find((mesh) => mesh.geometry instanceof THREE.BoxGeometry)
    expect(placeholder).toBeDefined()
    expect(placeholder!.castShadow).toBe(true)
  })
})

describe('overlay artwork', () => {
  /**
   * `SpeechBubbleArt.frameSize`: the body grows a line at a time and the tail plus the two body
   * paddings are fixed, so the frame is `lines * 12 + 20`. The wrap step measures against the same
   * width, and a mismatch here overflows the balloon rather than failing anything.
   */
  it.each([
    [1, 32],
    [2, 44],
    [4, 68],
  ])('frames %i bubble line(s) at %ipx tall', (lines, height) => {
    expect(speechBubbleFrameSize(lines)).toEqual({ width: 150, height })
  })

  /** `max(lineCount, 1)`: an empty balloon still has a body rather than collapsing onto its tail. */
  it('never frames a bubble shorter than one line', () => {
    expect(speechBubbleFrameSize(0)).toEqual(speechBubbleFrameSize(1))
  })

  it.each([
    ['player', NAME_PLAQUE.playerBackground],
    ['peer', NAME_PLAQUE.playerBackground],
    ['npc', NAME_PLAQUE.npcBackground],
  ] as const)('gives a %s a plaque', (kind, background) => {
    expect(namePlaqueBackground(kind)).toBe(background)
  })

  it('gives a monster no plaque', () => {
    expect(namePlaqueBackground('monster')).toBeUndefined()
  })

  /**
   * Both baselines follow the **line box** `NSAttributedString.draw(at:)` positions against, whose
   * two numbers are recorded in `NATIVE_LINE_BOX` from an ink-row measurement of the Swift pipeline.
   */
  it('places a bubble line one baseline offset below its box top', () => {
    expect(baselineBelowBoxTop(5, 10)).toBe(15)
    // A second line advances by `lineHeight`, and the baseline follows rigidly, so consecutive
    // baselines are exactly `lineHeight` apart as they are natively.
    expect(baselineBelowBoxTop(5 + 12, 10)).toBe(27)
  })

  it('sizes the line box a pixel deeper than canvas metrics report', () => {
    // AppKit measures 13 at System-10 and 14 at System-11; `fontBoundingBoxDescent` reports 2 rather
    // than 3, so reading it leaves the plaque box a pixel short and the text riding half a pixel up.
    expect(nativeLineBoxHeight(10)).toBe(13)
    expect(nativeLineBoxHeight(11)).toBe(14)
  })

  it('centres a plaque line box rather than its em box', () => {
    // `ceil(14 + 4)` is an 18-tall box around a 14-tall line box: 2 above, baseline at 2 + 11.
    expect(baselineInCenteredBox(18, 11)).toBe(13)
    // `textBaseline: 'middle'` at `height / 2` would put it at 9 — low by the half-difference
    // between the two boxes, which is the shift that made the plaque text look off.
    expect(baselineInCenteredBox(18, 11)).not.toBe(18 / 2)
  })
})

describe('name plaques hang off the entity node', () => {
  /** Counts plaque quads: screen-aligned planes textured from a canvas. */
  function plaqueCount(scene: WorldScene): number {
    let count = 0
    scene.scene.traverse((object) => {
      const mesh = object as THREE.Mesh
      const material = mesh.material as THREE.MeshBasicMaterial | undefined
      if (mesh.isMesh && material?.map?.image instanceof HTMLCanvasElement) count += 1
    })
    return count
  }

  it('gives players and NPCs a plaque and monsters none', () => {
    const scene = new WorldScene(emptyAssets(), 1)
    scene.load(sectorFromWire(wireSector()), false)

    scene.placeEntity(playerEntity(1))
    expect(plaqueCount(scene)).toBe(1)

    scene.placeEntity({ ...playerEntity(2), kind: 'npc', name: 'Libus' })
    expect(plaqueCount(scene)).toBe(2)

    scene.placeEntity({ ...playerEntity(3), kind: 'monster', name: 'Ghost' })
    expect(plaqueCount(scene)).toBe(2)
  })

  /** Re-placing the same entity every frame must not stack a new plaque on each pass. */
  it('does not accumulate plaques across repeated placements', () => {
    const scene = new WorldScene(emptyAssets(), 1)
    scene.load(sectorFromWire(wireSector()), false)
    for (let index = 0; index < 5; index += 1) scene.placeEntity(playerEntity(1))
    expect(plaqueCount(scene)).toBe(1)
  })

  /** The plaque's own canvas, so a rebuild is observable rather than merely counted. */
  function plaqueCanvas(scene: WorldScene): HTMLCanvasElement | undefined {
    let canvas: HTMLCanvasElement | undefined
    scene.scene.traverse((object) => {
      const mesh = object as THREE.Mesh
      const material = mesh.material as THREE.MeshBasicMaterial | undefined
      if (mesh.isMesh && material?.map?.image instanceof HTMLCanvasElement) canvas = material.map.image
    })
    return canvas
  }

  /**
   * Counting proves no plaque was *added*; it cannot see that the old one was kept. Dropping the
   * name term from the rebuild condition leaves the stale text on screen with the count unchanged
   * — reachable whenever an index is reused by a different player after a `leave`.
   */
  it('rebuilds the plaque when the name changes', () => {
    const scene = new WorldScene(emptyAssets(), 1)
    scene.load(sectorFromWire(wireSector()), false)
    scene.placeEntity(playerEntity(1))
    const before = plaqueCanvas(scene)

    scene.placeEntity({ ...playerEntity(1), name: 'Renamed' })

    expect(plaqueCount(scene)).toBe(1)
    expect(plaqueCanvas(scene)).not.toBe(before)
  })

  /**
   * The kind drives the plaque's fill and its bold flag, so a peer promoted to `player` keeps the
   * wrong styling if `kindChanged` is dropped — and the name is unchanged, so the name term cannot
   * cover for it. This is why the source captures the kind *before* the assignment that overwrites
   * it; nothing observed that ordering.
   */
  it('rebuilds the plaque when only the kind changes', () => {
    const scene = new WorldScene(emptyAssets(), 1)
    scene.load(sectorFromWire(wireSector()), false)
    scene.placeEntity({ ...playerEntity(1), kind: 'peer', name: 'Same' })
    const before = plaqueCanvas(scene)

    scene.placeEntity({ ...playerEntity(1), kind: 'player', name: 'Same' })

    expect(plaqueCount(scene)).toBe(1)
    expect(plaqueCanvas(scene)).not.toBe(before)
  })

  /**
   * A rebuilt plaque owns a `PlaneGeometry` and a `CanvasTexture`-backed material that no later
   * sector cleanup can reach once it is detached, so a bare `removeFromParent()` leaks both on
   * every rename or kind change.
   */
  it('disposes the plaque it replaces rather than only detaching it', () => {
    const scene = new WorldScene(emptyAssets(), 1)
    scene.load(sectorFromWire(wireSector()), false)
    scene.placeEntity(playerEntity(1))

    const disposed: string[] = []
    scene.scene.traverse((object) => {
      const mesh = object as THREE.Mesh
      const material = mesh.material as THREE.MeshBasicMaterial | undefined
      if (!mesh.isMesh || !(material?.map?.image instanceof HTMLCanvasElement)) return
      vi.spyOn(mesh.geometry, 'dispose').mockImplementation(() => disposed.push('geometry'))
      vi.spyOn(material, 'dispose').mockImplementation(() => disposed.push('material'))
    })

    scene.placeEntity({ ...playerEntity(1), name: 'Renamed' })

    expect(disposed).toContain('geometry')
    expect(disposed).toContain('material')
  })
})

/**
 * GPU-resource lifetime. `removeFromParent()` leaves geometry, materials, and textures in
 * `WebGLRenderer`'s internal maps, so a long session of sector hops and peer churn would accumulate
 * VRAM until the context is lost. Nothing about that is visible in a graph assertion, which is why
 * these spy on `dispose` directly — and why they assert both directions: freeing what this file
 * allocated, and *not* freeing what the asset cache lent it.
 */
describe('GPU resource disposal', () => {
  /** A skinned model with its own skeleton, matching what `SkeletonUtils.clone` hands back. */
  function skinnedModel(): { root: THREE.Object3D; skeleton: THREE.Skeleton } {
    const bone = new THREE.Bone()
    const skeleton = new THREE.Skeleton([bone])
    const mesh = new THREE.SkinnedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial())
    mesh.add(bone)
    mesh.bind(skeleton)
    const root = new THREE.Object3D()
    root.add(mesh)
    return { root, skeleton }
  }

  function patchedSector(): WireSector {
    return wireSector({
      floorPatches: [{ floorMaterialID: 'cobble-street', x: 0, y: 0, width: 32, height: 32 }],
    })
  }

  it('disposes the floor and its patches on a sector swap, sparing the cached texture', () => {
    const cached = new THREE.Texture()
    cached.image = { width: 64, height: 64 }
    const assets = { ...emptyAssets(), floorTexture: () => cached }
    const cachedDispose = vi.spyOn(cached, 'dispose')
    const scene = new WorldScene(assets, 1)
    scene.load(sectorFromWire(patchedSector()), false)

    // The floor and the one patch quad, identified by carrying a map: the splash plane the scene
    // keeps across sector swaps is untextured, and must not be caught up in this.
    const textured: THREE.Mesh[] = []
    scene.scene.traverse((object) => {
      const mesh = object as THREE.Mesh
      if (!mesh.isMesh || !(mesh.geometry instanceof THREE.PlaneGeometry)) return
      const map = (mesh.material as THREE.MeshStandardMaterial).map
      if (map !== null && map !== undefined) textured.push(mesh)
    })
    expect(textured).toHaveLength(2)
    const geometryDisposes = textured.map((mesh) => vi.spyOn(mesh.geometry, 'dispose'))
    const mapDisposes = textured.map((mesh) =>
      vi.spyOn((mesh.material as THREE.MeshStandardMaterial).map!, 'dispose')
    )

    scene.load(sectorFromWire(wireSector({ name: 'Nordwiese' })), false)

    for (const spy of geometryDisposes) expect(spy).toHaveBeenCalled()
    // The floor and each patch clone the cache entry, so their maps are theirs to free...
    for (const spy of mapDisposes) expect(spy).toHaveBeenCalled()
    // ...while the entry itself must survive for the next sector that paints this material.
    expect(cachedDispose).not.toHaveBeenCalled()
  })

  it('leaves a cached model geometry and material alone when its holder is dropped', () => {
    const geometry = new THREE.BoxGeometry(1, 1, 1)
    const material = new THREE.MeshBasicMaterial()
    const assets = { ...emptyAssets(), object: () => new THREE.Mesh(geometry, material) }
    const geometryDispose = vi.spyOn(geometry, 'dispose')
    const materialDispose = vi.spyOn(material, 'dispose')
    const scene = new WorldScene(assets, 1)
    scene.load(
      sectorFromWire(
        wireSector({
          objects: [
            { x: 0, y: 0, modelID: 'barrel', sourceWidth: 32, sourceHeight: 32, priority: 0, rotation: 0 },
          ],
        })
      ),
      false
    )
    expect(scene._placeholderObjectCount()).toBe(0)

    scene.load(sectorFromWire(wireSector({ name: 'Nordwiese' })), false)

    // `SkeletonUtils.clone` shares both with the prototype, so disposing either would blank every
    // other instance built from the same cache entry.
    expect(geometryDispose).not.toHaveBeenCalled()
    expect(materialDispose).not.toHaveBeenCalled()
  })

  /**
   * The one GPU resource a model clone *does* own. `SkeletonUtils.clone` gives each clone its own
   * `Skeleton`, and `WebGLRenderer` allocates a per-`Skeleton` bone texture that nothing in three.js
   * reclaims — there is no `FinalizationRegistry`, so GC of the wrapper leaks the GL texture.
   */
  it('disposes a cloned skeleton when its entity leaves the sector', () => {
    const { root, skeleton } = skinnedModel()
    const assets = { ...emptyAssets(), entity: () => root }
    const skeletonDispose = vi.spyOn(skeleton, 'dispose')
    const scene = new WorldScene(assets, 1)
    scene.load(sectorFromWire(wireSector()), false)
    scene.placeEntity(playerEntity(1))

    scene.removeEntity(1)

    expect(skeletonDispose).toHaveBeenCalled()
  })

  it('disposes a cloned skeleton when the whole sector is swapped', () => {
    const { root, skeleton } = skinnedModel()
    const assets = { ...emptyAssets(), entity: () => root }
    const skeletonDispose = vi.spyOn(skeleton, 'dispose')
    const scene = new WorldScene(assets, 1)
    scene.load(sectorFromWire(wireSector()), false)
    scene.placeEntity(playerEntity(1))

    scene.load(sectorFromWire(wireSector({ name: 'Nordwiese' })), false)

    expect(skeletonDispose).toHaveBeenCalled()
  })
})

describe('speech bubbles are freed as they are replaced and expire', () => {
  /** Every mesh under an entity's live bubble node, which is where its own texture hangs. */
  function bubbleMeshes(scene: WorldScene, entityID = 1): THREE.Mesh[] {
    const node = scene._bubbleNodeFor(entityID)
    if (node === undefined) return []
    const found: THREE.Mesh[] = []
    node.traverse((object) => {
      const mesh = object as THREE.Mesh
      if (mesh.isMesh) found.push(mesh)
    })
    return found
  }

  function sceneWithEntity(): WorldScene {
    const scene = new WorldScene(emptyAssets(), 1)
    scene.load(sectorFromWire(wireSector()), false)
    scene.placeEntity(playerEntity(1))
    return scene
  }

  /**
   * The highest-frequency allocator in the file: one supersampled `CanvasTexture` per chat line,
   * against one per sector hop for the floor. Nothing else reclaims them inside a sector, so a
   * bubble replaced without disposal leaks unboundedly for as long as anyone is talking.
   */
  it('disposes the previous bubble when an entity speaks again', () => {
    const scene = sceneWithEntity()
    scene.showSpeechBubble(1, ['first'], 5000)
    const first = bubbleMeshes(scene)
    expect(first).toHaveLength(1)
    const geometryDispose = vi.spyOn(first[0]!.geometry, 'dispose')
    const material = first[0]!.material as THREE.MeshBasicMaterial
    const mapDispose = vi.spyOn(material.map!, 'dispose')
    const materialDispose = vi.spyOn(material, 'dispose')

    scene.showSpeechBubble(1, ['second'], 5000)

    expect(geometryDispose).toHaveBeenCalled()
    expect(mapDispose).toHaveBeenCalled()
    expect(materialDispose).toHaveBeenCalled()
    // Replaced, not accumulated: one bubble per entity at a time.
    expect(bubbleMeshes(scene)).toHaveLength(1)
  })

  it('disposes a bubble when its lifetime runs out', () => {
    const scene = sceneWithEntity()
    scene.showSpeechBubble(1, ['fleeting'], 1000)
    const mesh = bubbleMeshes(scene)[0]!
    const mapDispose = vi.spyOn((mesh.material as THREE.MeshBasicMaterial).map!, 'dispose')

    // Driven in whole frames rather than one long one: `tick` clamps each delta to `MAX_TICK_DELTA`,
    // so a single 1.5 s call advances the countdown by 0.1 s and the bubble would still be up.
    for (let elapsed = 0; elapsed <= 1; elapsed += MAX_TICK_DELTA) scene.tick(MAX_TICK_DELTA)

    expect(bubbleMeshes(scene)).toHaveLength(0)
    expect(mapDispose).toHaveBeenCalled()
  })

  it('disposes an outstanding bubble when its entity leaves', () => {
    const scene = sceneWithEntity()
    scene.showSpeechBubble(1, ['mid-sentence'], 5000)
    const mesh = bubbleMeshes(scene)[0]!
    const mapDispose = vi.spyOn((mesh.material as THREE.MeshBasicMaterial).map!, 'dispose')

    scene.removeEntity(1)

    expect(bubbleMeshes(scene)).toHaveLength(0)
    expect(mapDispose).toHaveBeenCalled()
  })
})

describe('per-entity resources are freed when they are swapped out', () => {
  /**
   * The entity arm of the self-heal pass. `refreshResolvedModels` reaches placeholders through
   * `resolveEntityModel`, which the post-prewarm object test never exercises because it places no
   * entity — so a detach-without-dispose there leaks one placeholder `BoxGeometry` per entity, per
   * heal, out of reach of any later sector cleanup.
   */
  it('disposes the placeholder geometry when a model resolves after prewarm', async () => {
    let resolved = false
    const assets: ModelAssets = {
      ...emptyAssets(),
      entity: () => (resolved ? new THREE.Object3D() : undefined),
      prewarm: () => {
        resolved = true
        return Promise.resolve()
      },
    }
    const scene = new WorldScene(assets, 1)
    scene.load(sectorFromWire(wireSector()), false)
    scene.placeEntity(playerEntity(1))

    const placeholders: THREE.Mesh[] = []
    scene.scene.traverse((object) => {
      const mesh = object as THREE.Mesh
      if (mesh.isMesh && mesh.geometry instanceof THREE.BoxGeometry) placeholders.push(mesh)
    })
    expect(placeholders).toHaveLength(1)
    const geometryDispose = vi.spyOn(placeholders[0]!.geometry, 'dispose')

    await scene.prewarm()

    expect(geometryDispose).toHaveBeenCalled()
  })
})
