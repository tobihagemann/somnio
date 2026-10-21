import { rasterizeGround } from './groundField';
import type { GroundField, GroundFieldInputs } from './groundField';

/** Rasterizes a sector's ground and hands the field to `done`, now or later. */
export interface GroundRasterizer {
  rasterize(inputs: GroundFieldInputs, done: (field: GroundField) => void): void;
}

/**
 * A field takes tens of milliseconds, too long for any frame, so it is rasterized in a module
 * worker, created on first use. Where there is no `Worker` (Node and happy-dom) it is rasterized
 * inline, during the scene's tick. A worker that fails, such as one whose chunk is gone after a
 * deploy, answers nothing, so what it held and every later field are rasterized inline instead.
 */
export function defaultGroundRasterizer(): GroundRasterizer {
  const inline = (inputs: GroundFieldInputs, done: (field: GroundField) => void): void => done(rasterizeGround(inputs));
  if (typeof Worker === 'undefined') return { rasterize: inline };
  let worker: Worker | undefined;
  let failed = false;
  let nextId = 0;
  const waiting = new Map<number, { inputs: GroundFieldInputs; done: (field: GroundField) => void }>();
  const fail = (): void => {
    failed = true;
    worker?.terminate();
    const held = [...waiting.values()];
    waiting.clear();
    for (const { inputs, done } of held) inline(inputs, done);
  };
  return {
    rasterize: (inputs, done) => {
      if (failed) {
        inline(inputs, done);
        return;
      }
      if (worker === undefined) {
        worker = new Worker(new URL('./groundField.worker.ts', import.meta.url), { type: 'module' });
        worker.onmessage = (event: MessageEvent<{ id: number; field: GroundField }>) => {
          const job = waiting.get(event.data.id);
          waiting.delete(event.data.id);
          job?.done(event.data.field);
        };
        worker.onerror = fail;
        worker.onmessageerror = fail;
      }
      const id = nextId;
      nextId += 1;
      waiting.set(id, { inputs, done });
      worker.postMessage({ id, inputs });
    },
  };
}
