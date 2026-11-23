import { describe, expect, it } from 'vitest';
import { SOMNIO_PROTOCOL_CONSTANTS, utf8ByteLength } from '@somnio/protocol';
import { catalogViolations, readCatalog } from '../src/i18n/catalog.ts';
import { NO_LUCIDITY } from '../src/lucidity.ts';
import type { Lucidity } from '../src/lucidity.ts';
import { dialogLine, dialogLineFits, dialogLineInBudget, dialogStepFits, listenerRolesFor, localizedDialogLine, npcReadSeconds } from '../src/npcDialog.ts';
import type { DialogCondition } from '../src/npcDialog.ts';
import { NO_QUESTS } from '../src/quests.ts';
import type { QuestId, QuestLog } from '../src/quests.ts';
import { speechReadSeconds } from '../src/speech.ts';
import dialogJSON from '../data/dialog.json' with { type: 'json' };
import { loadSectorFixtures } from './support/sectorFixture.ts';

const SAY = SOMNIO_PROTOCOL_CONSTANTS.maxSayUTF8Bytes;
const NAME = SOMNIO_PROTOCOL_CONSTANTS.maxIdentifierUTF8Bytes;

describe('whom a dialog step is for', () => {
  const fighter: Lucidity = { ...NO_LUCIDITY, role: 'fighter' };
  const healer: Lucidity = { ...NO_LUCIDITY, role: 'healer' };
  const holding = (questId: 'fighter-trial' | 'healer-trial'): QuestLog => ({ active: [{ questId, progress: [0] }], done: [] });
  const fullLog: QuestLog = {
    active: Array.from({ length: SOMNIO_PROTOCOL_CONSTANTS.maxActiveQuests }, () => ({ questId: 'restless-graves' as const, progress: [0] })),
    done: [],
  };
  const conditions: DialogCondition[] = [
    { role: 'none' },
    { role: 'own' },
    { role: 'other' },
    { quest: 'fighter-trial', state: 'offered' },
    { quest: 'fighter-trial', state: 'held' },
    { quest: 'fighter-trial', state: 'done' },
  ];

  it.each([
    ['no role', NO_LUCIDITY, NO_QUESTS, [true, false, false, true, false, false]],
    ['a Fighter, their trial done', fighter, { active: [], done: ['fighter-trial'] }, [false, true, false, false, false, true]],
    ['a Healer, their trial done', healer, { active: [], done: ['healer-trial'] }, [false, false, true, false, false, false]],
    ['no role, holding the trial', NO_LUCIDITY, holding('fighter-trial'), [true, false, false, false, true, false]],
    ['no role, holding another trial', NO_LUCIDITY, holding('healer-trial'), [true, false, false, false, false, false]],
    ['no role, the quest log full', NO_LUCIDITY, fullLog, [true, false, false, false, false, false]],
  ] satisfies [string, Lucidity, QuestLog, boolean[]][])("fits a step at the Fighters' master to %s by its condition", (_case, lucidity, quests, fits) => {
    expect(conditions.map((when) => dialogStepFits(when, { lucidity, quests }, 'fighterMaster'))).toEqual(fits);
  });

  it('fits a step for everyone to anyone', () => {
    expect(dialogStepFits(undefined, { lucidity: fighter, quests: NO_QUESTS }, undefined)).toBe(true);
  });

  it.each([undefined, 'shopkeeper' as const])('fits a step for the own or another role to no one at an NPC offering %s', (service) => {
    for (const lucidity of [NO_LUCIDITY, fighter]) {
      expect(dialogStepFits({ role: 'own' }, { lucidity, quests: NO_QUESTS }, service)).toBe(false);
      expect(dialogStepFits({ role: 'other' }, { lucidity, quests: NO_QUESTS }, service)).toBe(false);
    }
  });

  it.each([
    [undefined, ['none']],
    ['shopkeeper', ['none']],
    ['healerMaster', ['none', 'own', 'other']],
  ] as const)('lets a step at an NPC offering %s be for the roles %j', (service, roles) => {
    expect(listenerRolesFor(service)).toEqual(roles);
  });
});

describe('the committed scripts', () => {
  const npcs = new Map(loadSectorFixtures().flatMap((sector) => sector.npcs.map((npc) => [npc.id, npc] as const)));
  const SCRIPTED = ['pugnax', 'sana', 'tacita', 'libus', 'memor'] as const;
  const heard = (npcId: string, lucidity: Lucidity, quests: QuestLog): string[] => {
    const npc = npcs.get(npcId)!;
    return npc.dialog.filter((step) => dialogStepFits(step.when, { lucidity, quests }, npc.service)).map((step) => step.text);
  };
  const log = (active: QuestId[], done: QuestId[] = []): QuestLog => ({ active: active.map((questId) => ({ questId, progress: [0] })), done });
  const fighter: Lucidity = { ...NO_LUCIDITY, role: 'fighter' };
  const healer: Lucidity = { ...NO_LUCIDITY, role: 'healer' };
  const mystic: Lucidity = { ...NO_LUCIDITY, role: 'mystic' };

  const handOff = 'Memor keeps the Graveyard beyond the West Meadow. He has asked for one of mine.';
  const pugnax = {
    offer: 'Whoever would learn from me first drives off a nightmare. The Ghosts in the Arena will do.',
    held: 'Has a nightmare fled from you yet, $name? Then tell me. If not, the Arena has Ghosts.',
    own: 'Meet a blow with your guard, not your face. Then strike back harder.',
    other: 'You walk another path now. Walk it upright.',
    lore: 'In the north the dream frays. Go and see for yourself, but do not go alone.',
  };
  const sana = {
    offer: 'Whoever would heal first walks into the North Wood and comes back without striking a blow.',
    held: 'Into the North Wood, $name, and back again. Strike nothing, however it tempts you.',
    own: 'Mend them before they fall. Drawing back costs you far more.',
    other: 'You learn elsewhere. Still, when someone falls, call for a Healer.',
    lore: 'Only a Healer draws back the fallen. Leave no one lying.',
  };
  const tacita = {
    offer: 'Whoever would learn from me first finds three places the dream keeps to itself.',
    take: 'Take my trial, and I will tell you where they lie.',
    west: 'Where the sun sets, the West Meadow keeps a ring of open grass, far out and south of the road.',
    east: 'Where it rises, the Autumn Wood hides a glade just past the gate, north of the road.',
    north: 'Toward the north, the North Meadow lies open west of the road.',
    stand: 'Stand in all three, then come back to me.',
    own: 'Listen at night, $name. The dream says more to those who keep still.',
    other: 'You learn elsewhere now. The dream still speaks to anyone who keeps still.',
    close: 'The dream keeps its secrets from those who hurry.',
  };
  const libus = {
    offer: 'New here? I have an errand for you that will show you the town.',
    mercus: 'Call on Mercus first. His shop is on the square, and the bounty board stands there too.',
    masters: 'Then meet the masters. Pugnax and Sana keep their halls on the square.',
    tower: "The Mystics' tower stands there as well, but it opens only at night.",
    done: 'You know your way about now, $name. The masters will teach you the rest.',
    running: 'And running is forbidden in here!',
  };
  const memor = {
    keeper: 'I am Memor. I keep the names of all who lie here, so the dream does not forget them.',
    thin: 'This is a thin place. The dream wears through here, and what was buried climbs back out.',
    word: 'Your master sent word ahead. I am glad you came.',
    see: 'See what stirs among the graves.',
    graves: 'The graves south of the church are restless. Drive back what climbs out.',
    skulls: 'The warriors among them carry skulls cracked by something older than this church.',
    bring: 'Bring me some, and I will learn what wakes them.',
    crypt: 'Below the tomb lies the crypt, and past it the chamber of the Necromancer.',
    alone: 'He keeps the dead from rest. Do not go down alone.',
    gone: 'The Necromancer is gone, for now. The names here sleep easier, $name.',
  };
  const broughtWord: QuestId[] = ['fighter-trial', 'word-for-memor-fighter'];
  const fighterWhoBroughtWord = {
    pugnax: [pugnax.own, pugnax.lore],
    sana: [sana.other, sana.lore],
    tacita: [tacita.other, tacita.close],
    libus: [libus.offer, libus.running],
  };

  it.each([
    [
      'a newcomer with no role, offered the errand',
      NO_LUCIDITY,
      NO_QUESTS,
      {
        pugnax: [pugnax.offer, pugnax.lore],
        sana: [sana.offer, sana.lore],
        tacita: [tacita.offer, tacita.take, tacita.close],
        libus: [libus.offer, libus.running],
        memor: [memor.keeper, memor.thin, memor.see],
      },
    ],
    [
      "no role, holding the Fighters' trial",
      NO_LUCIDITY,
      log(['fighter-trial']),
      {
        pugnax: [pugnax.held, pugnax.lore],
        sana: [sana.lore],
        tacita: [tacita.close],
        libus: [libus.offer, libus.running],
        memor: [memor.keeper, memor.thin, memor.see],
      },
    ],
    [
      "no role, holding the Healers' trial",
      NO_LUCIDITY,
      log(['healer-trial']),
      {
        pugnax: [pugnax.lore],
        sana: [sana.held, sana.lore],
        tacita: [tacita.close],
        libus: [libus.offer, libus.running],
        memor: [memor.keeper, memor.thin, memor.see],
      },
    ],
    [
      "no role, holding the Mystics' trial",
      NO_LUCIDITY,
      log(['mystic-trial']),
      {
        pugnax: [pugnax.lore],
        sana: [sana.lore],
        tacita: [tacita.west, tacita.east, tacita.north, tacita.stand, tacita.close],
        libus: [libus.offer, libus.running],
        memor: [memor.keeper, memor.thin, memor.see],
      },
    ],
    [
      'no role, the quest log full',
      NO_LUCIDITY,
      log(Array.from({ length: SOMNIO_PROTOCOL_CONSTANTS.maxActiveQuests }, () => 'restless-graves' as const)),
      {
        pugnax: [pugnax.lore],
        sana: [sana.lore],
        tacita: [tacita.close],
        libus: [libus.running],
        memor: [memor.keeper, memor.thin, memor.graves],
      },
    ],
    [
      'a Fighter, their trial done',
      fighter,
      log([], ['fighter-trial']),
      {
        pugnax: [pugnax.own, handOff, pugnax.lore],
        sana: [sana.other, sana.lore],
        tacita: [tacita.other, tacita.close],
        libus: [libus.offer, libus.running],
        memor: [memor.keeper, memor.thin, memor.see],
      },
    ],
    [
      'a Healer, their trial done',
      healer,
      log([], ['healer-trial']),
      {
        pugnax: [pugnax.other, pugnax.lore],
        sana: [sana.own, handOff, sana.lore],
        tacita: [tacita.other, tacita.close],
        libus: [libus.offer, libus.running],
        memor: [memor.keeper, memor.thin, memor.see],
      },
    ],
    [
      'a Mystic, their trial done',
      mystic,
      log([], ['mystic-trial']),
      {
        pugnax: [pugnax.other, pugnax.lore],
        sana: [sana.other, sana.lore],
        tacita: [tacita.own, handOff, tacita.close],
        libus: [libus.offer, libus.running],
        memor: [memor.keeper, memor.thin, memor.see],
      },
    ],
    [
      'a Fighter carrying word to Memor',
      fighter,
      log(['word-for-memor-fighter'], ['fighter-trial']),
      {
        pugnax: [pugnax.own, pugnax.lore],
        sana: [sana.other, sana.lore],
        tacita: [tacita.other, tacita.close],
        libus: [libus.offer, libus.running],
        memor: [memor.keeper, memor.thin, memor.word, memor.see],
      },
    ],
    [
      'a Healer carrying word to Memor',
      healer,
      log(['word-for-memor-healer'], ['healer-trial']),
      {
        pugnax: [pugnax.other, pugnax.lore],
        sana: [sana.own, sana.lore],
        tacita: [tacita.other, tacita.close],
        libus: [libus.offer, libus.running],
        memor: [memor.keeper, memor.thin, memor.word, memor.see],
      },
    ],
    [
      'a Mystic carrying word to Memor',
      mystic,
      log(['word-for-memor-mystic'], ['mystic-trial']),
      {
        pugnax: [pugnax.other, pugnax.lore],
        sana: [sana.other, sana.lore],
        tacita: [tacita.own, tacita.close],
        libus: [libus.offer, libus.running],
        memor: [memor.keeper, memor.thin, memor.word, memor.see],
      },
    ],
    [
      'no role, on the errand',
      NO_LUCIDITY,
      log(['newcomer-errand']),
      {
        pugnax: [pugnax.offer, pugnax.lore],
        sana: [sana.offer, sana.lore],
        tacita: [tacita.offer, tacita.take, tacita.close],
        libus: [libus.mercus, libus.masters, libus.tower, libus.running],
        memor: [memor.keeper, memor.thin, memor.see],
      },
    ],
    [
      'no role, the errand done',
      NO_LUCIDITY,
      log([], ['newcomer-errand']),
      {
        pugnax: [pugnax.offer, pugnax.lore],
        sana: [sana.offer, sana.lore],
        tacita: [tacita.offer, tacita.take, tacita.close],
        libus: [libus.done, libus.running],
        memor: [memor.keeper, memor.thin, memor.see],
      },
    ],
    [
      'a Fighter who brought word, before the graves',
      fighter,
      log([], broughtWord),
      { ...fighterWhoBroughtWord, memor: [memor.keeper, memor.thin, memor.see] },
    ],
    [
      'a Fighter who brought word, holding the graves',
      fighter,
      log(['restless-graves'], broughtWord),
      { ...fighterWhoBroughtWord, memor: [memor.keeper, memor.thin, memor.graves] },
    ],
    [
      'a Fighter who brought word, the graves done',
      fighter,
      log([], [...broughtWord, 'restless-graves']),
      { ...fighterWhoBroughtWord, memor: [memor.keeper, memor.thin, memor.skulls, memor.bring] },
    ],
    [
      'a Fighter who brought word, the skulls done',
      fighter,
      log([], [...broughtWord, 'restless-graves', 'cracked-skulls']),
      { ...fighterWhoBroughtWord, memor: [memor.keeper, memor.thin, memor.crypt, memor.alone] },
    ],
    [
      'a Fighter who brought word, the crypt done',
      fighter,
      log([], [...broughtWord, 'restless-graves', 'cracked-skulls', 'into-the-crypt']),
      { ...fighterWhoBroughtWord, memor: [memor.keeper, memor.thin, memor.gone] },
    ],
  ] satisfies [string, Lucidity, QuestLog, Record<(typeof SCRIPTED)[number], string[]>][])(
    'says to %s exactly the steps that fit them',
    (_case, lucidity, quests, expected) => {
      expect(Object.fromEntries(SCRIPTED.map((npcId) => [npcId, heard(npcId, lucidity, quests)]))).toEqual(expected);
    },
  );
});

describe('dialog lines', () => {
  it('writes the name wherever the step asks for it', () => {
    expect(dialogLine('$name! Welcome, $name.', 'Mira')).toBe('Mira! Welcome, Mira.');
  });

  it('writes a name that reads as a replacement pattern as it is', () => {
    expect(dialogLine('Hello, $name.', "$&$'$`$$")).toBe("Hello, $&$'$`$$.");
  });

  it.each([
    ['no name, at the cap', 'a'.repeat(SAY), true],
    ['no name, one byte over', 'a'.repeat(SAY + 1), false],
    ['one name, at the cap once it is the longest name', `${'a'.repeat(SAY - NAME)}$name`, true],
    ['one name, one byte over once it is the longest name', `${'a'.repeat(SAY - NAME + 1)}$name`, false],
    ['one name, at the cap only as written', `${'a'.repeat(SAY - '$name'.length)}$name`, false],
    ['two names, at the cap once they are the longest name', `$name${'a'.repeat(SAY - 2 * NAME)}$name`, true],
    ['two names, one byte over once they are the longest name', `$name${'a'.repeat(SAY - 2 * NAME + 1)}$name`, false],
    ['two-byte characters, at the cap', `${'ü'.repeat((SAY - NAME) / 2)}$name`, true],
    ['two-byte characters, one character over', `${'ü'.repeat((SAY - NAME) / 2 + 1)}$name`, false],
  ])('judges a step with %s by its longest line', (_case, step, fits) => {
    expect(dialogLineFits(step)).toBe(fits);
    expect(utf8ByteLength(dialogLine(step, 'n'.repeat(NAME))) <= SAY).toBe(fits);
  });

  it('measures the longest line as the one spoken to a name at the identifier cap', () => {
    expect(utf8ByteLength(dialogLine(`${'a'.repeat(SAY - NAME)}$name`, 'n'.repeat(NAME)))).toBe(256);
  });
});

describe('the line budget', () => {
  it.each([
    ['100 graphemes', 'a'.repeat(100), true],
    ['101 graphemes', 'a'.repeat(101), false],
    ['one name in 90 written graphemes, counted as 12', `${'a'.repeat(85)}$name`, true],
    ['two names in 90 written graphemes', `$name${'a'.repeat(80)}$name`, false],
    ['100 emoji, each one grapheme', '👨‍👩‍👧'.repeat(100), true],
    ['101 emoji', '👨‍👩‍👧'.repeat(101), false],
  ])('judges %s', (_case, text, fits) => {
    expect(dialogLineInBudget(text)).toBe(fits);
  });
});

describe('reading time', () => {
  it('holds an NPC for the longest translation of its line', () => {
    const step = 'Only a Healer draws back the fallen. Leave no one lying.';
    const german = localizedDialogLine(step, 'de', 'Mira');
    expect(speechReadSeconds(german)).toBeGreaterThan(speechReadSeconds(step));
    expect(npcReadSeconds(step, 'Mira')).toBe(speechReadSeconds(german));
  });
});

describe('the dialog catalog', () => {
  const names = (line: string): number => line.split('$name').length - 1;

  it('translates every greeting and step a committed NPC says', () => {
    const lines = loadSectorFixtures().flatMap((sector) =>
      sector.npcs.flatMap((npc) => [...(npc.greeting === undefined ? [] : [npc.greeting]), ...npc.dialog.map((step) => step.text)]),
    );
    expect(lines.filter((line) => !Object.hasOwn(dialogJSON, line))).toEqual([]);
  });

  it.each(Object.entries(dialogJSON))(
    'keeps %j English as its key, naming the dreamer as often in German, each language said within the line budget and the say cap',
    (step, { en, de }) => {
      expect(en).toBe(step);
      expect(names(de)).toBe(names(step));
      for (const line of [en, de]) {
        expect(line.trim()).not.toBe('');
        expect(dialogLineInBudget(line)).toBe(true);
        expect(dialogLineFits(line)).toBe(true);
      }
    },
  );

  it('holds every translation to the rules of every catalog', () => {
    expect(catalogViolations(readCatalog(dialogJSON), Object.keys(dialogJSON))).toEqual([]);
  });

  it('says a step in the language asked for, and one it does not hold as written', () => {
    expect(localizedDialogLine('Welcome, $name!', 'de', 'Mira')).toBe('Willkommen, Mira!');
    expect(localizedDialogLine('Welcome, $name!', 'en', 'Mira')).toBe('Welcome, Mira!');
    expect(localizedDialogLine('Hello, $name.', 'de', 'Mira')).toBe('Hello, Mira.');
    expect(localizedDialogLine('constructor', 'de', 'Mira')).toBe('constructor');
  });
});
