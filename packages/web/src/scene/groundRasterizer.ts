import { workerJobs } from '@/workerJobs';
import { rasterizeGround } from './groundField';
import type { GroundField, GroundFieldInputs } from './groundField';

/** Rasterizes a sector's ground and hands the field to `done`, now or later. */
export interface GroundRasterizer {
  rasterize(inputs: GroundFieldInputs, done: (field: GroundField) => void): void;
}

/** A field takes tens of milliseconds, too long for any frame, so it is rasterized in a module worker, and inline during the scene's tick where there is none or it fails. */
export function defaultGroundRasterizer(): GroundRasterizer {
  return { rasterize: workerJobs(() => new Worker(new URL('./groundField.worker.ts', import.meta.url), { type: 'module' }), rasterizeGround) };
}
