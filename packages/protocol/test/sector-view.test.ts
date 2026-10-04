import { describe, expect, it } from 'vitest';
import { SOMNIO_PROTOCOL_CONSTANTS, WireDecodingError, decodeSectorView, encodeSectorView } from '../src/index.ts';
import type { SectorView } from '../src/index.ts';

/**
 * The sector shape's own rules: which keys each kind carries, the defaults a reader fills in and a
 * writer leaves out, and the cross-record checks no field-level validator can make.
 */

const outdoor: SectorView = {
  name: 'EdariaMitte',
  kind: 'outdoor',
  origin: { x: 5.12, z: -30.72 },
  size: { width: 40.96, depth: 40.96 },
  floorMaterialId: 'grass-meadow',
  floorPatches: [{ id: 'patch-1', floorMaterialId: 'cobble-town', x: 16, z: 0, width: 8.96, depth: 20 }],
  placements: [
    { id: 'townhall', modelId: 'building-townhall', x: 36.8, z: 4.48, yaw: 270, elevation: 0 },
    { id: 'candle-1', modelId: 'candle', x: 12, z: 9.5, yaw: 0, elevation: 0.75 },
  ],
  blockers: [{ id: 'north-cliff', x: 0, z: 0, width: 16, depth: 0.64 }],
  doors: [{ id: 'library', placement: 'townhall', anchor: 'main', target: { sector: 'EdariaBibliothek', door: 'exit' } }],
};

const interior: SectorView = {
  name: 'EdariaBibliothek',
  kind: 'interior',
  brightness: 75,
  size: { width: 10.24, depth: 7.68 },
  floorMaterialId: 'wood-warm',
  floorPatches: [],
  placements: [],
  blockers: [],
  doors: [],
};

function decode(json: Record<string, unknown>): SectorView {
  return decodeSectorView(json, 'sector');
}

describe('omitted defaults', () => {
  it('decodes absent record arrays as empty and absent yaw and elevation as 0', () => {
    const decoded = decode({
      name: 'EdariaMitte',
      kind: 'outdoor',
      origin: { x: 0, z: 0 },
      size: { width: 16, depth: 16 },
      floorMaterialId: 'grass-meadow',
      placements: [{ id: 'well', modelId: 'well', x: 8, z: 8 }],
    });
    expect(decoded.floorPatches).toEqual([]);
    expect(decoded.blockers).toEqual([]);
    expect(decoded.doors).toEqual([]);
    expect(decoded.placements).toEqual([{ id: 'well', modelId: 'well', x: 8, z: 8, yaw: 0, elevation: 0 }]);
  });

  it('encodes without empty arrays, a zero yaw or elevation, or the key of the other kind', () => {
    expect(encodeSectorView(interior)).toEqual({
      name: 'EdariaBibliothek',
      kind: 'interior',
      brightness: 75,
      size: { width: 10.24, depth: 7.68 },
      floorMaterialId: 'wood-warm',
    });
    const encoded = encodeSectorView(outdoor);
    expect('brightness' in encoded).toBe(false);
    expect(encoded['placements']).toEqual([
      { id: 'townhall', modelId: 'building-townhall', x: 36.8, z: 4.48, yaw: 270 },
      { id: 'candle-1', modelId: 'candle', x: 12, z: 9.5, elevation: 0.75 },
    ]);
  });

  it.each([outdoor, interior])('decodes the encoded form of an $kind sector back to the same value', (view) => {
    expect(decode(encodeSectorView(view))).toEqual(view);
  });

  it('decodes the full form the wire carries to the same value', () => {
    expect(decode(JSON.parse(JSON.stringify(outdoor)) as Record<string, unknown>)).toEqual(outdoor);
  });
});

describe('rejections', () => {
  const outdoorJSON = encodeSectorView(outdoor);
  const interiorJSON = encodeSectorView(interior);
  const blocker = { id: 'b', x: 0, z: 0, width: 1, depth: 1 };
  const patch = { ...blocker, floorMaterialId: 'cobble-town' };
  const placement = { id: 'p', modelId: 'rug', x: 0, z: 0 };
  const door = { id: 'd', placement: 'townhall', anchor: 'main', target: { sector: 'EdariaBibliothek', door: 'exit' } };
  const records = <T extends { id: string }>(count: number, record: T): T[] => Array.from({ length: count }, (_, index) => ({ ...record, id: `r-${index}` }));
  const atCapName = 'a'.repeat(SOMNIO_PROTOCOL_CONSTANTS.maxSectorNameUTF8Bytes);

  it.each<[string, Record<string, unknown>, RegExp]>([
    ['an unknown kind', { ...outdoorJSON, kind: 'cave' }, /kind: unknown value "cave"/],
    ['an outdoor sector without an origin', { ...outdoorJSON, origin: undefined }, /sector\.origin: expected an object, got nothing/],
    ['an outdoor sector with a brightness', { ...outdoorJSON, brightness: 70 }, /sector\.brightness: not allowed on an outdoor sector/],
    ['an interior sector without a brightness', { ...interiorJSON, brightness: undefined }, /sector\.brightness: expected Int32, got nothing/],
    ['an interior sector with an origin', { ...interiorJSON, origin: { x: 0, z: 0 } }, /sector\.origin: not allowed on an interior sector/],
    ['a brightness above 100', { ...interiorJSON, brightness: 101 }, /brightness: expected a percentage/],
    ['a negative brightness', { ...interiorJSON, brightness: -1 }, /brightness: expected a percentage/],
    ['a fractional brightness', { ...interiorJSON, brightness: 70.5 }, /brightness: expected Int32, got fractional/],
    ['a zero width', { ...interiorJSON, size: { width: 0, depth: 8 } }, /size\.width: expected a positive length/],
    ['a depth past the extent cap', { ...interiorJSON, size: { width: 8, depth: 512.5 } }, /size\.depth: exceeds 512 metres/],
    ['an origin past the coordinate cap', { ...outdoorJSON, origin: { x: 10_001, z: 0 } }, /origin\.x: exceeds 10000 metres/],
    ['a record id outside the id alphabet', { ...interiorJSON, blockers: [{ ...blocker, id: 'North_Cliff' }] }, /blockers\[0\]\.id: expected an id/],
    ['a record without an id', { ...interiorJSON, floorPatches: [{ floorMaterialId: 'x', x: 0, z: 0, width: 1, depth: 1 }] }, /floorPatches\[0\]\.id/],
    ['a duplicate id within an array', { ...interiorJSON, blockers: [blocker, blocker] }, /blockers\[1\]\.id: duplicate id "b"/],
    ['a blocker with a negative depth', { ...interiorJSON, blockers: [{ ...blocker, depth: -1 }] }, /blockers\[0\]\.depth: expected a positive length/],
    ['a non-finite yaw', { ...interiorJSON, placements: [{ id: 'p', modelId: 'rug', x: 0, z: 0, yaw: Infinity }] }, /placements\[0\]\.yaw/],
    [
      'more blockers than the cap',
      { ...interiorJSON, blockers: records(SOMNIO_PROTOCOL_CONSTANTS.maxSectorBlockers + 1, blocker) },
      /sector\.blockers: exceeds 4096 records \(got 4097\)/,
    ],
    [
      'more placements than the cap',
      { ...interiorJSON, placements: records(SOMNIO_PROTOCOL_CONSTANTS.maxSectorPlacements + 1, placement) },
      /sector\.placements: exceeds 4096 records \(got 4097\)/,
    ],
    [
      'more doors than the cap',
      { ...outdoorJSON, doors: records(SOMNIO_PROTOCOL_CONSTANTS.maxSectorDoors + 1, door) },
      /sector\.doors: exceeds 4096 records \(got 4097\)/,
    ],
    [
      'more floor patches than the cap',
      { ...interiorJSON, floorPatches: records(SOMNIO_PROTOCOL_CONSTANTS.maxSectorFloorPatches + 1, patch) },
      /sector\.floorPatches: exceeds 4096 records \(got 4097\)/,
    ],
    ['a name past the sector name cap', { ...interiorJSON, name: `${atCapName}a` }, /sector\.name: exceeds 251 UTF-8 bytes/],
    ['an empty name', { ...interiorJSON, name: '' }, /sector\.name: expected a non-empty string/],
    [
      'a door whose target sector is past the sector name cap',
      { ...outdoorJSON, doors: [{ ...door, target: { sector: `${atCapName}a`, door: 'exit' } }] },
      /doors\[0\]\.target\.sector: exceeds 251 UTF-8 bytes/,
    ],
    [
      'a door on a placement the sector does not have',
      { ...outdoorJSON, doors: [{ id: 'library', placement: 'tavern', anchor: 'main', target: { sector: 'EdariaBibliothek', door: 'exit' } }] },
      /doors\[0\]\.placement: no placement "tavern"/,
    ],
    [
      'a door whose target door is not an id',
      { ...outdoorJSON, doors: [{ id: 'library', placement: 'townhall', anchor: 'main', target: { sector: 'EdariaBibliothek', door: '' } }] },
      /doors\[0\]\.target\.door: expected an id/,
    ],
  ])('rejects %s', (_case, json, expected) => {
    expect(() => decode(json)).toThrow(WireDecodingError);
    expect(() => decode(json)).toThrow(expected);
  });

  it('accepts every record array at its cap', () => {
    const decoded = decode({
      ...outdoorJSON,
      placements: [...(outdoorJSON['placements'] as unknown[]), ...records(SOMNIO_PROTOCOL_CONSTANTS.maxSectorPlacements - 2, placement)],
      blockers: records(SOMNIO_PROTOCOL_CONSTANTS.maxSectorBlockers, blocker),
      doors: records(SOMNIO_PROTOCOL_CONSTANTS.maxSectorDoors, door),
      floorPatches: records(SOMNIO_PROTOCOL_CONSTANTS.maxSectorFloorPatches, patch),
    });
    expect([decoded.placements.length, decoded.blockers.length, decoded.doors.length, decoded.floorPatches.length]).toEqual([4096, 4096, 4096, 4096]);
  });

  it('accepts a sector name and a door target sector at the cap, and a door that names no target sector yet', () => {
    const doors = [
      { ...door, target: { sector: atCapName, door: 'exit' } },
      { ...door, id: 'untargeted', target: { sector: '', door: 'exit' } },
    ];
    const decoded = decode({ ...outdoorJSON, name: atCapName, doors });
    expect(decoded.name).toBe(atCapName);
    expect(decoded.doors.map((candidate) => candidate.target.sector)).toEqual([atCapName, '']);
  });

  /** The same id may appear in two arrays: uniqueness is per array, which is what lets a door and its placement share a name. */
  it('accepts one id reused across different arrays', () => {
    const json = { ...interiorJSON, blockers: [{ ...blocker, id: 'shared' }], floorPatches: [{ ...blocker, id: 'shared', floorMaterialId: 'cobble-town' }] };
    expect(() => decode(json)).not.toThrow();
  });

  /** A brightness the decoder would refuse must survive encoding, so a writer that validates its own output refuses it too. */
  it('encodes a brightness set on an outdoor sector rather than dropping it', () => {
    expect(() => decode(encodeSectorView({ ...outdoor, brightness: 70 }))).toThrow(/not allowed on an outdoor sector/);
  });
});
