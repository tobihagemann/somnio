import { rasterizeWalkable } from '@somnio/core';
import { serveWorkerJobs } from '@/workerJobs';

/** Rasterizes where a body can walk in a sector off the main thread and hands the cells back without a copy. */
serveWorkerJobs(rasterizeWalkable, (output) => [output.cells.buffer]);
