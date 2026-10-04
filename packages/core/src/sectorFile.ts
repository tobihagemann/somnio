import {
  SOMNIO_PROTOCOL_CONSTANTS,
  WireDecodingError,
  decodeSectorView,
  encodeSectorView,
  isAbsent,
  mapRecords,
  requireFloat,
  requireId,
  requireInt32,
  requireMetres,
  requireNested,
  requireObject,
  requirePositiveMetres,
  requireString,
  requireStringEnum,
  utf8ByteLength,
} from '@somnio/protocol';
import { SOMNIO_CONSTANTS } from './constants.ts';
import { rectContains } from './geometry.ts';
import { heading } from './heading.ts';
import { MONSTER_KIND_IDS } from './monsterKinds.ts';
import { dialogLineFits, dialogSteps } from './npcDialog.ts';
import type { MonsterSpawn, Sector, SectorNPC, SectorSpawn } from './sector.ts';

/**
 * The `.somnio-sector` disk codec: the sector view the wire carries plus the server-side content,
 * as plain JSON with recursively sorted keys, a 2-space indent, and a trailing newline. Defaults
 * are left out (`yaw` and `elevation` at 0, empty record arrays, an unset `spawn`), so an
 * unedited open-and-save is byte-stable.
 *
 * The sector name is never part of the JSON: it is the filename, supplied by the reader.
 */

/** One error type for both directions of the codec. */
export class SectorFileError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = 'SectorFileError';
    this.reason = reason;
  }
}

export function readSectorFile(text: string, name: string): Sector {
  // UTF-8 bytes, not UTF-16 code units.
  const byteCount = utf8ByteLength(text);
  if (byteCount > SOMNIO_CONSTANTS.maxSectorFileBytes) {
    throw new SectorFileError(`sector file size out of range: ${byteCount} bytes`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new SectorFileError(`sector file is not valid JSON: ${String(error)}`);
  }
  try {
    const root = requireObject(parsed, 'sector');
    const view = decodeSectorView({ ...root, name }, 'sector');
    const npcs = mapRecords(root, 'npcs', 'sector', SOMNIO_CONSTANTS.maxSectorNPCs, decodeNPC);
    npcs.forEach((npc, index) => {
      if (!rectContains({ x: 0, z: 0, ...view.size }, npc)) {
        throw new WireDecodingError(`sector.npcs[${index}]`, `stands outside the sector at (${npc.x}, ${npc.z})`);
      }
    });
    return {
      ...view,
      ...(isAbsent(root, 'spawn') ? {} : { spawn: decodeSpawn(requireNested(root, 'spawn', 'sector'), 'sector.spawn') }),
      npcs,
      monsterSpawns: mapRecords(root, 'monsterSpawns', 'sector', SOMNIO_CONSTANTS.maxSectorMonsterSpawns, decodeMonsterSpawn),
    };
  } catch (error) {
    if (error instanceof WireDecodingError) throw new SectorFileError(error.message);
    throw error;
  }
}

function decodeSpawn(container: Record<string, unknown>, path: string): SectorSpawn {
  return {
    x: requireMetres(container, 'x', path),
    z: requireMetres(container, 'z', path),
    facing: heading(requireFloat(container, 'facing', path)),
  };
}

function decodeNPC(container: Record<string, unknown>, path: string): SectorNPC {
  const dialogScript = requireString(container, 'dialogScript', path);
  const oversized = dialogSteps(dialogScript).findIndex((step) => !dialogLineFits(step));
  if (oversized !== -1) {
    throw new WireDecodingError(
      `${path}.dialogScript`,
      `step ${oversized + 1} can exceed ${SOMNIO_PROTOCOL_CONSTANTS.maxSayUTF8Bytes} UTF-8 bytes once spoken`,
    );
  }
  return {
    id: requireId(container, 'id', path),
    name: requireString(container, 'name', path),
    characterModelId: requireString(container, 'characterModelId', path),
    x: requireMetres(container, 'x', path),
    z: requireMetres(container, 'z', path),
    facing: heading(requireFloat(container, 'facing', path)),
    dialogScript,
  };
}

function decodeMonsterSpawn(container: Record<string, unknown>, path: string): MonsterSpawn {
  const maxAlive = requireInt32(container, 'maxAlive', path);
  if (maxAlive < 1 || maxAlive > SOMNIO_CONSTANTS.maxSpawnAlive) {
    throw new WireDecodingError(`${path}.maxAlive`, `expected 1 to ${SOMNIO_CONSTANTS.maxSpawnAlive}, got ${maxAlive}`);
  }
  return {
    id: requireId(container, 'id', path),
    kind: requireStringEnum(container, 'kind', path, MONSTER_KIND_IDS),
    x: requireMetres(container, 'x', path),
    z: requireMetres(container, 'z', path),
    width: requirePositiveMetres(container, 'width', path),
    depth: requirePositiveMetres(container, 'depth', path),
    maxAlive,
  };
}

/**
 * The output is run through `readSectorFile` before it is returned, so the writer can never
 * persist a file its own reader would refuse.
 */
export function writeSectorFile(sector: Sector): string {
  const body: Record<string, unknown> = {
    ...encodeSectorView(sector),
    ...(sector.spawn === undefined ? {} : { spawn: sector.spawn }),
    ...(sector.npcs.length === 0 ? {} : { npcs: sector.npcs }),
    ...(sector.monsterSpawns.length === 0 ? {} : { monsterSpawns: sector.monsterSpawns }),
  };
  delete body['name'];
  const text = `${JSON.stringify(sortedKeys(body), undefined, 2)}\n`;
  readSectorFile(text, sector.name);
  return text;
}

function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (typeof value !== 'object' || value === null) return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, sortedKeys(record[key])]),
  );
}
