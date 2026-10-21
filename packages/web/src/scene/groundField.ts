import {
  SECTOR_BORDER_BLEND_METRES,
  SECTOR_BORDER_NOISE_METRES,
  SECTOR_BORDER_SUPPORT_METRES,
  fbm,
  groundRaster,
  hashString,
  paddedRasterRect,
  rectsOverlap,
  sectorOrigin,
  sectorRect,
} from '@somnio/core';
import type { GroundRaster, Rect } from '@somnio/core';
import { SOMNIO_PROTOCOL_CONSTANTS, markInfluence, markReach } from '@somnio/protocol';
import type { GroundMark, GroundPoint, GroundShape, SectorView } from '@somnio/protocol';
import { GROUND_MATERIAL_IDS, MAX_GROUND_MATERIALS, groundMaterialChannel } from './groundMaterials';

/**
 * A sector's painted ground as material weights: each texel's share of every floor material,
 * from the sector's background blended with its touching neighbours' and the marks painted over
 * them. Pure, so the scene can run it in a worker and a test can call it directly.
 *
 * Two touching sectors of equal texel size compute identical weights at every texel both
 * rasterize, so the seam between them cannot show. Two things make that hold. Every input that
 * paints a point (each background's raw weight, each mark, each noise value) is a function of the
 * point in space coordinates and of the input itself, whichever sector computes it. And every
 * input that can reach a sector's raster is among that sector's inputs.
 */

/** What a sector's ground is rasterized from: the sector and the sectors touching it. */
export interface GroundFieldInputs {
  sector: SectorView;
  neighbours: readonly SectorView[];
}

export interface GroundField {
  raster: GroundRaster;
  /** RGBA bytes, row by row from the north-west texel: materials 0-3, then 4-7. */
  weights: [Uint8Array, Uint8Array];
}

/** The part of a sector its ground, and its neighbours' grounds, depend on. Placements and doors do not paint. */
export function groundFieldKey(inputs: GroundFieldInputs): string {
  const part = (sector: SectorView): unknown => [sector.name, sector.kind, sectorOrigin(sector), sector.size, sector.ground];
  return JSON.stringify([part(inputs.sector), ...blendedNeighbours(inputs).map(part)]);
}

/** An interior blends with nothing, and outdoors only another outdoor sector's background blends in. */
function blendedNeighbours(inputs: GroundFieldInputs): SectorView[] {
  if (inputs.sector.kind === 'interior') return [];
  return inputs.neighbours
    .filter((neighbour) => neighbour.kind === 'outdoor' && neighbour.name !== inputs.sector.name)
    .toSorted((a, b) => compare(a.name, b.name));
}

interface Background {
  rect: Rect;
  seed: number;
  material: number;
}

interface PaintedMark {
  mark: GroundMark;
  /** The mark's points in space coordinates. */
  points: GroundPoint[];
  /** Its influence in space coordinates. */
  influence: Rect;
  seed: number;
  material: number;
}

const warned = new Set<string>();

function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(message);
}

/** Weights for every texel of the sector's raster, a channel per floor material in `GROUND_MATERIAL_IDS` order. */
export function rasterizeGround(inputs: GroundFieldInputs): GroundField {
  const raster = groundRaster(inputs.sector);
  const { texel, column, row, columns, rows } = raster;
  const count = columns * rows;
  const weights = new Float32Array(count * MAX_GROUND_MATERIALS);
  const paint = paintInputs(inputs);

  const raw = new Float32Array(paint.backgrounds.length);
  for (let j = 0; j < rows; j += 1) {
    const z = (row + j + 0.5) * texel;
    for (let i = 0; i < columns; i += 1) {
      const x = (column + i + 0.5) * texel;
      backgroundWeights(paint.backgrounds, paint.own, x, z, raw, weights, (j * columns + i) * MAX_GROUND_MATERIALS);
    }
  }

  for (const painted of paint.marks) {
    const from = Math.max(0, Math.floor(painted.influence.x / texel - column));
    const to = Math.min(columns, Math.ceil((painted.influence.x + painted.influence.width) / texel - column));
    const top = Math.max(0, Math.floor(painted.influence.z / texel - row));
    const bottom = Math.min(rows, Math.ceil((painted.influence.z + painted.influence.depth) / texel - row));
    for (let j = top; j < bottom; j += 1) {
      const z = (row + j + 0.5) * texel;
      for (let i = from; i < to; i += 1) {
        const x = (column + i + 0.5) * texel;
        const alpha = markAlpha(painted, x, z);
        if (alpha <= 0) continue;
        const offset = (j * columns + i) * MAX_GROUND_MATERIALS;
        for (let channel = 0; channel < MAX_GROUND_MATERIALS; channel += 1) {
          weights[offset + channel] = weights[offset + channel]! * (1 - alpha) + (channel === painted.material ? alpha : 0);
        }
      }
    }
  }

  const low = new Uint8Array(count * 4);
  const high = new Uint8Array(count * 4);
  for (let index = 0; index < count; index += 1) {
    for (let channel = 0; channel < 4; channel += 1) {
      low[index * 4 + channel] = Math.round(weights[index * MAX_GROUND_MATERIALS + channel]! * 255);
      high[index * 4 + channel] = Math.round(weights[index * MAX_GROUND_MATERIALS + 4 + channel]! * 255);
    }
  }
  return { raster, weights: [low, high] };
}

/**
 * The material weights at one point of a sector's field as rasterized, bilinear between texel
 * centres, as the shader reads them. Clamped to the raster's edge.
 */
export function sampleGroundField(field: GroundField, x: number, z: number): number[] {
  const { texel, column, row, columns, rows } = field.raster;
  const fx = Math.min(Math.max(x / texel - column - 0.5, 0), columns - 1);
  const fz = Math.min(Math.max(z / texel - row - 0.5, 0), rows - 1);
  const i = Math.floor(fx);
  const j = Math.floor(fz);
  const right = Math.min(i + 1, columns - 1);
  const below = Math.min(j + 1, rows - 1);
  const u = fx - i;
  const v = fz - j;
  const at = (ci: number, cj: number, channel: number): number => field.weights[channel < 4 ? 0 : 1][(cj * columns + ci) * 4 + (channel % 4)]! / 255;
  return Array.from({ length: MAX_GROUND_MATERIALS }, (_, channel) => {
    const top = at(i, j, channel) * (1 - u) + at(right, j, channel) * u;
    const bottom = at(i, below, channel) * (1 - u) + at(right, below, channel) * u;
    return top * (1 - v) + bottom * v;
  });
}

/**
 * Every input that can paint the sector's raster, in the one paint order both sides of a border
 * share: the sector's and its blended neighbours' backgrounds, and every mark of theirs whose
 * influence reaches the raster, by sector name and then array index.
 */
function paintInputs(inputs: GroundFieldInputs): { backgrounds: Background[]; own: number; marks: PaintedMark[] } {
  const padded = paddedRasterRect(inputs.sector);
  // In name order, so both sides of a border sum the same raw weights in the same order.
  const sectors = [inputs.sector, ...blendedNeighbours(inputs)].toSorted((a, b) => compare(a.name, b.name));
  const own = sectors.indexOf(inputs.sector);
  const backgrounds = sectors.map((sector): Background => {
    let material = groundMaterialChannel(sector.ground.backgroundMaterialId);
    if (material === undefined) {
      warnOnce(`floor material "${sector.ground.backgroundMaterialId}" has no recipe; drawing ${GROUND_MATERIAL_IDS[0]} instead`);
      material = 0;
    }
    return { rect: sectorRect(sector), seed: hashString(sector.name), material };
  });
  const marks: PaintedMark[] = [];
  for (const sector of sectors) {
    const origin = sectorOrigin(sector);
    for (const mark of sector.ground.marks) {
      const local = markInfluence(mark.shape);
      const influence = { x: origin.x + local.x, z: origin.z + local.z, width: local.width, depth: local.depth };
      if (!rectsOverlap(influence, padded)) continue;
      const material = groundMaterialChannel(mark.materialId);
      if (material === undefined) {
        warnOnce(`floor material "${mark.materialId}" has no recipe; leaving its marks unpainted`);
        continue;
      }
      const points = mark.shape.points.map((point) => ({ x: origin.x + point.x, z: origin.z + point.z }));
      marks.push({ mark, points, influence, seed: hashString(`${sector.name}/${mark.id}`), material });
    }
  }
  return { backgrounds, own, marks };
}

/** Each background's raw weight at the point, normalized into its material's channel; the sector's own background where none reaches. */
function backgroundWeights(
  backgrounds: readonly Background[],
  own: number,
  x: number,
  z: number,
  raw: Float32Array,
  weights: Float32Array,
  offset: number,
): void {
  let total = 0;
  backgrounds.forEach((background, index) => {
    raw[index] = backgroundRawWeight(background, x, z);
    total += raw[index];
  });
  if (total === 0) {
    weights[offset + backgrounds[own]!.material] = 1;
    return;
  }
  backgrounds.forEach((background, index) => {
    weights[offset + background.material] = weights[offset + background.material]! + raw[index]! / total;
  });
}

/**
 * A smoothstep across `SECTOR_BORDER_BLEND_METRES`, from half of it outside the rect to half of
 * it inside, of the distance to the rect broken by low-frequency noise keyed to the sector.
 */
function backgroundRawWeight(background: Background, x: number, z: number): number {
  const distance = signedRectDistance(background.rect, x, z);
  if (distance >= SECTOR_BORDER_SUPPORT_METRES) return 0;
  if (distance <= -SECTOR_BORDER_SUPPORT_METRES) return 1;
  const noise =
    (0.75 * (fbm(x * 0.22, z * 0.22, background.seed) - 0.5) + 0.25 * (fbm(x * 0.8, z * 0.8, background.seed + 1) - 0.5)) * 2 * SECTOR_BORDER_NOISE_METRES;
  const half = SECTOR_BORDER_BLEND_METRES / 2;
  return smoothstep(-half, half, -(distance + noise));
}

/**
 * How much of the mark's material the point takes: its opacity inside, nothing outside, and a
 * fade `markFeatherMetres` wide centred on the edge, which noise keyed to the mark breaks up.
 */
function markAlpha(painted: PaintedMark, x: number, z: number): number {
  const distance = shapeDistance(painted.mark.shape, x, z, painted.points);
  const reach = markReach();
  if (distance >= reach) return 0;
  if (distance <= -reach) return painted.mark.opacity;
  const noise =
    (0.72 * (fbm(x * 0.7, z * 0.7, painted.seed) - 0.5) + 0.28 * (fbm(x * 2.6, z * 2.6, painted.seed + 1) - 0.5)) *
    2 *
    SOMNIO_PROTOCOL_CONSTANTS.markEdgeNoiseMetres;
  const half = SOMNIO_PROTOCOL_CONSTANTS.markFeatherMetres / 2;
  return painted.mark.opacity * (1 - smoothstep(-half, half, distance + noise));
}

/**
 * Signed distance from the point to a mark shape's edge, negative inside. `points` are the shape's
 * points wherever the point is measured, its own sector-relative ones by default.
 */
export function shapeDistance(shape: GroundShape, x: number, z: number, points: readonly GroundPoint[] = shape.points): number {
  if (shape.kind === 'stroke') {
    if (points.length === 1) return Math.hypot(x - points[0]!.x, z - points[0]!.z) - shape.radius;
    let nearest = Number.POSITIVE_INFINITY;
    for (let index = 0; index + 1 < points.length; index += 1) nearest = Math.min(nearest, segmentDistance(x, z, points[index]!, points[index + 1]!));
    return nearest - shape.radius;
  }
  let nearest = Number.POSITIVE_INFINITY;
  let inside = false;
  for (let index = 0, previous = points.length - 1; index < points.length; previous = index, index += 1) {
    const a = points[previous]!;
    const b = points[index]!;
    nearest = Math.min(nearest, segmentDistance(x, z, a, b));
    if (b.z > z !== a.z > z && x < ((a.x - b.x) * (z - b.z)) / (a.z - b.z) + b.x) inside = !inside;
  }
  return inside ? -nearest : nearest;
}

function segmentDistance(x: number, z: number, a: GroundPoint, b: GroundPoint): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const lengthSquared = dx * dx + dz * dz;
  const along = lengthSquared === 0 ? 0 : Math.min(1, Math.max(0, ((x - a.x) * dx + (z - a.z) * dz) / lengthSquared));
  return Math.hypot(x - (a.x + along * dx), z - (a.z + along * dz));
}

/** Distance from the point to the rect, negative inside: there, minus the distance to the nearest edge. */
function signedRectDistance(rect: Rect, x: number, z: number): number {
  const dx = Math.max(rect.x - x, x - (rect.x + rect.width));
  const dz = Math.max(rect.z - z, z - (rect.z + rect.depth));
  if (dx <= 0 && dz <= 0) return Math.max(dx, dz);
  return Math.hypot(Math.max(dx, 0), Math.max(dz, 0));
}

function smoothstep(from: number, to: number, value: number): number {
  const t = Math.min(1, Math.max(0, (value - from) / (to - from)));
  return t * t * (3 - 2 * t);
}

/** Code-unit order, the same on every machine, unlike `localeCompare`. */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
