import { readSectorFile } from '@somnio/core';
import type { Sector } from '@somnio/core';
import edariaArena from '@somnio/core/fixtures/sectors/EdariaArena.somnio-sector?raw';
import edariaBibliothek from '@somnio/core/fixtures/sectors/EdariaBibliothek.somnio-sector?raw';
import edariaInn from '@somnio/core/fixtures/sectors/EdariaInn.somnio-sector?raw';
import edariaMitte from '@somnio/core/fixtures/sectors/EdariaMitte.somnio-sector?raw';
import edariaShop from '@somnio/core/fixtures/sectors/EdariaShop.somnio-sector?raw';
import nordwald from '@somnio/core/fixtures/sectors/Nordwald.somnio-sector?raw';
import nordwiese from '@somnio/core/fixtures/sectors/Nordwiese.somnio-sector?raw';

/** The committed world the server ships, compiled into the bundle so the splash can stage it with no server. */
const SECTOR_FILES: Record<string, string> = {
  EdariaArena: edariaArena,
  EdariaBibliothek: edariaBibliothek,
  EdariaInn: edariaInn,
  EdariaMitte: edariaMitte,
  EdariaShop: edariaShop,
  Nordwald: nordwald,
  Nordwiese: nordwiese,
};

export function splashSectors(): Sector[] {
  return Object.entries(SECTOR_FILES).map(([name, text]) => readSectorFile(text, name));
}
