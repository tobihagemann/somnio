import type { ObjectModelRule, Rect, Size } from '@somnio/core';
import type { Placement } from '@somnio/protocol';

/**
 * Placement math kept apart from the scene so the scaling, elevation, and UV rules are testable
 * without a renderer.
 */

/** Physical repeat size of a floor texture, shared by the base floor and every patch. */
const FLOOR_MATERIAL_TILE_METERS = 1.6;

/** Lift keeping patch quads off the base plane. Far above depth-buffer resolution, invisible. */
export const FLOOR_PATCH_LIFT = 0.002;

/**
 * Uniform scale of every character model, and so a character's height in metres: the asset
 * pipeline stages each one 1 m tall.
 *
 * A constant, never measured from the loaded model. Skinned-mesh bounds include animation
 * envelopes and merge accessory meshes unpredictably, so measuring at runtime mis-sizes
 * characters model by model.
 */
export const CHARACTER_SCALE = 0.74;

/** How tall a placeholder box stands in for a model that is not drawn. */
export const PLACEHOLDER_HEIGHT = 0.64;

/** The ground a placement's placeholder covers: the registry footprint, or a small box for a model the registry does not know. */
export function placeholderFootprint(rule: ObjectModelRule | undefined): Size {
  return rule?.footprint ?? { width: PLACEHOLDER_HEIGHT, depth: PLACEHOLDER_HEIGHT };
}

/**
 * How high a placement is drawn. A model with walk surfaces stands on the ground whatever its
 * record says: bodies walk on those surfaces, and collision never lifts them.
 */
export function placementElevation(placement: Placement, rule: ObjectModelRule | undefined): number {
  return rule !== undefined && rule.walkSurfaces.length > 0 ? 0 : placement.elevation;
}

/** How quickly a rendered height closes on the ground under it. */
const HEIGHT_EASE_SECONDS = 0.08;

/** A rendered height this close to the ground is on it. */
const HEIGHT_SNAP = 0.001;

/**
 * One frame of a rendered height easing toward the ground height, which steps a tread at a time.
 */
export function easedHeight(current: number, ground: number, deltaTimeSeconds: number): number {
  const eased = current + (ground - current) * (1 - Math.exp(-deltaTimeSeconds / HEIGHT_EASE_SECONDS));
  return Math.abs(ground - eased) < HEIGHT_SNAP ? ground : eased;
}

/**
 * A floor quad's UV rect in **space coordinates** rather than 0..1 per quad.
 *
 * This is the continuity contract: one quad's `origin + span` equals its neighbour's `origin`,
 * so abutting same-material rects continue one seamless texture grid, across a sector border as
 * much as inside a sector. A per-quad 0..1 mapping would reset the texture phase at every seam,
 * and a cobbled street would visibly tile-break at each rect boundary.
 */
export function floorUVRect(rect: Rect, textureAspect: number): { origin: { x: number; y: number }; span: { x: number; y: number } } {
  const vDivisor = FLOOR_MATERIAL_TILE_METERS * textureAspect;
  return {
    origin: { x: rect.x / FLOOR_MATERIAL_TILE_METERS, y: rect.z / vDivisor },
    span: { x: rect.width / FLOOR_MATERIAL_TILE_METERS, y: rect.depth / vDivisor },
  };
}

/** Height-over-width ratio driving the floor UV scale; 1 while a texture is not yet cached. */
export function textureAspect(size: { width: number; height: number } | undefined): number {
  return size === undefined ? 1 : size.height / size.width;
}
