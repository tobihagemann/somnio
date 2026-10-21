import { rasterizeGround } from './groundField';
import type { GroundFieldInputs } from './groundField';

/** Rasterizes a sector's ground off the main thread and hands the weights back without a copy. */
self.onmessage = (event: MessageEvent<{ id: number; inputs: GroundFieldInputs }>) => {
  const { id, inputs } = event.data;
  const field = rasterizeGround(inputs);
  self.postMessage({ id, field }, { transfer: field.weights.map((bytes) => bytes.buffer) });
};
