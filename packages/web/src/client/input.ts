import { PLAYER_ZOOM, applyScrollZoom } from '@/scene/cameraRig';

/**
 * Session-only scroll zoom. Holds the factor rather than the camera scale, so the clamp lives in
 * `applyScrollZoom` alone.
 */
export class PlayerZoom {
  private currentFactor = 1;

  get factor(): number {
    return this.currentFactor;
  }

  /** Reports whether the factor actually moved, so a caller can let a clamped event pass. */
  applyScroll(deltaY: number): boolean {
    const previous = this.currentFactor;
    this.currentFactor = applyScrollZoom(previous, deltaY);
    return this.currentFactor !== previous;
  }

  /** Scales the factor by `ratio`, within the same clamp as a scroll. */
  applyPinch(ratio: number): boolean {
    return this.applyScroll(Math.log(ratio) / PLAYER_ZOOM.scrollGain);
  }
}
