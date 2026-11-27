import { ROLES } from '@somnio/protocol';
import { describe, expect, it, vi } from 'vitest';
import { coreCatalog, catalogViolations, lookupIn } from '../src/catalog.ts';
import { AFFIXES } from '../src/affixes.ts';
import { BASE_ITEMS, itemLabelKey, newItemId, commonInstance } from '../src/items.ts';
import type { Tier } from '../src/items.ts';
import { TEACHINGS, roleLabelKey } from '../src/lucidity.ts';
import { ELITE_TRAITS, MONSTER_KINDS } from '../src/monsterKinds.ts';
import { PEOPLES, peopleLabelKey } from '../src/people.ts';
import { BOUNTY_KINDS, BOUNTY_LABEL_KEY } from '../src/bounties.ts';
import { QUESTS, TROPHIES } from '../src/quests.ts';
import { SET_BONUSES, SET_TITLE_KEYS } from '../src/sets.ts';

const CORE_KEYS = [
  '%@ of Haste',
  '%@ of Mending',
  '%@ of Might',
  '%@ of Poise',
  '%@ of Reverie',
  '%@ of Steadiness',
  '%@ of Stillness',
  '%@ of Vigour',
  '%@ of Warding',
  '%@ of the Bulwark',
  "A newcomer's errand",
  'A word for Memor',
  'Antler tine',
  'Balance recovery',
  'Bark-grip gloves',
  'Bear claw',
  'Beech leaf',
  'Bind',
  'Bind also Weakens its nightmare.',
  'Boar',
  "Boar's tusk",
  'Bogey',
  "Bogey's knot",
  'Bone dagger',
  'Bounty: %@',
  'Brace',
  'Brace lasts 2 s longer.',
  'Brush trousers',
  'Buckler',
  'Burial hauberk',
  'Calm',
  'Candle gloves',
  'Challenge',
  'Chapel boots',
  'Cleave',
  'Cleave strikes each nightmare a fifth harder.',
  'Climbing boots',
  'Compass rose',
  'Courier shoulders',
  'Courier straw hat',
  'Courier tunic',
  'Cracked skull',
  'Cracked skulls',
  'Crypt chausses',
  'Crypt gauntlets',
  'Crypt grille',
  'Crypt pauldrons',
  'Crypt sabatons',
  'Cudgel',
  'Dagger',
  'Deck boots',
  'Deep mend',
  "Deep mend's channel is a third shorter.",
  'Depth',
  'Dispatch gloves',
  'Dispatch wristband',
  'Drawing back',
  'Dream-bolt',
  'Dream-bolt harms a fifth more.',
  'Drive off %@ Boars there.',
  'Drive off %@ Bogeys there.',
  'Drive off %@ Ghosts there.',
  'Drive off %@ Skeleton Warriors there.',
  'Drive off %@ Skeletons there.',
  'Drive off %@ Wolves there.',
  'Drive off 3 nightmares.',
  'Drive off 4 Skeletons in the Graveyard.',
  'Drive off a nightmare.',
  'Drive off the Necromancer in the burial chamber.',
  'Fen boots',
  'Ferry guards',
  "Ferryman's raincoat",
  'Field trousers',
  'Fighter',
  "Fighters' set (%1$@/6)",
  'Find Memor in the Graveyard.',
  "Find the Mystics' tower on the square.",
  'Find the hidden places Tacita speaks of.',
  'Follow-through',
  "Forester's feather band",
  "Gather %@ boar's tusks from Boars.",
  "Gather %@ bogey's knots from Bogeys.",
  'Gather %@ cracked skulls from Skeleton Warriors.',
  'Gather %@ ghostly wisps from Ghosts.',
  'Gather %@ old bones from Skeletons.',
  "Gather %@ wolf's fangs from Wolves.",
  'Gather 3 cracked skulls from Skeleton Warriors.',
  'Ghost',
  'Ghostly wisp',
  'Grave iron kettle helm',
  'Guard',
  'Healer',
  "Healers' set (%1$@/6)",
  'Hide mitts',
  'Into the crypt',
  'Iron buckler',
  'Lantern cage',
  'Leaf gaiters',
  'Leaf shoulder',
  'Linen wimple',
  'Lumina',
  'Lunge',
  "Lunge's cooldown is a third shorter, and each Lunge gives back 10 Balance.",
  'Mace',
  'Maple twig',
  'Marsh boots',
  'Marsh eye',
  'Marsh shoulders',
  'Marsh trousers',
  'Marsh veil',
  'Marsh witch hat',
  'Meet Pugnax and Sana in their halls.',
  'Mend 60 health on other dreamers.',
  'Mending others',
  'Moonstone',
  'Mystic',
  "Mystics' set (%1$@/6)",
  "Navigator's epaulettes",
  'Necromancer',
  "Necromancer's sigil",
  'Oiled storm brim',
  'Old bone',
  'Pelt guards',
  'Portcullis',
  'Radiance',
  'Radiance heals a third more.',
  'Rally',
  'Read the bounty board on the square.',
  'Reed eye',
  'Reed knot',
  'Reedwork gloves',
  'Renewal',
  'Renewal lasts 4 s longer.',
  'Restless graves',
  'Round shield',
  'Sabre',
  "Sailmaker's gloves",
  'Sense the fallen',
  'Shielded Boar',
  'Shielded Bogey',
  'Shielded Ghost',
  'Shielded Skeleton',
  'Shielded Skeleton Warrior',
  'Shielded Wolf',
  'Shore coat',
  'Short sword',
  'Skeleton',
  'Skeleton Warrior',
  'Skull shield',
  'Skull staff',
  'Sopors',
  'Sounding weight',
  'Spirit deepening',
  'Stony Boar',
  'Stony Bogey',
  'Stony Ghost',
  'Stony Skeleton',
  'Stony Skeleton Warrior',
  'Stony Wolf',
  'Storm trousers',
  'Strike',
  'Tarred reed brim',
  "The Fighters' trial",
  "The Healers' trial",
  "The Mystics' trial",
  'Three without a fall',
  'Touch',
  'Toughening',
  'Trail boots',
  'Trail cape',
  'Trail leathers',
  "Trapper's baldric",
  "Trapper's hide band",
  'Umbrae',
  'Veil',
  'Vigil shoulders',
  'Vigil stole',
  'Vigil trousers',
  'Vigils',
  'Visit Mercus in his shop.',
  'Votive candle',
  'Votive gloves',
  'Wader trousers',
  'Walk to the North Wood and come back.',
  'Wand',
  'War axe',
  'Ward',
  'Ward holds a quarter more.',
  'Wax taper',
  'Weaken',
  'Wheat-ear pendant',
  'Wolf',
  "Wolf's fang",
];

describe('items', () => {
  it('resolves the cudgel by its base, whatever its tier', () => {
    expect(itemLabelKey('cudgel', 1)).toBe('Cudgel');
    expect(itemLabelKey('cudgel', 3)).toBe('Cudgel');
  });

  it('resolves armour and jewellery by their design at each tier', () => {
    expect(
      (['cap', 'shoulders', 'tunic', 'gloves', 'trousers', 'boots', 'amulet', 'bracelet'] as const).map((baseId) =>
        [1, 2, 3, 4, 5].map((tier) => itemLabelKey(baseId, tier)),
      ),
    ).toEqual([
      ['Courier straw hat', "Forester's feather band", 'Tarred reed brim', "Trapper's hide band", 'Oiled storm brim'],
      ['Courier shoulders', 'Leaf shoulder', 'Ferry guards', 'Pelt guards', "Navigator's epaulettes"],
      ['Courier tunic', 'Trail cape', "Ferryman's raincoat", "Trapper's baldric", 'Shore coat'],
      ['Dispatch gloves', 'Bark-grip gloves', 'Reedwork gloves', 'Hide mitts', "Sailmaker's gloves"],
      ['Field trousers', 'Brush trousers', 'Wader trousers', 'Trail leathers', 'Storm trousers'],
      ['Trail boots', 'Leaf gaiters', 'Fen boots', 'Climbing boots', 'Deck boots'],
      ['Wheat-ear pendant', 'Beech leaf', 'Lantern cage', 'Bear claw', 'Compass rose'],
      ['Dispatch wristband', 'Maple twig', 'Reed knot', 'Antler tine', 'Sounding weight'],
    ]);
  });

  it("resolves a set piece by its line's design at a tier the line has one, and to nothing at a tier it has none", () => {
    expect(
      (['cap', 'shoulders', 'tunic', 'gloves', 'trousers', 'boots', 'amulet', 'bracelet'] as const).map((baseId) =>
        ROLES.map((role) => itemLabelKey(baseId, 3, role)),
      ),
    ).toEqual([
      ['Grave iron kettle helm', 'Linen wimple', 'Marsh witch hat'],
      ['Crypt pauldrons', 'Vigil shoulders', 'Marsh shoulders'],
      ['Burial hauberk', 'Vigil stole', 'Marsh veil'],
      ['Crypt gauntlets', 'Votive gloves', 'Candle gloves'],
      ['Crypt chausses', 'Vigil trousers', 'Marsh trousers'],
      ['Crypt sabatons', 'Chapel boots', 'Marsh boots'],
      ['Portcullis', 'Votive candle', 'Marsh eye'],
      ['Crypt grille', 'Wax taper', 'Reed eye'],
    ]);
    expect(itemLabelKey('cap', 1, 'healer')).toBeUndefined();
  });

  it('resolves nothing for an unknown id, the purse and inherited object keys included, or for a tier no design is made in', () => {
    expect(itemLabelKey('longsword', 1)).toBeUndefined();
    expect(itemLabelKey('purse', 1)).toBeUndefined();
    expect(itemLabelKey('toString', 1)).toBeUndefined();
    expect(itemLabelKey('ring', 1)).toBeUndefined();
    expect(itemLabelKey('tunic', 6)).toBeUndefined();
  });

  it('names each new item by a UUIDv7, so items sort by id in the order they were made', () => {
    const now = vi.spyOn(Date, 'now');
    const made = [1_700_000_000_000, 1_700_000_000_001, 1_800_000_000_000].map((ms) => {
      now.mockReturnValue(ms);
      return commonInstance('dagger');
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

  it('holds exactly the labels of the items and their suffixes, the peoples, the roles, the teachings, the nightmares, elites included, the quests and their objectives, the bounties, the trophies, and the sets', () => {
    const labels = [
      ...Object.values(BASE_ITEMS).flatMap((item) =>
        'tierLabelKeys' in item
          ? [...Object.values(item.tierLabelKeys), ...Object.values(item.lineLabelKeys).flatMap((tiers: Partial<Record<Tier, string>>) => Object.values(tiers))]
          : [item.labelKey],
      ),
      ...Object.values(AFFIXES).map((line) => line.nameKey),
      ...PEOPLES.map(peopleLabelKey),
      ...ROLES.map(roleLabelKey),
      ...Object.values(TEACHINGS).map((teaching) => teaching.labelKey),
      ...Object.values(MONSTER_KINDS).map((kind) => kind.name),
      ...Object.values(ELITE_TRAITS).flatMap((trait) => Object.values(trait.names)),
      ...Object.values(QUESTS).flatMap((quest) => [quest.labelKey, ...quest.objectives.map((objective) => objective.labelKey)]),
      BOUNTY_LABEL_KEY,
      ...Object.values(BOUNTY_KINDS).flatMap((lines) => Object.values(lines)),
      ...Object.values(TROPHIES),
      ...Object.values(SET_TITLE_KEYS),
      ...Object.values(SET_BONUSES).flatMap((steps) => steps.map((step) => step.textKey)),
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
