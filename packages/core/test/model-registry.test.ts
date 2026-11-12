import { describe, expect, it } from 'vitest';
import {
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
} from '../src/modelRegistry.ts';
import { BASE_ITEMS } from '../src/items.ts';
import { MONSTER_KINDS } from '../src/monsterKinds.ts';
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

  it('resolves the player model', () => {
    const model = modelForCharacter(registry, registry.playerModel);
    expect(model?.stem).toBe('WachenKaempfer');
    expect(model?.expectedClips).toContain('Walking_A');
    expect(model?.expectedClips).toContain('Running_Strafe_Left');
  });

  it('resolves the NPC and monster models by id', () => {
    expect(modelForCharacter(registry, 'libus')?.stem).toBe('Libus');
    expect(modelForCharacter(registry, 'merchant')?.stem).toBe('Kraemer');
    expect(modelForCharacter(registry, 'fighter-master')?.stem).toBe('KaempferMeister');
    expect(modelForCharacter(registry, 'ghost')?.stem).toBe('Gespenst');
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

  it('lists every model once, character models before object models', () => {
    const stems = allModelEntries(registry).map((entry) => entry.stem);
    expect(new Set(stems).size).toBe(stems.length);
    expect(stems[0]).toBe('WachenKaempfer');
    // Every character stem precedes every prop stem: the listing order the pipeline and the
    // editor pickers present.
    const lastCharacterIndex = Math.max(...registry.characterModels.map((rule) => stems.indexOf(rule.model.stem)));
    const firstPropIndex = Math.min(...registry.objectModels.map((rule) => stems.indexOf(rule.model.stem)));
    expect(lastCharacterIndex).toBeLessThan(firstPropIndex);
    // Hand and ground models are loaded with the rest, expecting no clip.
    const itemModels = [...registry.handModels, ...registry.groundModels];
    expect(allModelEntries(registry).slice(-itemModels.length)).toEqual(itemModels.map(({ stem }) => ({ stem, expectedClips: [] })));
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
  const valid = {
    characterModels: [{ id: 'hero', model: { stem: 'A', expectedClips: ['Idle'] } }],
    playerModel: 'hero',
    handModels: [{ id: 'sword', stem: 'HandSword' }],
    groundModels: [{ id: 'sword', stem: 'GroundSword' }],
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

  it('accepts the valid shape, walk surfaces that touch included', () => {
    expect(() => parseModelRegistry(valid)).not.toThrow();
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
    ['a player model that is no character model', (registry: typeof valid) => (registry.playerModel = 'nobody'), /no character model "nobody"/],
    ['a hand model of no item', (registry: typeof valid) => (registry.handModels[0]!.id = 'halberd'), /handModels\[0\]\.id: no item "halberd"/],
    ['a hand model without a stem', (registry: typeof valid) => (registry.handModels[0]!.stem = ''), /handModels\[0\]\.stem: expected a non-empty string/],
    ['a duplicate hand model', (registry: typeof valid) => registry.handModels.push(registry.handModels[0]!), /duplicate id "sword"/],
    ['a ground model of no item', (registry: typeof valid) => (registry.groundModels[0]!.id = 'halberd'), /groundModels\[0\]\.id: no item "halberd"/],
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

  it('reads absent hand and ground models as none', () => {
    expect(parseModelRegistry({ ...valid, handModels: undefined, groundModels: undefined })).toMatchObject({ handModels: [], groundModels: [] });
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
