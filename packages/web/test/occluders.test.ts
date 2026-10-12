import { describe, expect, it } from 'vitest';
import { screenOccluders } from '@/ui/occluders';

describe('screenOccluders', () => {
  const canvas = { left: 100, top: 50, width: 800, height: 400 };

  it('maps a rect in the bottom-left quarter of the canvas to the bottom-left quarter of the viewport', () => {
    expect(screenOccluders(canvas, [{ left: 100, top: 250, width: 400, height: 200 }])).toEqual([{ left: -1, bottom: -1, right: 0, top: 0 }]);
  });

  it('drops a hidden element, which measures nothing', () => {
    expect(screenOccluders(canvas, [{ left: 0, top: 0, width: 0, height: 0 }])).toEqual([]);
  });

  it('clips a rect reaching past the canvas to it', () => {
    expect(screenOccluders(canvas, [{ left: 0, top: 0, width: 300, height: 150 }])).toEqual([{ left: -1, bottom: 0.5, right: -0.5, top: 1 }]);
  });
});
