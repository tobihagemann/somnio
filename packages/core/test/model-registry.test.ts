import { ROLES } from '@somnio/protocol';
import { describe, expect, it } from 'vitest';
import {
  BODY_REGIONS,
  LIGHT_KINDS,
  ModelRegistryError,
  PLACEHOLDER_REGISTRY,
  allModelEntries,
  bundledModelRegistry,
  groundModelStem,
  handModelStem,
  missingClips,
  modelForCharacter,
  modelForObjectId,
  objectModel,
  parseModelRegistry,
  peopleBody,
  peopleScale,
  trophyModelStem,
  wardrobeRow,
  wornStem,
} from '../src/modelRegistry.ts';
import { BASE_ITEMS } from '../src/items.ts';
import { MONSTER_KIND_IDS, MONSTER_KINDS } from '../src/monsterKinds.ts';
import { PEOPLES } from '../src/people.ts';
import registryJSON from '../data/ModelRegistry.json' with { type: 'json' };
import { loadSectorFixtures } from './support/sectorFixture.ts';

/**
 * Parses the committed registry: one file describes the pack for the browser, the editor, the
 * server's collision, and the asset pipeline's gates.
 */

describe('the committed registry parses', () => {
  const registry = parseModelRegistry(registryJSON);

  it('is what bundledModelRegistry resolves', () => {
    expect(bundledModelRegistry()).toEqual(registry);
    expect(bundledModelRegistry()).not.toEqual(PLACEHOLDER_REGISTRY);
  });

  it('draws each people in its own body, at its own scale', () => {
    expect(PEOPLES.map((people) => modelForCharacter(registry, peopleBody(registry, people) ?? '')?.stem)).toEqual([
      'DreamerVigils',
      'DreamerSopors',
      'DreamerUmbrae',
      'DreamerLumina',
    ]);
    for (const people of PEOPLES) {
      const model = modelForCharacter(registry, peopleBody(registry, people) ?? '');
      expect(model?.expectedClips).toEqual(modelForCharacter(registry, 'dreamer')?.expectedClips);
    }
    expect(peopleScale(registry, 'sopors')).toEqual([1.27, 1.18, 1.13]);
    expect(peopleBody(registry, 'giants')).toBeUndefined();
  });

  it('resolves the NPC and monster models by id', () => {
    expect(modelForCharacter(registry, 'libus')?.stem).toBe('Libus');
    expect(modelForCharacter(registry, 'merchant')?.stem).toBe('Merchant');
    expect(modelForCharacter(registry, 'fighter-master')?.stem).toBe('FighterMaster');
    expect(modelForCharacter(registry, 'healer-master')?.stem).toBe('HealerMaster');
    expect(modelForCharacter(registry, 'mystic-master')?.stem).toBe('MysticMaster');
    expect(modelForCharacter(registry, 'ghost')?.stem).toBe('Ghost');
    expect(modelForCharacter(registry, 'wolf')?.stem).toBe('ForestWolf');
    expect(modelForCharacter(registry, 'boar')?.stem).toBe('ForestBoar');
    expect(modelForCharacter(registry, 'bogey')?.stem).toBe('ForestBogey');
    expect(modelForCharacter(registry, 'skeleton-warrior')?.stem).toBe('SkeletonWarrior');
    expect(modelForCharacter(registry, 'skeleton-minion')?.stem).toBe('SkeletonMinion');
    expect(modelForCharacter(registry, 'necromancer')?.stem).toBe('Necromancer');
  });

  it('returns undefined for an unmapped character so the loader renders a placeholder', () => {
    expect(modelForCharacter(registry, 'not-a-character')).toBeUndefined();
  });

  it('resolves object ids', () => {
    expect(modelForObjectId(registry, 'timber-room-threshold')?.stem).toBe('TimberRoomThreshold');
    expect(modelForObjectId(registry, 'stone-wall-corner')?.stem).toBe('StoneWallCorner');
    expect(modelForObjectId(registry, 'not-a-prop')).toBeUndefined();
  });

  /**
   * An unmapped id renders a placeholder rather than failing the load, so this is the only
   * detector for a registry edit that orphans an id a committed sector or a monster kind
   * references.
   */
  it('resolves every model id the committed sectors and the monster kinds reference', () => {
    const unresolved: string[] = [];
    for (const sector of loadSectorFixtures()) {
      for (const placement of sector.placements) {
        if (objectModel(registry, placement.modelId) === undefined) unresolved.push(`${sector.name}: placement ${placement.modelId}`);
      }
      for (const npc of sector.npcs) {
        if (modelForCharacter(registry, npc.characterModelId) === undefined) unresolved.push(`${sector.name}: npc ${npc.characterModelId}`);
      }
    }
    for (const kind of Object.values(MONSTER_KINDS)) {
      if (modelForCharacter(registry, kind.characterModelId) === undefined) unresolved.push(`monster kind ${kind.characterModelId}`);
    }
    expect(unresolved).toEqual([]);
  });

  /** An item with no hand model draws nothing in the hand, so a base added without one would go unseen. */
  it('gives every item a hand holds a hand model, and none to anything worn elsewhere', () => {
    for (const [baseId, base] of Object.entries(BASE_ITEMS)) {
      const held = base.slot === 'mainHand' || base.slot === 'offHand';
      expect(handModelStem(registry, baseId) !== undefined, baseId).toBe(held);
    }
    expect(handModelStem(registry, 'sword')).toBe('HandSword');
  });

  /** A drop of an item with no ground model draws its name alone, so a base added without one would lie unseen. */
  it('gives every item that can drop a ground model, and none to the Moonstone, which never drops', () => {
    for (const [baseId, base] of Object.entries(BASE_ITEMS)) {
      const drops = !('trialOnly' in base);
      expect(groundModelStem(registry, baseId) !== undefined, baseId).toBe(drops);
    }
    expect(groundModelStem(registry, 'cap')).toBe('GroundCap');
  });

  it('names the body regions a worn piece covers', () => {
    expect(BODY_REGIONS).toEqual(['BootL', 'BootR', 'Crown', 'Face', 'HandL', 'HandR', 'SleeveL', 'SleeveR', 'ThighL', 'ThighR', 'Torso']);
  });

  it("wears a bracelet on each wrist as that wrist's own piece", () => {
    for (let tier = 1; tier <= 5; tier += 1) {
      const row = wardrobeRow(registry, 'bracelet', tier)!;
      for (const people of PEOPLES) {
        expect(wornStem(row, people, 'bracelet1')).toBe(`WearBraceletT${tier}Left`);
        expect(wornStem(row, people, 'bracelet2')).toBe(`WearBraceletT${tier}Right`);
      }
    }
  });

  it('fits a piece to a people where the design is fitted, and gives every people the one piece otherwise', () => {
    const tunic = wardrobeRow(registry, 'tunic', 3)!;
    expect(PEOPLES.map((people) => wornStem(tunic, people, 'chest'))).toEqual(['WearTunicT3', 'WearTunicT3Sopors', 'WearTunicT3Umbrae', 'WearTunicT3Lumina']);
    const boots = wardrobeRow(registry, 'boots', 2)!;
    expect(PEOPLES.map((people) => wornStem(boots, people, 'feet'))).toEqual(Array(PEOPLES.length).fill('WearBootsT2'));
    expect(wardrobeRow(registry, 'sword', 1)).toBeUndefined();
  });

  it("draws each role's set piece of every armour and jewellery base at tier 3 in its line's own design", () => {
    expect(registry.wardrobe.filter((row) => row.line !== undefined)).toHaveLength(24);
    for (const base of ['cap', 'shoulders', 'tunic', 'gloves', 'trousers', 'boots', 'amulet', 'bracelet']) {
      for (const role of ROLES) {
        const row = wardrobeRow(registry, base, 3, role);
        expect(row, `${role} ${base}`).toMatchObject({ base, tier: 3, line: role });
        expect(row!.ground).not.toBe(wardrobeRow(registry, base, 3)!.ground);
      }
      expect(wardrobeRow(registry, base, 1, 'healer'), base).toBeUndefined();
    }
    const wimple = wardrobeRow(registry, 'cap', 3, 'healer')!;
    expect(wimple.ground).toBe('GroundCapHealerT3');
    expect(wimple.hairFit).toBe('Grave vigil');
    expect(PEOPLES.map((people) => wornStem(wimple, people, 'head'))).toEqual([
      'WearCapHealerT3Vigils',
      'WearCapHealerT3Sopors',
      'WearCapHealerT3Umbrae',
      'WearCapHealerT3Lumina',
    ]);
    expect(wornStem(wardrobeRow(registry, 'bracelet', 3, 'mystic')!, 'vigils', 'bracelet2')).toBe('WearBraceletMysticT3Right');
    expect(wardrobeRow(registry, 'gloves', 3, 'fighter')).toMatchObject({ covers: ['HandL', 'HandR'], wear: { default: 'WearGlovesFighterT3' } });
  });

  /** A nightmare kind added without a trophy model would drop its trophy as a bare name. */
  it("lays every nightmare's trophy as its own ground model", () => {
    expect(registry.trophyModels).toEqual([
      { id: 'ghost', stem: 'GroundGhostlyWisp' },
      { id: 'wolf', stem: 'GroundWolfFang' },
      { id: 'boar', stem: 'GroundBoarTusk' },
      { id: 'bogey', stem: 'GroundBogeyKnot' },
      { id: 'skeleton-minion', stem: 'GroundOldBone' },
      { id: 'skeleton-warrior', stem: 'GroundCrackedSkull' },
      { id: 'necromancer', stem: 'GroundNecromancerSigil' },
    ]);
    for (const kind of MONSTER_KIND_IDS) expect(trophyModelStem(registry, kind), kind).toBeDefined();
  });

  it('lists every model once, character models before object models', () => {
    const stems = allModelEntries(registry).map((entry) => entry.stem);
    expect(new Set(stems).size).toBe(stems.length);
    expect(stems[0]).toBe('Dreamer');
    // Every character stem precedes every prop stem: the listing order the pipeline and the
    // editor pickers present.
    const lastCharacterIndex = Math.max(...registry.characterModels.map((rule) => stems.indexOf(rule.model.stem)));
    const firstPropIndex = Math.min(...registry.objectModels.map((rule) => stems.indexOf(rule.model.stem)));
    expect(lastCharacterIndex).toBeLessThan(firstPropIndex);
    // Hand, ground, wardrobe ground, and trophy models are loaded with the rest, in that order,
    // expecting no clip. A tier-1 wardrobe drop is its base's ground model, listed once.
    const staticStems = [
      ...new Set([
        ...registry.handModels.map((rule) => rule.stem),
        ...registry.groundModels.map((rule) => rule.stem),
        ...registry.wardrobe.map((row) => row.ground),
        ...registry.trophyModels.map((rule) => rule.stem),
      ]),
    ];
    expect(allModelEntries(registry).slice(-staticStems.length)).toEqual(staticStems.map((stem) => ({ stem, expectedClips: [] })));
    expect(stems).toContain('GroundTunicT5');
    expect(stems).toContain('GroundTunicHealerT3');
    // A worn piece loads when a dreamer first wears it.
    expect(stems.some((stem) => stem.startsWith('Wear'))).toBe(false);
  });

  it('gives every prop an empty clip contract and every character a non-empty one', () => {
    for (const rule of registry.objectModels) {
      expect(rule.model.expectedClips).toEqual([]);
    }
    for (const rule of registry.characterModels) {
      expect(rule.model.expectedClips.length).toBeGreaterThan(0);
    }
  });

  it('blocks by the footprint unless the model says otherwise', () => {
    const wall = objectModel(registry, 'stone-wall')!;
    expect(wall.colliders).toEqual([{ x: -wall.footprint.width / 2, z: -wall.footprint.depth / 2, ...wall.footprint }]);
    for (const id of ['rug', 'candle', 'door-mat']) expect(objectModel(registry, id)?.colliders).toEqual([]);
    expect(objectModel(registry, 'stone-wall-corner')?.colliders).toHaveLength(2);
  });

  it('gives a door anchor to the six buildings with an interior, to the crypt, and to the two room thresholds', () => {
    const anchored = registry.objectModels.filter((rule) => rule.doors.length > 0).map((rule) => rule.id);
    expect(anchored.sort()).toEqual([
      'building-barracks',
      'building-chapel',
      'building-house',
      'building-tavern',
      'building-tower',
      'building-townhall',
      'crypt',
      'stone-room-threshold',
      'timber-room-threshold',
    ]);
  });

  it('lights the hearth, the lamps, the candles, and the torches, each by its kind', () => {
    expect(LIGHT_KINDS).toEqual(['candle', 'hearth', 'lamp', 'torch']);
    const lit = registry.objectModels.flatMap((rule) => (rule.light === undefined ? [] : [[rule.id, rule.light.kind]]));
    expect(Object.fromEntries(lit)).toEqual({
      candle: 'candle',
      'floor-lamp': 'lamp',
      'wall-torch': 'torch',
      'standing-torch': 'torch',
      lantern: 'candle',
      'stone-hearth': 'hearth',
      'skull-candle': 'candle',
      'candle-shrine': 'candle',
    });
  });
});

describe('structural invariants the JSON shape cannot express', () => {
  const wardrobeBases = ['cap', 'shoulders', 'tunic', 'gloves', 'trousers', 'boots', 'amulet', 'bracelet'];
  interface RawWardrobeRow {
    base: string;
    tier: number;
    line?: string;
    ground: string;
    covers: string[];
    wear: { default?: string; peoples?: Record<string, string>; wrists?: Record<string, string> };
  }
  function rawRow(base: string, tier: number, line?: string): RawWardrobeRow {
    const design = line === undefined ? `${base}-${tier}` : `${base}-${line}-${tier}`;
    return {
      base,
      tier,
      ...(line === undefined ? {} : { line }),
      ground: `Ground-${design}`,
      covers: base === 'tunic' ? ['Torso'] : [],
      wear: base === 'bracelet' ? { wrists: { bracelet1: `Left-${design}`, bracelet2: `Right-${design}` } } : { default: `Wear-${design}` },
    };
  }
  const valid = {
    characterModels: [{ id: 'hero', model: { stem: 'A', expectedClips: ['Idle'] } }],
    peoples: PEOPLES.map((people: string) => ({ people, model: 'hero', scale: [1, 1, 1] })),
    handModels: [{ id: 'sword', stem: 'HandSword' }],
    groundModels: [{ id: 'sword', stem: 'GroundSword' }, ...wardrobeBases.map((base) => ({ id: base, stem: `Ground-${base}-1` }))],
    trophyModels: [{ id: 'ghost', stem: 'GroundGhostlyWisp' }],
    // The role rows come first, so a lookup that ignored the line would find one of them in place of the neutral row.
    wardrobe: [
      ...wardrobeBases.flatMap((base) => ROLES.map((role) => rawRow(base, 3, role))),
      ...wardrobeBases.flatMap((base) => [1, 2, 3, 4, 5].map((tier) => rawRow(base, tier))),
    ],
    objectModels: [
      {
        id: 'house',
        model: { stem: 'House', expectedClips: [] as string[] },
        footprint: { width: 4, depth: 3 },
        colliders: [{ x: -2, z: -1.5, width: 3, depth: 3 }],
        walkSurfaces: [
          { x: 1, z: -0.5, width: 0.5, depth: 1, height: 0.5 },
          { x: 1.5, z: -0.5, width: 0.5, depth: 1, height: 0.25 },
        ],
        doors: [{ id: 'main', x: 1, z: 0, facing: 90, width: 1 }],
        light: { x: 0, y: 1.2, z: 0, kind: 'torch' },
      },
    ],
  };

  function broken(mutate: (registry: typeof valid) => void): typeof valid {
    const copy = structuredClone(valid);
    mutate(copy);
    return copy;
  }

  function row(registry: typeof valid, base: string, tier: number, line?: string): RawWardrobeRow {
    return registry.wardrobe.find((candidate) => candidate.base === base && candidate.tier === tier && candidate.line === line)!;
  }

  it('accepts the valid shape, walk surfaces that touch included', () => {
    expect(() => parseModelRegistry(valid)).not.toThrow();
  });

  it('finds the neutral row and each role row apart', () => {
    const registry = parseModelRegistry(valid);
    expect(wardrobeRow(registry, 'cap', 3)?.ground).toBe('Ground-cap-3');
    expect(wardrobeRow(registry, 'cap', 3, 'healer')?.ground).toBe('Ground-cap-healer-3');
    expect(wardrobeRow(registry, 'cap', 3, 'healer')?.line).toBe('healer');
    expect(wardrobeRow(registry, 'cap', 3)).not.toHaveProperty('line');
  });

  it.each([
    ['an empty stem', (registry: typeof valid) => (registry.objectModels[0]!.model.stem = ''), /non-empty string/],
    ['an empty object id', (registry: typeof valid) => (registry.objectModels[0]!.id = ''), /non-empty string/],
    ['a duplicate object id', (registry: typeof valid) => registry.objectModels.push(registry.objectModels[0]!), /duplicate id "house"/],
    ['an empty clip name', (registry: typeof valid) => (registry.characterModels[0]!.model.expectedClips = ['Idle', '']), /non-empty string/],
    ['a duplicate character id', (registry: typeof valid) => registry.characterModels.push(registry.characterModels[0]!), /duplicate id "hero"/],
    // A character model with no expected clips would pass the pipeline's clip-presence gate
    // vacuously — the exact failure that gate exists to catch.
    ['a character model expecting no clips', (registry: typeof valid) => (registry.characterModels[0]!.model.expectedClips = []), /must expect a clip/],
    ['a body of no people', (registry: typeof valid) => (registry.peoples[0]!.people = 'giants'), /peoples\[0\]\.people: no people "giants"/],
    ['a people without a body', (registry: typeof valid) => registry.peoples.pop(), /no body for "lumina"/],
    ['a duplicate people', (registry: typeof valid) => (registry.peoples[3]!.people = 'vigils'), /duplicate id "vigils"/],
    [
      'a body that is no character model',
      (registry: typeof valid) => (registry.peoples[0]!.model = 'nobody'),
      /peoples\[0\]\.model: no character model "nobody"/,
    ],
    ['a body scale that is not positive', (registry: typeof valid) => (registry.peoples[0]!.scale[1] = 0), /scale\[1\]: expected a positive number/],
    ['a body scale of two axes', (registry: typeof valid) => registry.peoples[0]!.scale.pop(), /scale: expected three axes/],
    ['a hand model of no item', (registry: typeof valid) => (registry.handModels[0]!.id = 'halberd'), /handModels\[0\]\.id: no item "halberd"/],
    ['a hand model without a stem', (registry: typeof valid) => (registry.handModels[0]!.stem = ''), /handModels\[0\]\.stem: expected a non-empty string/],
    ['a duplicate hand model', (registry: typeof valid) => registry.handModels.push(registry.handModels[0]!), /duplicate id "sword"/],
    ['a ground model of no item', (registry: typeof valid) => (registry.groundModels[0]!.id = 'halberd'), /groundModels\[0\]\.id: no item "halberd"/],
    [
      'a trophy model of no nightmare kind',
      (registry: typeof valid) => (registry.trophyModels[0]!.id = 'dragon'),
      /trophyModels\[0\]\.id: no nightmare kind "dragon"/,
    ],
    [
      'a wardrobe missing a tier',
      (registry: typeof valid) => (registry.wardrobe = registry.wardrobe.filter((candidate) => candidate !== row(registry, 'tunic', 3))),
      /no row for tunic at tier 3/,
    ],
    ['a duplicate wardrobe row', (registry: typeof valid) => registry.wardrobe.push(row(registry, 'cap', 2)), /duplicate row for cap at tier 2/],
    [
      "a wardrobe missing a role's row",
      (registry: typeof valid) => (registry.wardrobe = registry.wardrobe.filter((candidate) => candidate !== row(registry, 'tunic', 3, 'healer'))),
      /no row for healer tunic at tier 3/,
    ],
    [
      'a role row outside the set tiers',
      (registry: typeof valid) => registry.wardrobe.push(rawRow('boots', 2, 'fighter')),
      /wardrobe\[64\]\.line: no set piece is made at tier 2/,
    ],
    ['a row of no role', (registry: typeof valid) => (row(registry, 'cap', 3, 'mystic').line = 'bard'), /wardrobe\[2\]\.line: no role "bard"/],
    ['a wardrobe row of no tier', (registry: typeof valid) => (row(registry, 'cap', 5).tier = 6), /wardrobe\[28\]\.tier: expected a tier from 1 to 5/],
    [
      'a wardrobe row of a held item',
      (registry: typeof valid) => (row(registry, 'cap', 1).base = 'sword'),
      /wardrobe\[24\]\.base: no armour or jewellery "sword"/,
    ],
    [
      'a bracelet row missing a wrist',
      (registry: typeof valid) => delete row(registry, 'bracelet', 2).wear.wrists!['bracelet2'],
      /wear\.wrists\.bracelet2: expected a non-empty string/,
    ],
    [
      'a bracelet row worn as one piece',
      (registry: typeof valid) => (row(registry, 'bracelet', 1).wear = { default: 'WearBracelet' }),
      /a bracelet is worn as a piece for each wrist alone/,
    ],
    [
      'a row with wrists that is no bracelet',
      (registry: typeof valid) => (row(registry, 'gloves', 1).wear.wrists = { bracelet1: 'L', bracelet2: 'R' }),
      /only a bracelet is worn per wrist/,
    ],
    [
      'a row that leaves a people without a piece',
      (registry: typeof valid) => (row(registry, 'cap', 1).wear = { peoples: { vigils: 'WearCapVigils' } }),
      /wardrobe\[24\]\.wear: no piece for sopors in head/,
    ],
    [
      'a piece fitted to no people',
      (registry: typeof valid) => (row(registry, 'cap', 1).wear.peoples = { giants: 'WearCapGiants' }),
      /wear\.peoples: no people "giants"/,
    ],
    ['a cover of no body region', (registry: typeof valid) => (row(registry, 'tunic', 1).covers = ['Tail']), /covers\[0\]: no body region "Tail"/],
    [
      'a wardrobe base with no tier-1 ground model',
      (registry: typeof valid) => (registry.groundModels = registry.groundModels.filter((rule) => rule.id !== 'cap')),
      /groundModels: cap must lie as its tier-1 wardrobe row, "Ground-cap-1"/,
    ],
    [
      'a tier-1 ground model other than its wardrobe row',
      (registry: typeof valid) => (registry.groundModels.find((rule) => rule.id === 'boots')!.stem = 'GroundBootsT2'),
      /groundModels: boots must lie as its tier-1 wardrobe row, "Ground-boots-1"/,
    ],
    ['a footprint without extent', (registry: typeof valid) => (registry.objectModels[0]!.footprint.depth = 0), /footprint\.depth: expected a positive number/],
    [
      'a collider without extent',
      (registry: typeof valid) => (registry.objectModels[0]!.colliders[0]!.width = -1),
      /colliders\[0\]\.width: expected a positive number/,
    ],
    ['a walk surface at floor height', (registry: typeof valid) => (registry.objectModels[0]!.walkSurfaces[0]!.height = 0), /walkSurfaces\[0\]\.height/],
    // Steps cut into a plinth must be cut out of it, or the point resolves to the plinth's height.
    [
      'walk surfaces that overlap',
      (registry: typeof valid) => (registry.objectModels[0]!.walkSurfaces[1]!.x = 1.4),
      /walkSurfaces\[1\]: overlaps .*walkSurfaces\[0\]/,
    ],
    ['a door facing off the axes', (registry: typeof valid) => (registry.objectModels[0]!.doors[0]!.facing = 45), /facing: expected 0, 90, 180, or 270/],
    ['a door without width', (registry: typeof valid) => (registry.objectModels[0]!.doors[0]!.width = 0), /doors\[0\]\.width/],
    ['a duplicate door id', (registry: typeof valid) => registry.objectModels[0]!.doors.push(registry.objectModels[0]!.doors[0]!), /duplicate id "main"/],
    [
      'a light of a kind no client lights',
      (registry: typeof valid) => (registry.objectModels[0]!.light.kind = 'sun'),
      /light\.kind: expected one of candle, hearth, lamp, torch/,
    ],
    ['a light below the ground', (registry: typeof valid) => (registry.objectModels[0]!.light.y = -0.1), /light\.y: expected a number not below the ground/],
  ])('rejects %s', (_name, mutate, message) => {
    expect(() => parseModelRegistry(broken(mutate))).toThrow(message);
  });

  it('reads absent walk surfaces and doors as none', () => {
    const bare = { ...valid, objectModels: [{ id: 'crate', model: { stem: 'Crate', expectedClips: [] }, footprint: { width: 1, depth: 1 } }] };
    expect(parseModelRegistry(bare).objectModels[0]).toMatchObject({ walkSurfaces: [], doors: [] });
  });

  it('reads absent hand, ground, and trophy models and an absent or empty wardrobe as none', () => {
    expect(parseModelRegistry({ ...valid, wardrobe: [] }).wardrobe).toEqual([]);
    expect(parseModelRegistry({ ...valid, handModels: undefined, groundModels: undefined, trophyModels: undefined, wardrobe: undefined })).toMatchObject({
      handModels: [],
      groundModels: [],
      trophyModels: [],
      wardrobe: [],
    });
  });

  it('rejects a non-object root', () => {
    expect(() => parseModelRegistry([])).toThrow(ModelRegistryError);
    expect(() => parseModelRegistry(null)).toThrow(ModelRegistryError);
  });
});

describe('missingClips', () => {
  it('reports only the absent clips', () => {
    expect(missingClips(['Idle', 'Walking_A'], ['Idle'])).toEqual(['Walking_A']);
    expect(missingClips(['Idle'], ['Idle', 'Extra'])).toEqual([]);
    expect(missingClips([], ['Idle'])).toEqual([]);
  });
});
