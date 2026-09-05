import { describe, expect, it } from 'vitest';
import { SOMNIO_CONSTANTS, feetRect, intersects, maxY } from '@somnio/core';
import type { CollisionMask, SectorPortal } from '@somnio/core';
import { PerSectorActor } from '../src/world/perSectorActor.ts';
import { seededRandom } from '../src/world/random.ts';
import { testLogger } from './support/logger.ts';
import { makePortal, makeSector } from './support/sectorFactory.ts';

const SPRITE = SOMNIO_CONSTANTS.playerSpriteSize;

/** Sized to contain the portal rect (12 x 8 tiles = 1536 x 1024 px). */
function actorWith(name: string, portal: SectorPortal, masks: CollisionMask[] = [], seed?: number) {
  return new PerSectorActor(
    makeSector(name, { dimensions: { width: 12, height: 8 }, collisionMasks: masks, portals: [portal] }),
    seed === undefined ? { logger: testLogger() } : { logger: testLogger(), random: seededRandom(seed) },
  );
}

function inside(point: { x: number; y: number }, portal: SectorPortal): boolean {
  return point.x >= portal.x && point.x < portal.x + portal.width && point.y >= portal.y && point.y < portal.y + portal.height;
}

describe('arrivalPlacement', () => {
  it('lands inside the inbound portal keyed to the source sector', () => {
    const portal = makePortal({ x: 1344, y: 208, width: 160, height: 96 }, 'EdariaBibliothek', 'arrivalPlacement');
    const point = actorWith('EdariaMitte', portal, [], 1).arrivalPlacement('EdariaBibliothek', SPRITE);
    expect(point).toBeDefined();
    expect(inside(point!, portal)).toBe(true);
  });

  it('reverse arrival lands inside the EdariaBibliothek inbound portal', () => {
    const portal = makePortal({ x: 64, y: 384, width: 160, height: 96 }, 'EdariaMitte', 'arrivalPlacement');
    const point = actorWith('EdariaBibliothek', portal, [], 2).arrivalPlacement('EdariaMitte', SPRITE);
    expect(point).toBeDefined();
    expect(inside(point!, portal)).toBe(true);
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8])('keeps the feet box inside the arrival zone (seed %i)', (seed) => {
    const portal = makePortal({ x: 64, y: 384, width: 160, height: 96 }, 'EdariaMitte', 'arrivalPlacement');
    const point = actorWith('EdariaBibliothek', portal, [], seed).arrivalPlacement('EdariaMitte', SPRITE);
    const feet = feetRect(point!, SPRITE);
    expect(feet.y).toBeGreaterThanOrEqual(portal.y);
    expect(maxY(feet)).toBeLessThanOrEqual(portal.y + portal.height);
  });

  it('returns undefined when no inbound portal targets the source sector', () => {
    const portal = makePortal({ x: 1344, y: 208, width: 160, height: 96 }, 'EdariaBibliothek', 'arrivalPlacement');
    expect(actorWith('EdariaMitte', portal).arrivalPlacement('Nowhere', SPRITE)).toBeUndefined();
  });

  it('avoids a static mask inside the portal', () => {
    const portal = makePortal({ x: 1344, y: 208, width: 160, height: 96 }, 'EdariaBibliothek', 'arrivalPlacement');
    const mask = { x: 1344, y: 208, width: 64, height: 96 };
    const point = actorWith('EdariaMitte', portal, [mask], 3).arrivalPlacement('EdariaBibliothek', SPRITE);
    expect(intersects(feetRect(point!, SPRITE), [mask])).toBe(false);
  });

  it('returns undefined when every cell is blocked', () => {
    const portal = makePortal({ x: 1344, y: 208, width: 160, height: 96 }, 'EdariaBibliothek', 'arrivalPlacement');
    const mask = { x: 1344, y: 240, width: 160, height: 96 };
    expect(actorWith('EdariaMitte', portal, [mask], 4).arrivalPlacement('EdariaBibliothek', SPRITE)).toBeUndefined();
  });
});
