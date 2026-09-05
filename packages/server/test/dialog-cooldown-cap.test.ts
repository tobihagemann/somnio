import { expect, it } from 'vitest';
import { DIALOG_COOLDOWN_CAP } from '../src/world/perSectorActor.ts';

it('dialog cooldown cap derives to 59 from the cooldown seconds and tick interval', () => {
  expect(DIALOG_COOLDOWN_CAP).toBe(59);
});
