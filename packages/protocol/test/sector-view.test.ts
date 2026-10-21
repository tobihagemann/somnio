import { describe, expect, it } from 'vitest';
import { SOMNIO_PROTOCOL_CONSTANTS, WireDecodingError, decodeSectorView, encodeSectorView, markPointBounds, maxMarkRadius } from '../src/index.ts';
import type { SectorView } from '../src/index.ts';

/**
 * The sector shape's own rules: which keys each kind carries, the defaults a reader fills in and a
 * writer leaves out, and the cross-record checks no field-level validator can make.
 */

const outdoor: SectorView = {
  name: 'EdariaSquare',
  kind: 'outdoor',
  origin: { x: 5.12, z: -30.72 },
  size: { width: 40.96, depth: 40.96 },
  ground: {
    backgroundMaterialId: 'grass-meadow',
    marks: [
      {
        id: 'plaza',
        materialId: 'cobble-town',
        opacity: 1,
        shape: {
          kind: 'polygon',
          points: [
            { x: 16, z: 0 },
            { x: 24.96, z: 0 },
            { x: 24.96, z: 20 },
            { x: 16, z: 20 },
          ],
        },
      },
      { id: 'worn', materialId: 'dirt-path', opacity: 0.5, shape: { kind: 'stroke', radius: 1.1, points: [{ x: 19.5, z: 15 }] } },
    ],
  },
  placements: [
    { id: 'townhall', modelId: 'building-townhall', x: 36.8, z: 4.48, yaw: 270, elevation: 0 },
    { id: 'candle-1', modelId: 'candle', x: 12, z: 9.5, yaw: 0, elevation: 0.75 },
  ],
  blockers: [{ id: 'north-cliff', x: 0, z: 0, width: 16, depth: 0.64 }],
  doors: [{ id: 'library', placement: 'townhall', anchor: 'main', target: { sector: 'EdariaLibrary', door: 'exit' } }],
};

const interior: SectorView = {
  name: 'EdariaLibrary',
  kind: 'interior',
  brightness: 75,
  size: { width: 10.24, depth: 7.68 },
  ground: { backgroundMaterialId: 'wood-warm', marks: [] },
  placements: [],
  blockers: [],
  doors: [],
};

function decode(json: Record<string, unknown>): SectorView {
  return decodeSectorView(json, 'sector');
}

describe('omitted defaults', () => {
  it('decodes absent record arrays and marks as empty, absent yaw and elevation as 0, and an absent opacity as 1', () => {
    const decoded = decode({
      name: 'EdariaSquare',
      kind: 'outdoor',
      origin: { x: 0, z: 0 },
      size: { width: 16, depth: 16 },
      ground: { backgroundMaterialId: 'grass-meadow' },
      placements: [{ id: 'well', modelId: 'well', x: 8, z: 8 }],
    });
    expect(decoded.ground.marks).toEqual([]);
    expect(
      decode({
        ...encodeSectorView(outdoor),
        ground: {
          backgroundMaterialId: 'grass-meadow',
          marks: [{ id: 'm', materialId: 'dirt-path', shape: { kind: 'stroke', radius: 1, points: [{ x: 8, z: 8 }] } }],
        },
      }).ground.marks[0]!.opacity,
    ).toBe(1);
    expect(decoded.blockers).toEqual([]);
    expect(decoded.doors).toEqual([]);
    expect(decoded.placements).toEqual([{ id: 'well', modelId: 'well', x: 8, z: 8, yaw: 0, elevation: 0 }]);
  });

  it('encodes without empty arrays or marks, a zero yaw or elevation, a whole opacity, or the key of the other kind', () => {
    expect(encodeSectorView(interior)).toEqual({
      name: 'EdariaLibrary',
      kind: 'interior',
      brightness: 75,
      size: { width: 10.24, depth: 7.68 },
      ground: { backgroundMaterialId: 'wood-warm' },
    });
    const encoded = encodeSectorView(outdoor);
    expect('brightness' in encoded).toBe(false);
    expect(encoded['placements']).toEqual([
      { id: 'townhall', modelId: 'building-townhall', x: 36.8, z: 4.48, yaw: 270 },
      { id: 'candle-1', modelId: 'candle', x: 12, z: 9.5, elevation: 0.75 },
    ]);
    const marks = (encoded['ground'] as { marks: Record<string, unknown>[] }).marks;
    expect(marks.map((mark) => 'opacity' in mark)).toEqual([false, true]);
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
  const dab = (id: string, x = 8, z = 4): Record<string, unknown> => ({
    id,
    materialId: 'dirt-path',
    shape: { kind: 'stroke', radius: 0.5, points: [{ x, z }] },
  });
  const withMarks = (marks: unknown[]): Record<string, unknown> => ({ ...interiorJSON, ground: { backgroundMaterialId: 'wood-warm', marks } });
  const stroke = (radius: number, points: { x: number; z: number }[]): Record<string, unknown> =>
    withMarks([{ id: 'm', materialId: 'dirt-path', shape: { kind: 'stroke', radius, points } }]);
  const placement = { id: 'p', modelId: 'rug', x: 0, z: 0 };
  const door = { id: 'd', placement: 'townhall', anchor: 'main', target: { sector: 'EdariaLibrary', door: 'exit' } };
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
    ['a record without an id', { ...interiorJSON, blockers: [{ x: 0, z: 0, width: 1, depth: 1 }] }, /blockers\[0\]\.id/],
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
    ['a sector without a ground', { ...interiorJSON, ground: undefined }, /sector\.ground: expected an object/],
    [
      'more ground marks than the cap',
      withMarks(Array.from({ length: SOMNIO_PROTOCOL_CONSTANTS.maxSectorGroundMarks + 1 }, (_, index) => dab(`m-${index}`))),
      /sector\.ground\.marks: exceeds 512 records \(got 513\)/,
    ],
    [
      'more ground points than the cap, counted across the marks',
      withMarks([
        { id: 'a', materialId: 'dirt-path', shape: { kind: 'stroke', radius: 0.5, points: Array.from({ length: 4096 }, () => ({ x: 5, z: 3 })) } },
        { id: 'b', materialId: 'dirt-path', shape: { kind: 'stroke', radius: 0.5, points: Array.from({ length: 4097 }, () => ({ x: 5, z: 3 })) } },
      ]),
      /sector\.ground\.marks: exceeds 8192 points in total \(got 8193\)/,
    ],
    ['a mark painting past the sector', stroke(0.5, [{ x: -1, z: 3 }]), /ground\.marks\[0\]\.shape\.points\[0\]: paints more than 1\.5 metres past the sector/],
    ['a stroke whose radius carries its paint past the sector', stroke(2, [{ x: 0.5, z: 3 }]), /ground\.marks\[0\]\.shape\.points\[0\]: paints more/],
    ['a radius above 10 metres', stroke(10.5, [{ x: 5, z: 3 }]), /shape\.radius: expected 0 to 10 metres/],
    ['a negative radius', stroke(-0.1, [{ x: 5, z: 3 }]), /shape\.radius: expected 0 to 10 metres/],
    ['an opacity above 1', withMarks([{ ...dab('m'), opacity: 1.1 }]), /marks\[0\]\.opacity: expected a number from 0 to 1/],
    ['a negative opacity', withMarks([{ ...dab('m'), opacity: -0.1 }]), /marks\[0\]\.opacity: expected a number from 0 to 1/],
    ['a stroke with no points', stroke(0.5, []), /shape\.points: a stroke needs at least 1 points, got 0/],
    [
      'a polygon with two points',
      withMarks([
        {
          id: 'm',
          materialId: 'dirt-path',
          shape: {
            kind: 'polygon',
            points: [
              { x: 1, z: 1 },
              { x: 2, z: 2 },
            ],
          },
        },
      ]),
      /shape\.points: a polygon needs at least 3 points, got 2/,
    ],
    [
      'an unknown shape',
      withMarks([{ id: 'm', materialId: 'dirt-path', shape: { kind: 'circle', points: [{ x: 1, z: 1 }] } }]),
      /shape\.kind: unknown value "circle"/,
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
      { ...outdoorJSON, doors: [{ id: 'library', placement: 'tavern', anchor: 'main', target: { sector: 'EdariaLibrary', door: 'exit' } }] },
      /doors\[0\]\.placement: no placement "tavern"/,
    ],
    [
      'a door whose target door is not an id',
      { ...outdoorJSON, doors: [{ id: 'library', placement: 'townhall', anchor: 'main', target: { sector: 'EdariaLibrary', door: '' } }] },
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
    });
    expect([decoded.placements.length, decoded.blockers.length, decoded.doors.length]).toEqual([4096, 4096, 4096]);
  });

  it('accepts the ground at its caps', () => {
    const marks = Array.from({ length: SOMNIO_PROTOCOL_CONSTANTS.maxSectorGroundMarks }, (_, index) => ({
      ...dab(`m-${index}`),
      shape: {
        kind: 'stroke',
        radius: 0.5,
        points: Array.from({ length: SOMNIO_PROTOCOL_CONSTANTS.maxSectorGroundPoints / SOMNIO_PROTOCOL_CONSTANTS.maxSectorGroundMarks }, () => ({
          x: 5,
          z: 3,
        })),
      },
    }));
    expect(decode(withMarks(marks)).ground.marks).toHaveLength(512);
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
    const json = { ...withMarks([dab('shared')]), blockers: [{ ...blocker, id: 'shared' }] };
    expect(() => decode(json)).not.toThrow();
  });

  /** A brightness the decoder would refuse must survive encoding, so a writer that validates its own output refuses it too. */
  it('encodes a brightness set on an outdoor sector rather than dropping it', () => {
    expect(() => decode(encodeSectorView({ ...outdoor, brightness: 70 }))).toThrow(/not allowed on an outdoor sector/);
  });
});

/**
 * A mark's points are bounded so its paint reaches at most 1.5 m past the sector: a stroke's
 * points stay its radius plus 0.675 m, less 1.5 m, inside, and a polygon's within 0.825 m outside.
 */
describe('where a mark may lie', () => {
  const size = { width: 40.96, depth: 40.96 };

  it("insets a 3.2 m road's points 0.775 m and lets a polygon's lie 0.825 m outside", () => {
    expect(markPointBounds(size, { kind: 'stroke', radius: 1.6 })).toEqual({
      x: expect.closeTo(0.775, 9),
      z: expect.closeTo(0.775, 9),
      width: expect.closeTo(39.41, 9),
      depth: expect.closeTo(39.41, 9),
    });
    expect(markPointBounds(size, { kind: 'polygon' })).toEqual({
      x: expect.closeTo(-0.825, 9),
      z: expect.closeTo(-0.825, 9),
      width: expect.closeTo(42.61, 9),
      depth: expect.closeTo(42.61, 9),
    });
  });

  it('accepts points on the bound and refuses them a millimetre past it', () => {
    const bounds = markPointBounds(interior.size, { kind: 'stroke', radius: 1.6 })!;
    const json = (x: number): Record<string, unknown> => ({
      ...encodeSectorView(interior),
      ground: {
        backgroundMaterialId: 'wood-warm',
        marks: [{ id: 'road', materialId: 'dirt-path', shape: { kind: 'stroke', radius: 1.6, points: [{ x, z: 3 }] } }],
      },
    });
    expect(() => decode(json(bounds.x))).not.toThrow();
    expect(() => decode(json(bounds.x + bounds.width))).not.toThrow();
    expect(() => decode(json(bounds.x - 0.001))).toThrow(/paints more than 1\.5 metres/);
  });

  /** In a 5.12 m room the widest stroke is about 3.39 m, and past it there is nowhere for its points to lie. */
  it('has no bound for a stroke wider than the room takes', () => {
    const room = { width: 5.12, depth: 5.12 };
    expect(maxMarkRadius(room)).toBeCloseTo(3.385, 9);
    expect(markPointBounds(room, { kind: 'stroke', radius: maxMarkRadius(room) })).toBeDefined();
    expect(markPointBounds(room, { kind: 'stroke', radius: maxMarkRadius(room) + 0.01 })).toBeUndefined();
    expect(maxMarkRadius(size)).toBe(10);
  });
});
