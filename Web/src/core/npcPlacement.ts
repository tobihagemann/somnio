import type { GridPoint } from './geometry'
import type { SectorNPC } from './sector'

/**
 * Mirror of `Sources/SomnioCore/Placement/NPCPlacement.swift`. The centring is held **outside**
 * the sector reader so the reader carries the authored `spawnOrigin` verbatim and round-trip
 * fidelity survives; only the runtime materialises the centred position.
 */
export function npcRuntimePosition(npc: SectorNPC): GridPoint {
  return {
    x: npc.spawnOrigin.x + Math.trunc((npc.spawnBoxSize.width - npc.maskSize.width) / 2),
    y: npc.spawnOrigin.y + Math.trunc((npc.spawnBoxSize.height - npc.maskSize.height) / 2),
  }
}
