import { clampToInt16, maxX, maxY, rectCenter } from './geometry'
import type { GridPoint, GridSize, PixelRect } from './geometry'
import { intersects, overlaps } from './collisionMaskOverlap'
import type { Sector } from './sector'
import { sectorPixelHeight, sectorPixelWidth } from './sector'

/**
 * Mirror of `Sources/SomnioCore/Placement/FeetMask.swift`. Collision uses a bottom-aligned,
 * full-width sub-rect of the sprite rather than the whole cell, so a character's head can
 * overlap a wall while the feet do not. The client predictor and the server's per-sector actor
 * derive the identical box — a divergence here shows up as the server rejecting moves the
 * client already drew.
 */

/** Bottom-aligned feet-box height: `spriteHeight / 4 + 4`, with Swift's integer division. */
export function feetHeight(spriteSize: GridSize): number {
  return Math.trunc(spriteSize.height / 4) + 4
}

export function feetRect(position: GridPoint, spriteSize: GridSize): PixelRect {
  const height = feetHeight(spriteSize)
  return {
    x: position.x,
    y: position.y + spriteSize.height - height,
    width: spriteSize.width,
    height,
  }
}

/**
 * Feet-box centre for the proximity gates (NPC dialog radius, monster aggro, bump/portal
 * triggers) — the feet, not the sprite's top-left.
 */
export function feetCenter(position: GridPoint, spriteSize: GridSize): { x: number; y: number } {
  return rectCenter(feetRect(position, spriteSize))
}

/**
 * `true` when the feet box at `position` lies within sector bounds and overlaps neither a
 * static collision mask nor any blocker's feet box. This is the single gate both the predictor
 * and the server call.
 */
export function isFeetClear(
  position: GridPoint,
  spriteSize: GridSize,
  sector: Sector,
  blockers: readonly PixelRect[]
): boolean {
  const feet = feetRect(position, spriteSize)
  if (feet.x < 0 || feet.y < 0) return false
  if (maxX(feet) > sectorPixelWidth(sector) || maxY(feet) > sectorPixelHeight(sector)) return false
  if (intersects(feet, sector.collisionMasks)) return false
  for (const blocker of blockers) {
    if (overlaps(feet, blocker)) return false
  }
  return true
}

/**
 * Clamps `position` so the feet box stays within sector bounds. The predictor clamps its step
 * target with this so a move toward an edge lands flush against it instead of stopping up to
 * one tick short. The inner `max` keeps a sector narrower than the sprite from inverting the
 * clamp range.
 */
export function clampToSector(position: GridPoint, spriteSize: GridSize, sector: Sector): GridPoint {
  const height = feetHeight(spriteSize)
  const limitX = sectorPixelWidth(sector) - spriteSize.width
  const minY = height - spriteSize.height
  const limitY = sectorPixelHeight(sector) - spriteSize.height
  return {
    x: clampToInt16(Math.min(Math.max(position.x, 0), Math.max(0, limitX))),
    y: clampToInt16(Math.min(Math.max(position.y, minY), Math.max(minY, limitY))),
  }
}
