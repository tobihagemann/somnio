import { SOMNIO_CONSTANTS } from '@/core/constants'
import { FLOAT_PI, f32 } from '@/core/float'
import { feetCenter } from '@/core/feetMask'
import type { GridSize } from '@/core/geometry'
import type { CollisionMask, FloorPatch, SectorObject } from '@/core/sector'
import type { SubpixelPoint } from '@/core/worldEntity'
import { ORTHO_RIG, worldPosition } from './cameraRig'
import type { Vec3 } from './cameraRig'

/**
 * Placement math extracted from `WorldScene3D` so the anchoring, scaling, and UV rules are
 * testable without a renderer. These are the rules that decide whether a prop sits flush with
 * its collision mask or floats a half-decal north of it.
 */

/** Physical repeat size of a floor texture, shared by the base floor and every patch. */
export const FLOOR_MATERIAL_TILE_METERS = 1.6

/** Lift keeping patch quads off the base plane. Far above depth-buffer resolution, invisible. */
export const FLOOR_PATCH_LIFT = 0.002

/**
 * Vertical fraction of the legacy cell a figure fills: the reference charsets stand ~37 px tall
 * in a 48 px cell.
 */
const CHARACTER_CELL_FILL = f32(37.0 / 48.0)

/**
 * Bind-pose height every character model is staged at by the asset pipeline.
 *
 * Module-private: nothing outside `characterScale` reads it, and leaving it exported suppresses
 * `tsc`'s unused-symbol reporting for it — the browser half has no Periphery equivalent to notice.
 */
const CANONICAL_FIGURE_HEIGHT = 1.0

/**
 * Uniform scale normalising a character to its legacy figure height.
 *
 * Derived from the mask, never measured from the loaded model. Skinned-mesh bounds include
 * animation envelopes and merge accessory meshes unpredictably, so measuring at runtime
 * mis-sizes characters model by model — the collision footprint is the authority, and the
 * visible body has to match it or an unscaled source-kit character reads as clipping through
 * furniture its mask legitimately walks past.
 */
export function characterScale(maskSize: GridSize): number {
  return f32(
    f32(f32(f32(maskSize.height) * ORTHO_RIG.worldUnitsPerPixel) * CHARACTER_CELL_FILL) /
      CANONICAL_FIGURE_HEIGHT
  )
}

/**
 * The legacy pixel row a prop's physical base stands on.
 *
 * Defaults to the decal rect's bottom edge, but a collision mask overlapping the decal and
 * ending within one ground cell above that edge wins: the mask is the authored physical
 * footprint, and art below it is deliberate front-face overhang the player was allowed to stand
 * on. Painter's order made that overlap read fine in 2D; in 3D the player walks inside the mesh.
 *
 * Masks ending *below* the rect never pull a prop south (a table's mask under a chair behind it),
 * and masks further than a cell above the edge are unrelated geometry.
 */
export function objectAnchorBottomY(object: SectorObject, masks: readonly CollisionMask[]): number {
  const rectBottom = object.y + object.sourceHeight
  const window = rectBottom - SOMNIO_CONSTANTS.groundCellSize
  let anchor: number | undefined
  for (const mask of masks) {
    const maskBottom = mask.y + mask.height
    const overlapsDecal =
      maskBottom >= window &&
      maskBottom <= rectBottom &&
      mask.x < object.x + object.sourceWidth &&
      mask.x + mask.width > object.x &&
      mask.y < rectBottom &&
      maskBottom > object.y
    if (overlapsDecal && (anchor === undefined || maskBottom > anchor)) {
      anchor = maskBottom
    }
  }
  return anchor ?? rectBottom
}

/**
 * Object node placement: footprint-centre X at the anchor row, then pushed back by half the
 * footprint depth so the model's **south edge** lands on the anchor. Centring on the whole rect
 * instead would put props half a decal north of where the sprite stood.
 */
export function objectNodePosition(
  object: SectorObject,
  anchorBottomY: number,
  footprintDepth: number
): Vec3 {
  const position = worldPosition(object.x + object.sourceWidth / 2, anchorBottomY)
  return { x: position.x, y: position.y, z: position.z - footprintDepth / 2 }
}

/**
 * The authored yaw as a rotation about +Y, in radians.
 *
 * Narrowed per step because `WorldScene3D.swift`'s `simd_quatf(angle: Float(object.rotation) * .pi
 * / 180, ...)` is `Float` throughout, and `FLOAT_PI` rather than `Math.PI` because Swift rounds
 * `Float.pi` toward zero while `Math.fround(Math.PI)` rounds up — `core/float.ts` records that the
 * two land on adjacent `Float` values, so the plain expression puts a one-ulp error into every
 * rotated prop's orientation.
 */
export function objectYawRadians(object: SectorObject): number {
  return f32(f32(object.rotation * FLOAT_PI) / 180)
}

/**
 * Entities stand at their **feet-box centre** — the same ground point the proximity gates use —
 * with the legacy sprite-top-left position converted through it.
 */
export function entityWorldPosition(position: SubpixelPoint, maskSize: GridSize): Vec3 {
  const offset = feetCenter({ x: 0, y: 0 }, maskSize)
  return worldPosition(offset.x + position.x, offset.y + position.y)
}

/**
 * A patch quad's UV rect in **sector space** rather than 0..1 per quad.
 *
 * This is the continuity contract: one patch's `origin + span` equals its neighbour's `origin`,
 * so abutting same-material rects continue one seamless texture grid. A per-quad 0..1 mapping
 * would reset the texture phase at every seam, and a cobbled street would visibly tile-break at
 * each rect boundary.
 */
export function floorPatchUVRect(
  patch: FloorPatch,
  textureAspect: number
): { origin: { x: number; y: number }; span: { x: number; y: number } } {
  const unit = ORTHO_RIG.worldUnitsPerPixel
  const vDivisor = f32(FLOOR_MATERIAL_TILE_METERS * textureAspect)
  return {
    origin: {
      x: f32(f32(f32(patch.x) * unit) / FLOOR_MATERIAL_TILE_METERS),
      y: f32(f32(f32(patch.y) * unit) / vDivisor),
    },
    span: {
      x: f32(f32(f32(patch.width) * unit) / FLOOR_MATERIAL_TILE_METERS),
      y: f32(f32(f32(patch.height) * unit) / vDivisor),
    },
  }
}

/** Height-over-width ratio driving the floor UV scale; 1 while a texture is not yet cached. */
export function textureAspect(size: { width: number; height: number } | undefined): number {
  return size === undefined ? 1 : f32(size.height / size.width)
}
