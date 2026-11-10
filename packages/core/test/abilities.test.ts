import { ROLES } from '@somnio/protocol';
import { describe, expect, it } from 'vitest';
import {
  ABILITIES,
  GLOBAL_COOLDOWN_SECONDS,
  abilitiesTaught,
  abilityAllowed,
  abilityRecipient,
  abilityTeaching,
  areaRecipients,
  isAbilityId,
} from '../src/abilities.ts';
import type { Ability, AbilityBody, AbilityId, AbilityState } from '../src/abilities.ts';
import { engageAction, handAllows } from '../src/combat.ts';
import type { EngageTarget } from '../src/combat.ts';
import { EFFECTS, scaled } from '../src/effects.ts';
import { ITEMS } from '../src/items.ts';
import { TEACHING_IDS, teaching } from '../src/lucidity.ts';
import { ranks } from './support/ranks.ts';

const ABILITY_IDS = Object.keys(ABILITIES) as AbilityId[];

interface Named extends AbilityBody {
  name: string;
}

const caster: Named = { name: 'caster', kind: 'dreamer', fallen: false, x: 0, z: 0, radius: 0.3 };
const ghost = (x: number): Named => ({ name: 'ghost', kind: 'nightmare', fallen: false, x, z: 0, radius: 0.3 });
const npc: Named = { name: 'npc', kind: undefined, fallen: false, x: 1, z: 0, radius: 0.3 };
const dreamer = (x: number, fallen = false): Named => ({ name: 'dreamer', kind: 'dreamer', fallen, x, z: 0, radius: 0.3 });

/** One ability of each aim, each reaching 1 m beyond contact: 1.6 m centre to centre between two bodies of 0.3 m. */
const aimed = (aim: Ability['aim']): Ability => ({ pool: 'spirit', cost: 0, cooldownSeconds: 0, aim, range: 1, does: { kind: 'leap', metresPerSecond: 1 } });

describe('the table', () => {
  /** An ability id travels the wire, so the table is pinned, not only its use. */
  it('pins every ability', () => {
    expect(ABILITIES).toEqual({
      cleave: {
        pool: 'balance',
        cost: 16,
        cooldownSeconds: 6,
        aim: 'area',
        range: 0.25,
        among: 'nightmare',
        hand: 'mainHand',
        does: { kind: 'strike', damageShare: { atRank1: 0.6, perRank: 0.2 } },
      },
      challenge: {
        pool: 'balance',
        cost: 10,
        cooldownSeconds: 20,
        aim: 'area',
        range: 5,
        among: 'nightmare',
        hand: 'mainHand',
        does: { kind: 'effect', effectId: 'challenged' },
      },
      brace: { pool: 'balance', cost: 15, cooldownSeconds: 15, aim: 'self', range: 0, hand: 'mainHand', does: { kind: 'effect', effectId: 'braced' } },
      lunge: {
        pool: 'balance',
        cost: 12,
        cooldownSeconds: { atRank1: 10, perRank: -2 },
        aim: 'enemy',
        range: 3,
        hand: 'mainHand',
        does: { kind: 'leap', metresPerSecond: 6 },
      },
      rally: {
        pool: 'balance',
        cost: 10,
        cooldownSeconds: 30,
        aim: 'area',
        range: 11.4,
        among: 'dreamer',
        hand: 'mainHand',
        does: { kind: 'restore', pool: 'balance', amount: { atRank1: 20, perRank: 5 } },
      },
    });
    expect(GLOBAL_COOLDOWN_SECONDS).toBe(0.75);
  });

  it('teaches each ability by exactly one teaching, the Fighter its five in teaching order', () => {
    for (const id of ABILITY_IDS) expect(TEACHING_IDS.filter((taught) => teaching(taught).ability === id)).toEqual([abilityTeaching(id)]);
    expect(TEACHING_IDS.filter((id) => teaching(id).ability !== undefined && teaching(id).role === 'fighter')).toEqual([
      'cleave',
      'challenge',
      'brace',
      'lunge',
      'rally',
    ]);
  });

  it('lists the abilities held ranks teach in teaching order, not the order they were learned', () => {
    expect(abilitiesTaught(ranks({ strike: 2, 'balance-recovery': 1, rally: 1, lunge: 1, guard: 1, cleave: 2 }))).toEqual(['cleave', 'lunge', 'rally']);
    expect(abilitiesTaught(ranks({ strike: 5 }))).toEqual([]);
  });

  it('knows the abilities, and nothing inherited from an object', () => {
    expect(isAbilityId('brace')).toBe(true);
    expect(isAbilityId('Brace')).toBe(false);
    expect(isAbilityId('toString')).toBe(false);
  });

  it("fits every role's abilities in the belt's five ability slots", () => {
    for (const role of ROLES)
      expect(TEACHING_IDS.filter((id) => teaching(id).role === role && teaching(id).ability !== undefined).length).toBeLessThanOrEqual(5);
  });

  it("keeps every scaled number positive through its teaching's last rank", () => {
    for (const id of ABILITY_IDS) {
      const ability: Ability = ABILITIES[id];
      const deed = ability.does;
      for (let rank = 1; rank <= teaching(abilityTeaching(id)).maxRank; rank += 1) {
        expect(scaled(ability.cooldownSeconds, rank)).toBeGreaterThan(0);
        if (deed.kind === 'effect') expect(scaled(EFFECTS[deed.effectId].seconds, rank)).toBeGreaterThan(0);
        if (deed.kind === 'strike') expect(scaled(deed.damageShare, rank)).toBeGreaterThan(0);
        if (deed.kind === 'restore') expect(scaled(deed.amount, rank)).toBeGreaterThan(0);
      }
    }
  });
});

describe('the hand rule', () => {
  const inHand = [undefined, ...Object.keys(ITEMS)];

  it("is slot 1's: the main hand attacks a nightmare and the Moonstone mends a dreamer, by the same reading of what is in hand", () => {
    for (const item of inHand) {
      expect(handAllows('mainHand', item)).toBe(engageAction('nightmare', 'fighter', item) === 'attack');
      expect(handAllows('moonstone', item)).toBe(engageAction('dreamer', 'healer', item) === 'mend');
    }
  });

  it("asks bare hands or a weapon of the Fighter's kit", () => {
    for (const id of ABILITY_IDS) expect(ABILITIES[id].hand).toBe('mainHand');
    expect(inHand.filter((item) => handAllows('mainHand', item))).toEqual([undefined, 'dagger', 'cudgel', 'sword', 'mace']);
  });
});

describe('abilityRecipient', () => {
  it.each([
    ['a nightmare in range', ghost(1.6), 'ghost', 'caster'],
    ['a nightmare out of range', ghost(1.61), undefined, 'caster'],
    ['an NPC', npc, undefined, 'caster'],
    ['nothing', undefined, undefined, 'caster'],
    ['the caster themselves', caster, undefined, 'caster'],
    ['another standing dreamer in range', dreamer(1.6), undefined, 'dreamer'],
    ['another standing dreamer out of range', dreamer(1.61), undefined, undefined],
    ['a fallen dreamer in range', dreamer(1, true), undefined, undefined],
  ] as const)('with %s targeted, lands an enemy ability on %s and an ally ability on %s', (_label, target, enemy, ally) => {
    expect(abilityRecipient(aimed('enemy'), caster, target)?.name).toBe(enemy);
    expect(abilityRecipient(aimed('ally'), caster, target)?.name).toBe(ally);
  });

  it('lands a self ability on the caster and centres an area ability on them, whatever is targeted', () => {
    for (const target of [ghost(1), npc, undefined, dreamer(1), dreamer(1, true), dreamer(40)]) {
      expect(abilityRecipient(aimed('self'), caster, target)).toBe(caster);
      expect(abilityRecipient(aimed('area'), caster, target)).toBe(caster);
    }
  });
});

describe('areaRecipients', () => {
  const round = (among: EngageTarget): Ability => ({ ...aimed('area'), among });

  it('lands on the standing bodies of its kind within its range of the caster', () => {
    const bodies = [ghost(1.6), ghost(-1.6), ghost(1.61), dreamer(1), dreamer(1, true), npc, caster];
    expect(areaRecipients(round('nightmare'), caster, bodies)).toEqual([bodies[0], bodies[1]]);
    expect(areaRecipients(round('dreamer'), caster, bodies)).toEqual([bodies[3], caster]);
  });
});

describe('abilityAllowed', () => {
  const ready: AbilityState<Named> = {
    caster,
    ranks: ranks({ strike: 2, lunge: 1, guard: 1, brace: 1 }),
    itemInHand: 'cudgel',
    energy: { balanceCurrent: ABILITIES.lunge.cost, spiritCurrent: 0 },
    now: 10,
    globalReadyAt: 10,
    readyAt: { lunge: 10 },
  };
  const inReach = ghost(1);

  it('lands on the recipient once every need is met, a cooldown ending at this moment included', () => {
    expect(abilityAllowed(ready, 'lunge', inReach)).toBe(inReach);
    expect(abilityAllowed({ ...ready, itemInHand: undefined }, 'lunge', inReach)).toBe(inReach);
  });

  it.each([
    ['the caster has fallen', { caster: { ...caster, fallen: true } }],
    ['the teaching is not held', { ranks: ranks({ strike: 2 }) }],
    ['what is in hand does not swing', { itemInHand: 'moonstone' }],
    ['the pool is short of the cost', { energy: { balanceCurrent: ABILITIES.lunge.cost - 1, spiritCurrent: 100 } }],
    ['its own cooldown runs', { readyAt: { lunge: 10.1 } }],
    ['the global cooldown runs', { globalReadyAt: 10.1 }],
  ] as const)('refuses while %s', (_label, change) => {
    expect(abilityAllowed({ ...ready, ...change }, 'lunge', inReach)).toBeUndefined();
  });

  it('refuses with no recipient', () => {
    expect(abilityAllowed(ready, 'lunge', undefined)).toBeUndefined();
    expect(abilityAllowed(ready, 'lunge', ghost(10))).toBeUndefined();
  });

  it("is held back only by the ability's own cooldown, not another's", () => {
    expect(abilityAllowed({ ...ready, energy: { balanceCurrent: 100, spiritCurrent: 0 }, readyAt: { lunge: 99 } }, 'brace', undefined)).toBe(caster);
  });
});
