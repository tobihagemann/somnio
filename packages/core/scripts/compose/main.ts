// Composes the outdoor lands of the committed world from `rules.ts` and writes them back.
//
// Run by hand from the repository root, after changing a land's rules or seed:
//
//     node packages/core/scripts/compose/main.ts [sectorsDir]
//
// The sectors directory defaults to the committed fixtures. Every outdoor sector is composed in
// one run; records whose ids do not start `gen-` are kept as they are.

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundledModelRegistry } from '../../src/modelRegistry.ts';
import { readSectorFile, writeSectorFile } from '../../src/sectorFile.ts';
import { composeSectors } from './composeSectors.ts';
import { LANDS } from './rules.ts';

const directory = process.argv[2] ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../fixtures/sectors');
const names = readdirSync(directory)
  .filter((file) => file.endsWith('.somnio-sector'))
  .map((file) => file.slice(0, -'.somnio-sector'.length));
const sectors = names.map((name) => readSectorFile(readFileSync(resolve(directory, `${name}.somnio-sector`), 'utf8'), name));
for (const sector of composeSectors(sectors, LANDS, bundledModelRegistry())) {
  if (sector.kind !== 'outdoor') continue;
  writeFileSync(resolve(directory, `${sector.name}.somnio-sector`), writeSectorFile(sector));
  process.stdout.write(`${sector.name}: ${sector.placements.length} placements, ${sector.ground.marks.length} marks\n`);
}
