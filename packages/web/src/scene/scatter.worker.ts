import { serveWorkerJobs } from '@/workerJobs';
import { scatterSector } from './scatter';

/** Places a sector's scatter off the main thread. */
serveWorkerJobs(scatterSector, () => []);
