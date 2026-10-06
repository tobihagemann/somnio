import { ROLES } from '@somnio/protocol';
import { describe, expect, it } from 'vitest';
import { coreCatalog, catalogViolations, lookupIn } from '../src/catalog.ts';
import { ITEMS, itemInHand, itemLabelKey, itemWeapon } from '../src/items.ts';
import { TEACHINGS, roleLabelKey } from '../src/lucidity.ts';
import { PEOPLES, peopleLabelKey } from '../src/people.ts';

const CORE_KEYS = [
  'Balance recovery',
  'Cudgel',
  'Depth',
  'Drawing back',
  'Follow-through',
  'Guard',
  'Heiler',
  'Kämpfer',
  'Lumina',
  'Mondstein',
  'Purse',
  'Soporen',
  'Spirit deepening',
  'Strike',
  'Touch',
  'Toughening',
  'Umbren',
  'Wachen',
];

describe('items', () => {
  it('resolves the purse and the cudgel', () => {
    expect(itemLabelKey('purse')).toBe('Purse');
    expect(itemLabelKey('cudgel')).toBe('Cudgel');
  });

  it('resolves nothing for an unknown id, inherited object keys included', () => {
    expect(itemLabelKey('sword')).toBeUndefined();
    expect(itemLabelKey('toString')).toBeUndefined();
  });

  it('makes a weapon of the cudgel alone', () => {
    expect(itemWeapon('cudgel')).toEqual({ damage: 8, balanceCost: 18 });
    expect(itemWeapon('mondstein')).toBeUndefined();
    expect(itemWeapon('toString')).toBeUndefined();
  });

  it('holds what is in the right hand, and nothing for a row in the left', () => {
    const cudgel = { itemId: 'cudgel', equippedHand: 'left' as const };
    const mondstein = { itemId: 'mondstein', equippedHand: 'right' as const };
    expect(itemInHand([{ itemId: 'purse' }, cudgel, mondstein])).toBe('mondstein');
    expect(itemInHand([{ itemId: 'purse' }, cudgel])).toBeUndefined();
  });

  it('ships English and German for both labels', () => {
    expect(lookupIn(coreCatalog, 'en', 'Purse', [])).toBe('Purse');
    expect(lookupIn(coreCatalog, 'de', 'Purse', [])).toBe('Geldbeutel');
    expect(lookupIn(coreCatalog, 'de', 'Cudgel', [])).toBe('Knüppel');
  });
});

describe('core catalog', () => {
  it('satisfies every catalog rule for its keys', () => {
    expect(Object.keys(coreCatalog.en).sort()).toEqual(CORE_KEYS);
    expect(catalogViolations(coreCatalog, CORE_KEYS)).toEqual([]);
  });

  it('holds exactly the labels of the items, the peoples, the roles, and the teachings', () => {
    const labels = [
      ...Object.values(ITEMS).map((item) => item.labelKey),
      ...PEOPLES.map(peopleLabelKey),
      ...ROLES.map(roleLabelKey),
      ...Object.values(TEACHINGS).map((teaching) => teaching.labelKey),
    ];
    expect(labels.sort()).toEqual(CORE_KEYS);
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
