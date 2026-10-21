import { afterEach, describe, expect, it, vi } from 'vitest';
import { GROUND_GUTTER_TEXELS, groundRaster, sectorRect } from '@somnio/core';
import { markPointBounds } from '@somnio/protocol';
import type { GroundMark, SectorView } from '@somnio/protocol';
import { rasterizeGround, sampleGroundField } from '@/scene/groundField';
import type { GroundField } from '@/scene/groundField';
import { defaultGroundRasterizer } from '@/scene/groundRasterizer';
import { GROUND_MATERIAL_IDS, MAX_GROUND_MATERIALS, groundMaterialChannel } from '@/scene/groundMaterials';
import type { GroundMaterialId } from '@/scene/groundMaterials';
import { loadSectorFixtures } from '../../core/test/support/sectorFixture.ts';
import { interiorSector, outdoorSector } from '../../core/test/support/worldFixture.ts';

/**
 * The painted ground's weights, which are pure: a field is a function of a sector and the sectors
 * touching it. Two touching sectors must compute identical weights wherever both rasterize, so the
 * seam between them cannot show.
 */

const channel = (id: GroundMaterialId): number => GROUND_MATERIAL_IDS.indexOf(id);
const GRASS = channel('grass-meadow');
const FOREST = channel('forest-floor');
const DIRT = channel('dirt-path');
const COBBLE = channel('cobble-town');

function land(
  name: string,
  origin: { x: number; z: number },
  size: { width: number; depth: number },
  background: string,
  marks: GroundMark[] = [],
): SectorView {
  return outdoorSector(name, origin, { size, ground: { backgroundMaterialId: background, marks } });
}

function field(sector: SectorView, neighbours: SectorView[] = []): GroundField {
  return rasterizeGround({ sector, neighbours });
}

/** The eight weights of the texel at a global grid index, or `undefined` outside the field. */
function texel(of: GroundField, column: number, row: number): number[] | undefined {
  const i = column - of.raster.column;
  const j = row - of.raster.row;
  if (i < 0 || j < 0 || i >= of.raster.columns || j >= of.raster.rows) return undefined;
  const index = (j * of.raster.columns + i) * 4;
  return [...of.weights[0].subarray(index, index + 4), ...of.weights[1].subarray(index, index + 4)];
}

/** Every texel two fields both rasterize, and whether each pair is equal. */
function sharedTexels(a: GroundField, b: GroundField): { count: number; differing: number } {
  let count = 0;
  let differing = 0;
  for (let row = Math.max(a.raster.row, b.raster.row); row < Math.min(a.raster.row + a.raster.rows, b.raster.row + b.raster.rows); row += 1) {
    for (
      let column = Math.max(a.raster.column, b.raster.column);
      column < Math.min(a.raster.column + a.raster.columns, b.raster.column + b.raster.columns);
      column += 1
    ) {
      count += 1;
      if (JSON.stringify(texel(a, column, row)) !== JSON.stringify(texel(b, column, row))) differing += 1;
    }
  }
  return { count, differing };
}

function mark(id: string, materialId: string, shape: GroundMark['shape'], opacity = 1): GroundMark {
  return { id, materialId, opacity, shape };
}

const square = (x: number, z: number, side: number): GroundMark['shape'] => ({
  kind: 'polygon',
  points: [
    { x, z },
    { x: x + side, z },
    { x: x + side, z: z + side },
    { x, z: z + side },
  ],
});

describe('a mark', () => {
  it('paints its material whole deep inside, nothing past its feather and noise, and a blend at its edge', () => {
    const plaza = field(land('Town', { x: 0, z: 0 }, { width: 20, depth: 20 }, 'grass-meadow', [mark('plaza', 'cobble-town', square(5, 5, 10))]));
    expect(sampleGroundField(plaza, 10, 10)[COBBLE]).toBeCloseTo(1, 2);
    expect(sampleGroundField(plaza, 5 - 0.7, 10)[COBBLE]).toBe(0);
    const edge = Array.from({ length: 40 }, (_, index) => sampleGroundField(plaza, 5, 5.5 + index * 0.25)[COBBLE]!);
    expect(Math.min(...edge)).toBeGreaterThan(0);
    expect(Math.max(...edge)).toBeLessThan(1);
  });

  it('is skipped for a material with no recipe, and a background with none draws the first recipe', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const unknown = field(land('Town', { x: 0, z: 0 }, { width: 20, depth: 20 }, 'lava', [mark('m', 'moss', square(5, 5, 10))]));
    const weights = sampleGroundField(unknown, 10, 10);
    expect(weights[0]).toBeCloseTo(1, 2);
    expect(weights.slice(1).every((weight) => weight === 0)).toBe(true);
  });

  /** A road clamped at the border still meets its continuation there at full weight. */
  it('reaches full weight 0.15 m past the border as a 3.2 m road clamped to its bound', () => {
    const size = { width: 20, depth: 20 };
    const bounds = markPointBounds(size, { kind: 'stroke', radius: 1.6 })!;
    const road = mark('road', 'dirt-path', {
      kind: 'stroke',
      radius: 1.6,
      points: [
        { x: 5, z: 10 },
        { x: bounds.x + bounds.width, z: 10 },
      ],
    });
    const west = land('West', { x: 0, z: 0 }, size, 'grass-meadow', [road]);
    const east = land('East', { x: 20, z: 0 }, size, 'grass-meadow');
    expect(sampleGroundField(field(east, [west]), 20.15, 10)[DIRT]).toBeCloseTo(1, 2);
  });
});

describe('the border between two outdoor sectors', () => {
  const west = land('West', { x: 0, z: 0 }, { width: 20, depth: 20 }, 'grass-meadow');
  const east = land('East', { x: 20, z: 0 }, { width: 20, depth: 20 }, 'forest-floor');
  const westField = field(west, [east]);
  const eastField = field(east, [west]);
  const along = Array.from({ length: 81 }, (_, index) => index * 0.25);

  it('blends the two backgrounds evenly on the border line, in patches', () => {
    const onLine = along.map((z) => sampleGroundField(westField, 20, z));
    const mean = (index: number): number => onLine.reduce((sum, weights) => sum + weights[index]!, 0) / onLine.length;
    expect(mean(GRASS)).toBeGreaterThan(0.35);
    expect(mean(GRASS)).toBeLessThan(0.65);
    expect(mean(FOREST)).toBeGreaterThan(0.35);
    expect(mean(FOREST)).toBeLessThan(0.65);
    expect(new Set(onLine.map((weights) => weights[GRASS]!.toFixed(3))).size).toBeGreaterThan(1);
  });

  it('keeps each background pure 4 m or more from the border', () => {
    for (const z of along) {
      expect(sampleGroundField(westField, 16, z)[GRASS]).toBe(1);
      expect(sampleGroundField(eastField, 24, z)[FOREST]).toBe(1);
    }
  });

  it("computes in each sector's gutter exactly the neighbour's own texels", () => {
    const shared = sharedTexels(westField, eastField);
    expect(shared.count).toBeGreaterThan(0);
    expect(shared.differing).toBe(0);
  });

  /** The shader wobbles its lookup at most 0.09 m an axis; both textures read alike for every lookup within twice that of the border. */
  it('reads the same weights from either texture for a lookup wobbled across the border', () => {
    for (const z of along) {
      for (const x of [19.82, 19.9, 20, 20.1, 20.18]) {
        const fromWest = sampleGroundField(westField, x, z);
        const fromEast = sampleGroundField(eastField, x, z);
        fromWest.forEach((weight, index) => expect(weight).toBeCloseTo(fromEast[index]!, 9));
      }
    }
  });

  it('resolves overlapping opaque marks of the two sectors to the same material on both sides, whichever is drawn first', () => {
    const westPaint = land('West', { x: 0, z: 0 }, { width: 20, depth: 20 }, 'grass-meadow', [mark('plaza', 'cobble-town', square(18.6, 8, 2.2))]);
    const eastPaint = land('East', { x: 20, z: 0 }, { width: 20, depth: 20 }, 'forest-floor', [mark('path', 'dirt-path', square(-0.8, 8.5, 2.2))]);
    const fromWest = field(westPaint, [eastPaint]);
    const fromEast = field(eastPaint, [westPaint]);
    expect(sharedTexels(fromWest, fromEast).differing).toBe(0);
    // Paint order is sector name then index: East's path is painted before West's plaza, which wins.
    expect(sampleGroundField(fromEast, 20.05, 9.5)[COBBLE]).toBeCloseTo(1, 2);
  });

  it("raises the neighbour's dirt where a road of one sector reaches across", () => {
    const road = mark('road', 'dirt-path', { kind: 'stroke', radius: 0.5, points: [{ x: 19.5, z: 10 }] });
    const painted = land('West', { x: 0, z: 0 }, { width: 20, depth: 20 }, 'grass-meadow', [road]);
    expect(sampleGroundField(field(east, [painted]), 20.2, 10)[DIRT]).toBeGreaterThan(0);
    expect(sampleGroundField(field(east, [west]), 20.2, 10)[DIRT]).toBe(0);
  });

  it("selects a mark whose noise-widened edge reaches into the neighbour's raster, and leaves out one that stops short", () => {
    const padded = groundRaster(east).column * groundRaster(east).texel;
    // Radius plus half the feather stops short of the padded raster; the edge noise reaches 0.375 m further.
    const reaching = mark('reaching', 'dirt-path', { kind: 'stroke', radius: 0.5, points: [{ x: padded - 0.5 - 0.3 - 0.1, z: 10 }] });
    const short = mark('short', 'dirt-path', { kind: 'stroke', radius: 0.5, points: [{ x: padded - 0.5 - 0.675 - 0.01, z: 10 }] });
    for (const candidate of [reaching, short]) {
      const painted = land('West', { x: 0, z: 0 }, { width: 20, depth: 20 }, 'grass-meadow', [candidate]);
      expect(sharedTexels(field(painted, [east]), field(east, [painted])).differing).toBe(0);
    }
    const shortPainted = land('West', { x: 0, z: 0 }, { width: 20, depth: 20 }, 'grass-meadow', [short]);
    expect(sharedTexels(field(east, [shortPainted]), field(east, [west])).differing).toBe(0);
  });

  /** The neighbour picks its marks against its padded raster, gutter included, not against its bare rect. */
  it("paints a mark ending just short of the border into the neighbour's gutter as its own sector does", () => {
    const strip = mark('strip', 'dirt-path', {
      kind: 'polygon',
      points: [
        { x: 10, z: 1 },
        { x: 19.32, z: 1 },
        { x: 19.32, z: 19 },
        { x: 10, z: 19 },
      ],
    });
    const painted = land('West', { x: 0, z: 0 }, { width: 20, depth: 20 }, 'grass-meadow', [strip]);
    const theirs = field(east, [painted]);
    const gutter = Array.from({ length: Math.round(20 / theirs.raster.texel) - theirs.raster.column }, (_, index) => theirs.raster.column + index);
    const rows = Array.from({ length: Math.round(18 / theirs.raster.texel) }, (_, index) => Math.round(1 / theirs.raster.texel) + index);
    expect(Math.max(...rows.flatMap((row) => gutter.map((column) => texel(theirs, column, row)![DIRT]!)))).toBeGreaterThan(0);
    expect(sharedTexels(field(painted, [east]), theirs).differing).toBe(0);
  });
});

describe('layouts', () => {
  /** Every pair of touching sectors agrees on every texel both rasterize. */
  function agree(sectors: SectorView[]): void {
    const touching = (a: SectorView, b: SectorView): boolean => {
      const ra = sectorRect(a);
      const rb = sectorRect(b);
      return rb.x <= ra.x + ra.width + 0.001 && ra.x <= rb.x + rb.width + 0.001 && rb.z <= ra.z + ra.depth + 0.001 && ra.z <= rb.z + rb.depth + 0.001;
    };
    const fields = new Map(
      sectors.map((sector) => [
        sector.name,
        field(
          sector,
          sectors.filter((other) => other !== sector && touching(sector, other)),
        ),
      ]),
    );
    for (const a of sectors) {
      for (const b of sectors) {
        if (a.name >= b.name || !touching(a, b) || groundRaster(a).texel !== groundRaster(b).texel) continue;
        const shared = sharedTexels(fields.get(a.name)!, fields.get(b.name)!);
        expect(shared.count, `${a.name}|${b.name}`).toBeGreaterThan(0);
        expect(shared.differing, `${a.name}|${b.name}`).toBe(0);
      }
    }
  }

  it('agrees across a staggered pair, a span end, and a corner three sectors meet at', () => {
    agree([
      land('A', { x: 0, z: 0 }, { width: 16, depth: 16 }, 'grass-meadow'),
      land('B', { x: 16, z: 0 }, { width: 16, depth: 32 }, 'forest-floor'),
      land('C', { x: 0, z: 16 }, { width: 16, depth: 16 }, 'dirt-path'),
    ]);
  });

  it('agrees for sectors whose origins lie off the texel grid', () => {
    agree([
      land('A', { x: 0.03, z: -0.05 }, { width: 16.1, depth: 16.1 }, 'grass-meadow', [mark('m', 'cobble-town', square(14, 6, 3))]),
      land('B', { x: 16.13, z: 4.01 }, { width: 16, depth: 16 }, 'forest-floor'),
    ]);
  });

  it('agrees for a coarse raster', () => {
    const big = { width: 160, depth: 160 };
    agree([land('A', { x: 0, z: 0 }, big, 'grass-meadow'), land('B', { x: 160, z: 40 }, big, 'forest-floor')]);
  });

  it('takes the next power-of-two texel past 81.92 m, with a gutter that covers the lookup wobble and a texel', () => {
    expect(groundRaster(land('A', { x: 0, z: 0 }, { width: 81.92, depth: 20 }, 'grass-meadow')).texel).toBeCloseTo(0.08, 12);
    const coarse = groundRaster(land('A', { x: 0, z: 0 }, { width: 82, depth: 20 }, 'grass-meadow'));
    expect(coarse.texel).toBeCloseTo(0.16, 12);
    expect(GROUND_GUTTER_TEXELS * coarse.texel).toBeGreaterThan(0.09 + coarse.texel);
    expect(groundRaster(land('A', { x: 0, z: 0 }, { width: 512, depth: 512 }, 'grass-meadow')).texel).toBeCloseTo(0.64, 12);
  });
});

describe('an interior', () => {
  it('blends with no neighbour, whatever it is handed', () => {
    const room = interiorSector('Room', { size: { width: 10, depth: 10 }, ground: { backgroundMaterialId: 'wood-warm', marks: [] } });
    const beside = land('Beside', { x: 10, z: 0 }, { width: 20, depth: 20 }, 'grass-meadow');
    const handed = field(room, [beside]);
    expect(sampleGroundField(handed, 9.9, 5)).toEqual(sampleGroundField(field(room), 9.9, 5));
    expect(sampleGroundField(handed, 9.9, 5)[channel('wood-warm')]).toBe(1);
  });
});

describe('the committed world', () => {
  it('pins the floor-material ids, within the channels a field carries', () => {
    expect(GROUND_MATERIAL_IDS).toEqual(['grass-meadow', 'forest-floor', 'dirt-path', 'cobble-town', 'stone-arena', 'wood-warm']);
    expect(GROUND_MATERIAL_IDS.length).toBeLessThanOrEqual(MAX_GROUND_MATERIALS);
    expect(groundMaterialChannel('forest-floor')).toBe(1);
    expect(groundMaterialChannel('lava')).toBeUndefined();
  });

  it('names only materials the recipes draw', () => {
    const missing = loadSectorFixtures().flatMap((sector) =>
      [sector.ground.backgroundMaterialId, ...sector.ground.marks.map((each) => each.materialId)]
        .filter((id) => groundMaterialChannel(id) === undefined)
        .map((id) => `${sector.name}: ${id}`),
    );
    expect(missing).toEqual([]);
  });
});

describe('the default rasterizer', () => {
  /** A worker that takes every job and answers none, as one whose chunk failed to load. */
  class SilentWorker {
    static last: SilentWorker | undefined;
    onerror: (() => void) | null = null;
    onmessage: (() => void) | null = null;
    onmessageerror: (() => void) | null = null;
    readonly posted: unknown[] = [];
    constructor() {
      SilentWorker.last = this;
    }
    postMessage(message: unknown): void {
      this.posted.push(message);
    }
    terminate(): void {}
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rasterizes inline what a failed worker held, and every field after', () => {
    vi.stubGlobal('Worker', SilentWorker);
    const rasterizer = defaultGroundRasterizer();
    const inputs = { sector: interiorSector('Room'), neighbours: [] };
    const fields: GroundField[] = [];

    rasterizer.rasterize(inputs, (field) => fields.push(field));
    expect(SilentWorker.last!.posted).toHaveLength(1);
    expect(fields).toEqual([]);
    SilentWorker.last!.onerror!();
    expect(fields).toEqual([rasterizeGround(inputs)]);

    rasterizer.rasterize(inputs, (field) => fields.push(field));
    expect(fields).toHaveLength(2);
    expect(SilentWorker.last!.posted).toHaveLength(1);
  });
});
