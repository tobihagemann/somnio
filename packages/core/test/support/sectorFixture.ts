import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSectorFile } from '../../src/sectorFile.ts';
import type { Sector } from '../../src/sector.ts';

/**
 * The committed `.somnio-sector` fixtures, resolved from this file so no test depends on the cwd.
 * The one place to edit when the fixtures move.
 */
const FIXTURES_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../fixtures');

export const SECTOR_FIXTURE_NAMES = ['EdariaArena', 'EdariaBibliothek', 'EdariaInn', 'EdariaMitte', 'EdariaShop', 'Nordwald', 'Nordwiese'] as const;
export type SectorFixtureName = (typeof SECTOR_FIXTURE_NAMES)[number];

/** Reads a committed `.somnio-sector` fixture, decoded as UTF-8. */
export function readSectorFixture(name: SectorFixtureName): string {
  return readFileSync(resolve(FIXTURES_ROOT, 'sectors', `${name}.somnio-sector`), 'utf8');
}

export function loadSectorFixtures(): Sector[] {
  return SECTOR_FIXTURE_NAMES.map((name) => readSectorFile(readSectorFixture(name), name));
}
