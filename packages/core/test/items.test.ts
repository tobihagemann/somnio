import { ROLES } from '@somnio/protocol';
import { describe, expect, it, vi } from 'vitest';
import { coreCatalog, catalogViolations, lookupIn } from '../src/catalog.ts';
import { BASE_ITEMS, itemLabelKey, newItemId, plainInstance } from '../src/items.ts';
import { TEACHINGS, roleLabelKey } from '../src/lucidity.ts';
import { ELITE_TRAITS, MONSTER_KINDS } from '../src/monsterKinds.ts';
import { PEOPLES, peopleLabelKey } from '../src/people.ts';
import { BOUNTY_KINDS, BOUNTY_LABEL_KEY } from '../src/bounties.ts';
import { QUESTS, TROPHIES } from '../src/quests.ts';

const CORE_KEYS = [
  "A newcomer's errand",
  'Amulet',
  'Balance recovery',
  'Bind',
  'Bone dagger',
  'Bounty: %@',
  'Brace',
  'Buckler',
  'Calm',
  'Challenge',
  'Cleave',
  'Cracked skull',
  'Cracked skulls',
  'Cudgel',
  'Dagger',
  'Deep mend',
  'Depth',
  'Drawing back',
  'Dream-bolt',
  'Drive off %@ Ghosts there.',
  'Drive off %@ Skeleton Warriors there.',
  'Drive off %@ Skeletons there.',
  'Drive off 3 nightmares.',
  'Drive off 4 Skeletons in the Graveyard.',
  'Drive off a nightmare.',
  'Drive off the Necromancer in the burial chamber.',
  'Fighter',
  'Find the hidden places Tacita speaks of.',
  'Follow-through',
  'Gather %@ cracked skulls from Skeleton Warriors.',
  'Gather %@ ghostly wisps from Ghosts.',
  'Gather %@ old bones from Skeletons.',
  'Gather 3 cracked skulls from Skeleton Warriors.',
  'Ghost',
  'Ghostly wisp',
  'Guard',
  'Healer',
  'Into the crypt',
  'Iron buckler',
  'Iron ring',
  'Leather boots',
  'Leather cap',
  'Leather gloves',
  'Leather trousers',
  'Lumina',
  'Lunge',
  'Mace',
  'Mend 60 health on other dreamers.',
  'Mending others',
  'Moonstone',
  'Mystic',
  'Necromancer',
  "Necromancer's sigil",
  'Old bone',
  'Padded tunic',
  'Radiance',
  'Rally',
  'Read the bounty board on the square.',
  'Renewal',
  'Restless graves',
  'Round shield',
  'Sabre',
  'Sense the fallen',
  'Shielded Ghost',
  'Shielded Skeleton',
  'Shielded Skeleton Warrior',
  'Short sword',
  'Skeleton',
  'Skeleton Warrior',
  'Skull shield',
  'Skull staff',
  'Sopors',
  'Spirit deepening',
  'Stony Ghost',
  'Stony Skeleton',
  'Stony Skeleton Warrior',
  'Strike',
  "The Fighters' trial",
  "The Healers' trial",
  "The Mystics' trial",
  'Three without a fall',
  'Touch',
  'Toughening',
  'Umbrae',
  'Veil',
  'Vigils',
  'Visit Mercus in his shop.',
  'Walk to the North Wood and come back.',
  'Wand',
  'War axe',
  'Ward',
  'Weaken',
];

describe('items', () => {
  it('resolves the cudgel', () => {
    expect(itemLabelKey('cudgel')).toBe('Cudgel');
  });

  it('resolves nothing for an unknown id, the purse and inherited object keys included', () => {
    expect(itemLabelKey('longsword')).toBeUndefined();
    expect(itemLabelKey('purse')).toBeUndefined();
    expect(itemLabelKey('toString')).toBeUndefined();
  });

  it('names each new item by a UUIDv7, so items sort by id in the order they were made', () => {
    const now = vi.spyOn(Date, 'now');
    const made = [1_700_000_000_000, 1_700_000_000_001, 1_800_000_000_000].map((ms) => {
      now.mockReturnValue(ms);
      return plainInstance('dagger');
    });
    now.mockRestore();
    expect(made.every(({ id }) => /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id))).toBe(true);
    const ids = made.map(({ id }) => id);
    expect([...ids].reverse().sort()).toEqual(ids);
    expect(newItemId()).not.toBe(newItemId());
  });

  it('ships English and German for an item label', () => {
    expect(lookupIn(coreCatalog, 'en', 'Cudgel', [])).toBe('Cudgel');
    expect(lookupIn(coreCatalog, 'de', 'Cudgel', [])).toBe('Knüppel');
  });
});

describe('core catalog', () => {
  it('satisfies every catalog rule for its keys', () => {
    expect(Object.keys(coreCatalog.en).sort()).toEqual(CORE_KEYS);
    expect(catalogViolations(coreCatalog, CORE_KEYS)).toEqual([]);
  });

  it('holds exactly the labels of the items, the peoples, the roles, the teachings, the nightmares, elites included, the quests and their objectives, the bounties, and the trophies', () => {
    const labels = [
      ...Object.values(BASE_ITEMS).map((item) => item.labelKey),
      ...PEOPLES.map(peopleLabelKey),
      ...ROLES.map(roleLabelKey),
      ...Object.values(TEACHINGS).map((teaching) => teaching.labelKey),
      ...Object.values(MONSTER_KINDS).map((kind) => kind.name),
      ...Object.values(ELITE_TRAITS).flatMap((trait) => Object.values(trait.names)),
      ...Object.values(QUESTS).flatMap((quest) => [quest.labelKey, ...quest.objectives.map((objective) => objective.labelKey)]),
      BOUNTY_LABEL_KEY,
      ...Object.values(BOUNTY_KINDS).flatMap((lines) => Object.values(lines)),
      ...Object.values(TROPHIES),
    ];
    // Each role's Spirit deepening is its own teaching under one label, and the Mystic's trial says each of its places by one line.
    expect([...new Set(labels)].sort()).toEqual(CORE_KEYS);
  });
});

/** The validator is the only guard on the catalogs, so each rule is armed with a case that trips it. */
describe('catalogViolations', () => {
  const clean = { en: { 'Hello %@...': 'Hello %@...' }, de: { 'Hello %@...': 'Hallo %@...' } };

  it('passes a catalog satisfying every rule', () => {
    expect(catalogViolations(clean, ['Hello %@...'])).toEqual([]);
  });

  it('reports a missing locale', () => {
    const tables = { en: { Key: 'Key' }, de: {} };
    expect(catalogViolations(tables, ['Key']).map((violation) => violation.rule)).toEqual(['missingLocale']);
  });

  it('reports an empty value', () => {
    const tables = { en: { Key: 'Key' }, de: { Key: '' } };
    expect(catalogViolations(tables, ['Key']).map((violation) => violation.rule)).toEqual(['emptyValue']);
  });

  it('reports a Unicode ellipsis in either value', () => {
    const tables = { en: { Key: 'Wait\u2026' }, de: { Key: 'Warten...' } };
    expect(catalogViolations(tables, ['Key']).map((violation) => violation.rule)).toEqual(['unicodeEllipsis']);
  });

  it('reports a placeholder mismatch', () => {
    const tables = { en: { Key: 'Hello %@' }, de: { Key: 'Hallo %1$@ %2$@' } };
    expect(catalogViolations(tables, ['Key']).map((violation) => violation.rule)).toEqual(['placeholderMismatch']);
  });

  it('ignores keys outside the expected set', () => {
    const tables = { en: { Key: 'Key', Extra: 'Extra' }, de: { Key: 'Key' } };
    expect(catalogViolations(tables, ['Key'])).toEqual([]);
  });

  it('reads as English when a key falls through', () => {
    // Keys are the English source strings, so the fallback is readable rather than an identifier.
    for (const key of CORE_KEYS) expect(coreCatalog.en[key]).toBe(key);
  });
});
