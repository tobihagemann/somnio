import type { ObjectModelRule, Size } from '@somnio/core';
import type { Placement } from '@somnio/protocol';

/**
 * Placement math kept apart from the scene so the scaling and elevation rules are testable
 * without a renderer.
 */

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
