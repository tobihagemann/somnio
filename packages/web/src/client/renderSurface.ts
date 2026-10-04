import type { Heading, Point } from '@somnio/core';
import type { Gait, SectorView } from '@somnio/protocol';
import type { ClientEntity, ClientWorld } from './clientWorld';

/**
 * The world render surface — the ten-method contract
 * the Three.js scene implements. Declared here rather than in the scene module so the
 * controller can drive a renderer or a test spy without importing any WebGL.
 */
export interface WorldRenderSurface {
  /**
   * Starts a new space, empty until its sectors are added. The outgoing space stays on screen
   * until the local player is placed, avoiding a frame of the new space with no character in it.
   */
  enterSpace(world: ClientWorld): void;
  addSector(sector: SectorView): void;
  removeSector(name: string): void;
  placeEntity(entity: ClientEntity): void;
  /**
   * `travel` is the heading of this step's movement (`undefined` when the entity did not move),
   * letting the renderer pick backpedal/strafe clips; `undefined` must not overwrite the last
   * one, or the clip drops mid-glide.
   */
  updatePosition(entityId: string, position: Point, facing: Heading, travel: Heading | undefined): void;
  updateGait(entityId: string, gait: Gait): void;
  /** The world clock at this moment; the renderer runs it forward by itself. */
  setClock(worldSeconds: number): void;
  showSpeechBubble(entityId: string, lines: string[], lifetimeMs: number): void;
  removeEntity(entityId: string): void;
  showSplash(): void;
}

/** No-op surface for headless tests and for the window between boot and first render. */
export const noopRenderSurface: WorldRenderSurface = {
  enterSpace: () => {},
  addSector: () => {},
  removeSector: () => {},
  placeEntity: () => {},
  updatePosition: () => {},
  updateGait: () => {},
  setClock: () => {},
  showSpeechBubble: () => {},
  removeEntity: () => {},
  showSplash: () => {},
};
