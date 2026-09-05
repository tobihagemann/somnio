import { describe, expect, it } from 'vitest';
import { coreCatalog, catalogViolations, lookupIn } from '../src/catalog.ts';
import { itemCatalogKey } from '../src/itemCatalog.ts';

const CORE_KEYS = ['Cleric', 'Cudgel', 'Female', 'Fighter', 'Gangster', 'Hunter', 'Lancer', 'Mage', 'Male', 'Purse', 'Thief', 'Warrior'];

describe('item catalog', () => {
  it('resolves the purse and the cudgel', () => {
    expect(itemCatalogKey(0, 0)).toBe('Purse');
    expect(itemCatalogKey(1, 0)).toBe('Cudgel');
  });

  it('resolves nothing for an unknown pair', () => {
    expect(itemCatalogKey(99, 99)).toBeUndefined();
    expect(itemCatalogKey(0, 1)).toBeUndefined();
  });

  it('ships English and German for both labels', () => {
    expect(lookupIn(coreCatalog, 'en', 'Purse', [])).toBe('Purse');
    expect(lookupIn(coreCatalog, 'de', 'Purse', [])).toBe('Geldbeutel');
    expect(lookupIn(coreCatalog, 'de', 'Cudgel', [])).toBe('Knüppel');
  });

  it.each([
    ['Male', 'Männlich'],
    ['Female', 'Weiblich'],
    ['Warrior', 'Krieger'],
    ['Mage', 'Magier'],
    ['Cleric', 'Geistlicher'],
    ['Thief', 'Dieb'],
    ['Hunter', 'Jäger'],
    ['Fighter', 'Kämpfer'],
    ['Lancer', 'Lancier'],
    ['Gangster', 'Gangster'],
  ])('renders %s as %s in German', (key, german) => {
    expect(lookupIn(coreCatalog, 'de', key, [])).toBe(german);
  });
});

describe('core catalog', () => {
  it('satisfies every catalog rule for its twelve keys', () => {
    expect(Object.keys(coreCatalog.en).sort()).toEqual(CORE_KEYS);
    expect(catalogViolations(coreCatalog, CORE_KEYS)).toEqual([]);
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
