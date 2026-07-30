import type { GridPoint, Heading, Sector, SubpixelPoint, Tempo, WorldEntity } from '@/core'
import type { LightSetting } from '@/core'

/**
 * Mirror of `Sources/SomnioCore/Rendering/WorldRenderSurface.swift` — the ten-method contract
 * the Three.js scene implements. Declared here rather than in the scene module so the
 * controller can drive a renderer or a test spy without importing any WebGL, exactly as the
 * Swift protocol lets the view model hold `any WorldRenderSurface`.
 */
export interface WorldRenderSurface {
  /**
   * Swaps the rendered sector. With `awaitingPlayerPlacement` the held visual stays on screen
   * until the local player is placed, avoiding a frame of the new sector framed on its origin
   * with no character.
   */
  load(sector: Sector, awaitingPlayerPlacement: boolean): void
  placeEntity(entity: WorldEntity): void
  updatePosition(entityID: number, position: GridPoint, facing: Heading): void
  /**
   * Sub-pixel variant for the locally predicted player. `travel` is the heading of this step's
   * intended movement (`undefined` on a stationary tick), letting the renderer pick
   * backpedal/strafe clips; it must not be overwritten with `undefined`, or the clip drops
   * mid-glide.
   */
  updateSubpixelPosition(
    entityID: number,
    position: SubpixelPoint,
    facing: Heading,
    travel: Heading | undefined
  ): void
  animateEntity(entityID: number, position: GridPoint, facing: Heading, durationSeconds: number): void
  updateTempo(entityID: number, tempo: Tempo): void
  updateDayNightTint(hour: number, minute: number, sectorLight: LightSetting): void
  showSpeechBubble(entityID: number, lines: string[], lifetimeMs: number): void
  removeEntity(entityID: number): void
  showSplash(): void
}

/** No-op surface for headless tests and for the window between boot and first render. */
export const noopRenderSurface: WorldRenderSurface = {
  load: () => {},
  placeEntity: () => {},
  updatePosition: () => {},
  updateSubpixelPosition: () => {},
  animateEntity: () => {},
  updateTempo: () => {},
  updateDayNightTint: () => {},
  showSpeechBubble: () => {},
  removeEntity: () => {},
  showSplash: () => {},
}
