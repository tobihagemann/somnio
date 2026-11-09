import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildSpaceCollision, rasterizeWalkable, walkRasterInputs } from '@somnio/core';
import type { WalkRaster } from '@somnio/core';
import { defaultWalkRasterizer } from '@/client/walkRasterizer';
import { rasterizeGround } from '@/scene/groundField';
import type { GroundField } from '@/scene/groundField';
import { defaultGroundRasterizer } from '@/scene/groundRasterizer';
import { serveWorkerJobs, workerJobs } from '@/workerJobs';
import { TEST_REGISTRY, interiorSector, outdoorSector } from '../../core/test/support/worldFixture.ts';

/**
 * The two halves of a worker job, page and worker, talking through a fake `Worker` and the worker's
 * `self`. happy-dom has no `Worker`, so every other suite runs its jobs inline.
 */

/** A worker's global scope, what `self` is inside it. */
class WorkerScope {
  /** Vite resolves a worker's module URL against it. */
  readonly location = globalThis.location;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  readonly replies: { data: unknown; transfer: Transferable[] }[] = [];
  postMessage(data: unknown, options: { transfer: Transferable[] }): void {
    this.replies.push({ data, transfer: options.transfer });
  }
}

/** The page's handle on a worker running in `FakeWorker.scope`. Nothing crosses until `answer`, which hands the jobs over newest first. */
class FakeWorker {
  static scope = new WorkerScope();
  static last: FakeWorker | undefined;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  private readonly scope = FakeWorker.scope;
  /** Posted and not yet answered. */
  readonly jobs: unknown[] = [];
  constructor() {
    FakeWorker.last = this;
  }
  postMessage(message: unknown): void {
    this.jobs.push(structuredClone(message));
  }
  answer(): Transferable[][] {
    for (const job of this.jobs.splice(0).reverse()) this.scope.onmessage!({ data: job });
    const replies = this.scope.replies.splice(0);
    for (const { data } of replies) this.onmessage!({ data });
    return replies.map(({ transfer }) => transfer);
  }
  terminate(): void {}
}

/** A fresh worker scope as `self`, for a worker entry to serve on. */
function workerScope(): void {
  FakeWorker.scope = new WorkerScope();
  vi.stubGlobal('self', FakeWorker.scope);
  vi.stubGlobal('Worker', FakeWorker);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('worker jobs', () => {
  it('hands each job the output the worker computed for it, with the buffers it transferred', () => {
    workerScope();
    serveWorkerJobs(
      (n: number) => new Float64Array([n * 2]),
      (output) => [output.buffer],
    );
    const run = workerJobs(
      () => new FakeWorker() as unknown as Worker,
      (): Float64Array => {
        throw new Error('ran inline');
      },
    );
    const outputs: [string, number][] = [];

    run(1, (output) => outputs.push(['first', output[0]!]));
    run(5, (output) => outputs.push(['second', output[0]!]));
    expect(outputs).toEqual([]);
    const transfers = FakeWorker.last!.answer();

    expect(outputs).toEqual([
      ['second', 10],
      ['first', 2],
    ]);
    expect(transfers.map((transfer) => transfer.length)).toEqual([1, 1]);
  });

  it('runs inline what a worker that failed held, and every job after', () => {
    vi.stubGlobal('Worker', FakeWorker);
    const run = workerJobs(
      () => new FakeWorker() as unknown as Worker,
      (n: number) => n * 2,
    );
    const outputs: number[] = [];

    run(1, (output) => outputs.push(output));
    run(5, (output) => outputs.push(output));
    expect(FakeWorker.last!.jobs).toHaveLength(2);
    expect(outputs).toEqual([]);
    FakeWorker.last!.onerror!();
    expect(outputs).toEqual([2, 10]);

    run(7, (output) => outputs.push(output));
    expect(outputs).toEqual([2, 10, 14]);
    expect(FakeWorker.last!.jobs).toHaveLength(2);
  });

  it('rasterizes a ground field in the ground worker', async () => {
    workerScope();
    await import('@/scene/groundField.worker');
    const inputs = { sector: interiorSector('Room'), neighbours: [] };
    const fields: GroundField[] = [];

    defaultGroundRasterizer().rasterize(inputs, (field) => fields.push(field));
    expect(fields).toEqual([]);
    const [transfer] = FakeWorker.last!.answer();

    expect(fields).toEqual([rasterizeGround(inputs)]);
    expect(transfer).toEqual(fields[0]!.weights.map((bytes) => bytes.buffer));
  });

  it('rasterizes where a body can walk in the walk worker', async () => {
    workerScope();
    await import('@/client/walkRaster.worker');
    const sector = outdoorSector('Field', { x: 0, z: 0 });
    const inputs = walkRasterInputs(buildSpaceCollision({ id: 'outdoors', sectors: [sector] }, TEST_REGISTRY), sector);
    const rasters: WalkRaster[] = [];

    defaultWalkRasterizer().rasterize(inputs, (raster) => rasters.push(raster));
    expect(rasters).toEqual([]);
    const [transfer] = FakeWorker.last!.answer();

    expect(rasters).toEqual([rasterizeWalkable(inputs)]);
    expect(transfer).toEqual([rasters[0]!.cells.buffer]);
  });
});
