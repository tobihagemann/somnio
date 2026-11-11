import { ROLES } from '@somnio/protocol';
import { describe, expect, it, vi } from 'vitest';
import { coreCatalog, catalogViolations, lookupIn } from '../src/catalog.ts';
import { BASE_ITEMS, itemLabelKey, newItemId, plainInstance } from '../src/items.ts';
import { TEACHINGS, TRIALS, roleLabelKey } from '../src/lucidity.ts';
import { MONSTER_KINDS } from '../src/monsterKinds.ts';
import { PEOPLES, peopleLabelKey } from '../src/people.ts';

const CORE_KEYS = [
  'Amulet',
  'Balance recovery',
  'Bind',
  'Brace',
  'Buckler',
  'Calm',
  'Challenge',
  'Cleave',
  'Cudgel',
  'Dagger',
  'Deep mend',
  'Depth',
  'Drawing back',
  'Dream-bolt',
  'Fighter',
  'Follow-through',
  'Ghost',
  'Guard',
  'Healer',
  'Iron ring',
  'Leather boots',
  'Leather cap',
  'Leather gloves',
  'Leather trousers',
  'Lumina',
  'Lunge',
  'Mace',
  'Moonstone',
  'Mystic',
  'North Wood',
  'Padded tunic',
  'Radiance',
  'Rally',
  'Renewal',
  'Round shield',
  'Sense the fallen',
  'Short sword',
  'Sopors',
  'Spirit deepening',
  'Strike',
  'Touch',
  'Toughening',
  'Umbrae',
  'Veil',
  'Vigils',
  'Wand',
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

  it('holds exactly the labels of the items, the peoples, the roles, the teachings, the nightmares, and the places a trial names', () => {
    const labels = [
      ...Object.values(BASE_ITEMS).map((item) => item.labelKey),
      ...PEOPLES.map(peopleLabelKey),
      ...ROLES.map(roleLabelKey),
      ...Object.values(TEACHINGS).map((teaching) => teaching.labelKey),
      ...Object.values(MONSTER_KINDS).map((kind) => kind.name),
      ...Object.values(TRIALS).flatMap((trial) => (trial.kind === 'reach' ? [trial.labelKey] : [])),
    ];
    // Each role's Spirit deepening is its own teaching under one label.
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
