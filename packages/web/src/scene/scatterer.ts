import { workerJobs } from '@/workerJobs';
import { scatterSector } from './scatter';
import type { Scatter, ScatterInputs } from './scatter';

/** Places what grows on a sector's ground and hands it to `done`, now or later. */
export interface Scatterer {
  scatter(inputs: ScatterInputs, done: (scatter: Scatter) => void): void;
}

/** A sector's scatter takes milliseconds, a frame's budget, so it is placed in a module worker, and inline where there is none or it fails. */
export function defaultScatterer(): Scatterer {
  return { scatter: workerJobs(() => new Worker(new URL('./scatter.worker.ts', import.meta.url), { type: 'module' }), scatterSector) };
}
