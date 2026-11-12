import { RARITIES, ROLES } from '@somnio/protocol';
import { describe, expect, it } from 'vitest';
import { affix } from '../src/affixes.ts';
import { buildSpaceCollision, isLegalMove } from '../src/collision.ts';
import { SOMNIO_CONSTANTS } from '../src/constants.ts';
import { hashString, seededSequence } from '../src/hash.ts';
import { baseItem } from '../src/items.ts';
import { distance } from '../src/geometry.ts';
import { headingFromVector } from '../src/heading.ts';
import { DROP_ODDS, PICKUP_REACH, SCATTER_DISTANCE, droppableBases, rollDrops, scatterLandings, throwLanding, usableBy } from '../src/loot.ts';
import { MONSTER_KINDS } from '../src/monsterKinds.ts';
import { PATHFINDING } from '../src/pathfinding.ts';
import { TEST_REGISTRY, outdoorSector } from './support/worldFixture.ts';

const SAMPLES = 20_000;

describe.each(['nightmare', 'elite', 'boss'] as const)('rollDrops for a foe of rank %s', (rank) => {
  const odds = DROP_ODDS[rank];
  const random = seededSequence(hashString(`drops ${rank}`));
  const rolled = Array.from({ length: SAMPLES }, () => rollDrops(1, rank, undefined, random));
  const drops = rolled.flat();

  it("drops on each roll by the rank's chance, at most once a roll", () => {
    expect(rolled.every((found) => found.length <= odds.rolls)).toBe(true);
    expect(drops.length / SAMPLES).toBeCloseTo(odds.rolls * odds.chance, 1);
  });

  it('weighs each rarity as the odds say', () => {
    const total = RARITIES.reduce((sum, rarity) => sum + odds.rarities[rarity], 0);
    for (const rarity of RARITIES) {
      expect(drops.filter((drop) => drop.rarity === rarity).length / drops.length, rarity).toBeCloseTo(odds.rarities[rarity] / total, 1);
    }
  });

  it('drops every base of the tier at the tier, and never the Moonstone', () => {
    expect(new Set(drops.map((drop) => drop.baseId))).toEqual(new Set(droppableBases(1)));
    expect(droppableBases(1)).not.toContain('moonstone');
    expect(drops.every((drop) => drop.tier === 1 && baseItem(drop.baseId).tier === 1)).toBe(true);
  });
});

describe('rollDrops for a foe of tier 3', () => {
  const random = seededSequence(hashString('drops tier 3'));
  const drops = Array.from({ length: SAMPLES }, () => rollDrops(3, 'elite', undefined, random)).flat();

  it('drops the bases of tier 3 and of every lower tier, and never the Moonstone', () => {
    expect(new Set(drops.map((drop) => drop.baseId))).toEqual(new Set(droppableBases(3)));
    expect(new Set(droppableBases(3).map((baseId) => baseItem(baseId).tier))).toEqual(new Set([1, 3]));
    expect(droppableBases(3)).not.toContain('moonstone');
  });

  it("rolls every drop at tier 3, whatever its base's tier, with tier 3's stat lines", () => {
    expect(drops.every((drop) => drop.tier === 3)).toBe(true);
    for (const { affixId, value } of drops.flatMap((drop) => drop.affixes)) {
      const [least, most] = affix(affixId).tiers[3]!;
      expect(value >= least && value <= most, `${affixId} ${value}`).toBe(true);
    }
  });
});

describe('DROP_ODDS', () => {
  const rareShare = (rank: keyof typeof DROP_ODDS): number => {
    const { rarities } = DROP_ODDS[rank];
    return rarities.rare / RARITIES.reduce((sum, rarity) => sum + rarities[rarity], 0);
  };

  it('gives an elite more drops than an ordinary nightmare, and more of them rare', () => {
    expect(DROP_ODDS.elite.rolls * DROP_ODDS.elite.chance).toBeGreaterThan(DROP_ODDS.nightmare.rolls * DROP_ODDS.nightmare.chance);
    expect(rareShare('elite')).toBeGreaterThan(rareShare('nightmare'));
  });

  it('gives a boss more drops than an elite, and more of them rare', () => {
    expect(DROP_ODDS.boss.rolls * DROP_ODDS.boss.chance).toBeGreaterThan(DROP_ODDS.elite.rolls * DROP_ODDS.elite.chance);
    expect(rareShare('boss')).toBeGreaterThan(rareShare('elite'));
  });
});

describe('smart loot', () => {
  it('keeps from each role the off hands its kit has no use for', () => {
    const unusable = (role: (typeof ROLES)[number] | undefined) => droppableBases(3).filter((baseId) => !usableBy(baseId, role));
    expect(unusable('fighter')).toEqual(['wand', 'skull-staff']);
    expect(unusable('healer')).toEqual(['buckler', 'shield', 'wand', 'iron-buckler', 'skull-shield', 'skull-staff']);
    expect(unusable('mystic')).toEqual(['buckler', 'shield', 'iron-buckler', 'skull-shield']);
    expect(unusable(undefined)).toEqual([]);
  });

  it.each([...new Set(Object.values(MONSTER_KINDS).map((kind) => kind.tier))])(
    'has bases of tier %i for every role and none, so a roll always finds one',
    (tier) => {
      const bases = droppableBases(tier);
      expect(bases.length).toBeGreaterThan(0);
      for (const role of [...ROLES, undefined]) expect(bases.filter((baseId) => usableBy(baseId, role)).length).toBeGreaterThan(0);
    },
  );

  it.each(ROLES)('rolls a %s what they cannot use only by the open share', (role) => {
    const random = seededSequence(hashString(`drops-${role}`));
    const drops = Array.from({ length: SAMPLES }, () => rollDrops(3, 'nightmare', role, random)).flat();
    const bases = droppableBases(3);
    const unusable = bases.filter((baseId) => !usableBy(baseId, role));
    const rate = drops.filter((drop) => unusable.includes(drop.baseId)).length / drops.length;
    expect(Math.abs(rate - (DROP_ODDS.nightmare.openShare * unusable.length) / bases.length)).toBeLessThan(0.01);
  });
});

describe('PICKUP_REACH', () => {
  /** A path stops where a walker clears a body's disk, which lies up to half a cell's diagonal off the cell it ends on. */
  it('reaches a drop under the widest nightmare from where a path stops beside it', () => {
    const widest = Math.max(...Object.values(MONSTER_KINDS).map((kind) => kind.radius));
    const pathStop = widest + SOMNIO_CONSTANTS.playerRadius + PATHFINDING.bodyMargin + (PATHFINDING.cell * Math.SQRT2) / 2;
    expect(PICKUP_REACH).toBeGreaterThan(pathStop);
  });
});

describe('throwLanding', () => {
  /** A wall across the throw east from (5, 10), with a gap in it an item passes through and a body does not. */
  const gapped = buildSpaceCollision(
    {
      id: 'outdoors',
      sectors: [
        outdoorSector(
          'Field',
          { x: 0, z: 0 },
          {
            blockers: [
              { id: 'north', x: 5.4, z: 0, width: 0.2, depth: 9.85 },
              { id: 'south', x: 5.4, z: 10.15, width: 0.2, depth: 9.85 },
            ],
          },
        ),
      ],
    },
    TEST_REGISTRY,
  );

  it('throws through a gap no body passes only as far as the thrower can come within pickup reach of it', () => {
    // Thrown further than the game throws, so the gap rather than the distance stops it.
    const from = { x: 5, z: 10 };
    const distance = 2;
    const landing = throwLanding(gapped, from, 90, distance, []);
    expect(landing.x).toBeGreaterThan(5.6);
    expect(landing.x).toBeLessThan(from.x + distance);
    expect(isLegalMove(gapped, from, { x: landing.x - PICKUP_REACH, z: 10 }, SOMNIO_CONSTANTS.playerRadius, [])).toBe(true);
  });
});

describe('scatterLandings', () => {
  const FROM = { x: 10, z: 10 };
  const random = seededSequence(hashString('scatter'));
  const open = buildSpaceCollision({ id: 'outdoors', sectors: [outdoorSector('Field', { x: 0, z: 0 })] }, TEST_REGISTRY);

  it('fans the drops out round where the nightmare stood, no two on one heading, each the scatter distance out in open ground', () => {
    for (let count = 1; count <= 6; count += 1) {
      for (let sample = 0; sample < 200; sample += 1) {
        const landings = scatterLandings(open, FROM, count, [], random);
        expect(landings).toHaveLength(count);
        for (const landing of landings) {
          expect(distance(FROM, landing)).toBeGreaterThanOrEqual(SCATTER_DISTANCE.min - 1e-9);
          expect(distance(FROM, landing)).toBeLessThanOrEqual(SCATTER_DISTANCE.max + 1e-9);
        }
        const headings = landings.map((landing) => headingFromVector(landing.x - FROM.x, landing.z - FROM.z));
        for (const [index, heading] of headings.entries()) {
          for (const other of headings.slice(index + 1)) {
            const apart = Math.abs(((heading - other + 540) % 360) - 180);
            expect(apart).toBeGreaterThanOrEqual(180 / count - 1e-6);
          }
        }
      }
    }
  });

  it('lands every drop short of the walls round where the nightmare stood', () => {
    /** Walls closer than the scatter distance on every side. */
    const walls = [
      { id: 'north', x: 8, z: 8.6, width: 4, depth: 0.2 },
      { id: 'south', x: 8, z: 11.2, width: 4, depth: 0.2 },
      { id: 'west', x: 8.6, z: 8, width: 0.2, depth: 4 },
      { id: 'east', x: 11.2, z: 8, width: 0.2, depth: 4 },
    ];
    const boxed = buildSpaceCollision({ id: 'outdoors', sectors: [outdoorSector('Field', { x: 0, z: 0 }, { blockers: walls })] }, TEST_REGISTRY);
    for (let sample = 0; sample < 200; sample += 1) {
      for (const landing of scatterLandings(boxed, FROM, 4, [], random)) {
        expect(Math.abs(landing.x - FROM.x)).toBeLessThan(1.2);
        expect(Math.abs(landing.z - FROM.z)).toBeLessThan(1.2);
      }
    }
  });
});
