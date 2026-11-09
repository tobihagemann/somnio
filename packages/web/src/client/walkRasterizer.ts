import { rasterizeWalkable } from '@somnio/core';
import type { WalkRaster, WalkRasterInputs } from '@somnio/core';
import { workerJobs } from '@/workerJobs';

/** Rasterizes where a body can walk in a sector and hands the raster to `done`, now or later. */
export interface WalkRasterizer {
  rasterize(inputs: WalkRasterInputs, done: (raster: WalkRaster) => void): void;
}

/** A large sector's raster takes tens of milliseconds, so it is computed in a module worker, and inline where there is none. */
export function defaultWalkRasterizer(): WalkRasterizer {
  return { rasterize: workerJobs(() => new Worker(new URL('./walkRaster.worker.ts', import.meta.url), { type: 'module' }), rasterizeWalkable) };
}
