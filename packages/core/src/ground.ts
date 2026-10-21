import type { SectorView } from '@somnio/protocol';
import type { Rect } from './geometry.ts';
import { sectorRect } from './sector.ts';

/**
 * Where a sector's painted ground is rasterized, and how far one sector's ground reaches into
 * another's. The client rasterizes by these rules, and the world judges a layout by them, so a
 * border two sectors of one texel size share comes out the same on both sides. Between sizes it
 * shows the step in resolution.
 */

/** The finest texel, on one grid aligned to the space's origin, so neighbouring sectors' texels coincide. */
const GROUND_TEXEL_METRES = 0.08;
/** The most texels along a sector's larger side; a larger sector takes a coarser power-of-two texel. */
const GROUND_MAX_TEXELS = 1024;
/**
 * Texels rasterized past every side of a sector, from the same inputs as the neighbour's own, so a
 * lookup the shader wobbles across the edge never reads past the texture.
 */
export const GROUND_GUTTER_TEXELS = 4;
/** How wide the band is over which one outdoor sector's background gives way to its neighbour's. */
export const SECTOR_BORDER_BLEND_METRES = 5;
/** The most the noise that breaks that band into patches moves it. */
export const SECTOR_BORDER_NOISE_METRES = 1.5;
/** How far past its rect a sector's background can still paint. */
export const SECTOR_BORDER_SUPPORT_METRES = SECTOR_BORDER_BLEND_METRES / 2 + SECTOR_BORDER_NOISE_METRES;

/** Rounding slack when snapping a decimal-metre edge to the texel grid. */
const GRID_SLACK = 1e-6;

export function groundTexelMetres(sector: SectorView): number {
  let texel = GROUND_TEXEL_METRES;
  while (Math.max(sector.size.width, sector.size.depth) / texel > GROUND_MAX_TEXELS + GRID_SLACK) texel *= 2;
  return texel;
}

/** The texels a sector's ground covers, as grid indices in its space: its rect plus the gutter, snapped outward to the grid. */
export interface GroundRaster {
  texel: number;
  column: number;
  row: number;
  columns: number;
  rows: number;
}

export function groundRaster(sector: SectorView): GroundRaster {
  const texel = groundTexelMetres(sector);
  const rect = sectorRect(sector);
  const gutter = GROUND_GUTTER_TEXELS * texel;
  const column = Math.floor((rect.x - gutter) / texel + GRID_SLACK);
  const row = Math.floor((rect.z - gutter) / texel + GRID_SLACK);
  const columns = Math.ceil((rect.x + rect.width + gutter) / texel - GRID_SLACK) - column;
  const rows = Math.ceil((rect.z + rect.depth + gutter) / texel - GRID_SLACK) - row;
  return { texel, column, row, columns, rows };
}

/** The ground a sector's raster covers, in its space's coordinates. */
export function paddedRasterRect(sector: SectorView): Rect {
  const raster = groundRaster(sector);
  return { x: raster.column * raster.texel, z: raster.row * raster.texel, width: raster.columns * raster.texel, depth: raster.rows * raster.texel };
}
