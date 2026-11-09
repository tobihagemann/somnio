import { serveWorkerJobs } from '@/workerJobs';
import { rasterizeGround } from './groundField';

/** Rasterizes a sector's ground off the main thread and hands the weights back without a copy. */
serveWorkerJobs(rasterizeGround, (output) => output.weights.map((bytes) => bytes.buffer));
