import { ROLES } from '@somnio/protocol';
import { describe, expect, it } from 'vitest';
import {
  ABILITIES,
  GLOBAL_COOLDOWN_SECONDS,
  abilitiesTaught,
  ability,
  abilityAllowed,
  abilityChannelSeconds,
  abilityRecipient,
  abilityRefusal,
  abilityTeaching,
  areaRecipients,
  isAbilityId,
} from '../src/abilities.ts';
import type { Ability, AbilityBody, AbilityId, AbilityState } from '../src/abilities.ts';
import { engageAction, handAllows } from '../src/combat.ts';
import type { EngageTarget } from '../src/combat.ts';
import { effect, scaled } from '../src/effects.ts';
import { BASE_ITEMS } from '../src/items.ts';
import type { BaseItemId } from '../src/items.ts';
import { TEACHING_IDS, teaching } from '../src/lucidity.ts';
import { holding, plain } from './support/items.ts';
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
const aimed = (aim: Ability['aim']): Ability => ({
  pool: 'spirit',
  cost: 0,
  cooldownSeconds: 0,
  aim,
  range: 1,
  hand: 'mainHand',
  does: { kind: 'leap', metresPerSecond: 1 },
});

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
      'deep-mend': {
        pool: 'spirit',
        cost: 18,
        cooldownSeconds: 6,
        aim: 'ally',
        range: 5,
        hand: 'moonstone',
        channelSeconds: { atRank1: 1.5, perRank: -0.15 },
        does: { kind: 'heal', amount: { atRank1: 35, perRank: 10 } },
      },
      renewal: { pool: 'spirit', cost: 15, cooldownSeconds: 3, aim: 'ally', range: 5, hand: 'moonstone', does: { kind: 'effect', effectId: 'renewing' } },
      radiance: {
        pool: 'spirit',
        cost: 22,
        cooldownSeconds: 12,
        aim: 'area',
        range: 4.4,
        among: 'dreamer',
        hand: 'moonstone',
        does: { kind: 'heal', amount: { atRank1: 15, perRank: 5 } },
      },
      calm: {
        pool: 'spirit',
        cost: 10,
        cooldownSeconds: 20,
        aim: 'self',
        range: 0,
        hand: 'moonstone',
        does: { kind: 'calm', threatKept: 0.5, effectId: 'calmed' },
      },
      ward: { pool: 'spirit', cost: 15, cooldownSeconds: 12, aim: 'ally', range: 6, hand: 'focus', does: { kind: 'effect', effectId: 'warded' } },
      weaken: { pool: 'spirit', cost: 12, cooldownSeconds: 12, aim: 'enemy', range: 6, hand: 'focus', does: { kind: 'effect', effectId: 'weakened' } },
      bind: { pool: 'spirit', cost: 14, cooldownSeconds: 15, aim: 'enemy', range: 6, hand: 'focus', does: { kind: 'effect', effectId: 'bound' } },
      'dream-bolt': {
        pool: 'spirit',
        cost: 12,
        cooldownSeconds: 3,
        aim: 'enemy',
        range: 8,
        hand: 'focus',
        does: { kind: 'harm', damage: { atRank1: 12, perRank: 3 } },
      },
      veil: {
        pool: 'spirit',
        cost: 25,
        cooldownSeconds: 45,
        aim: 'area',
        range: 4.4,
        among: 'dreamer',
        hand: 'focus',
        does: { kind: 'effect', effectId: 'veiled' },
      },
    });
    expect(GLOBAL_COOLDOWN_SECONDS).toBe(0.75);
  });

  it('teaches each ability by exactly one teaching, the Fighter its five, the Healer its four, and the Mystic its five in teaching order', () => {
    for (const id of ABILITY_IDS) expect(TEACHING_IDS.filter((taught) => teaching(taught).ability === id)).toEqual([abilityTeaching(id)]);
    const taught = (role: string) => TEACHING_IDS.filter((id) => teaching(id).ability !== undefined && teaching(id).role === role);
    expect(taught('fighter')).toEqual(['cleave', 'challenge', 'brace', 'lunge', 'rally']);
    expect(taught('healer')).toEqual(['deep-mend', 'renewal', 'radiance', 'calm']);
    expect(taught('mystic')).toEqual(['ward', 'weaken', 'bind', 'dream-bolt', 'veil']);
  });

  it('channels Deep mend alone, shorter at each rank, and lands every other ability at once', () => {
    expect([1, 2, 3].map((rank) => abilityChannelSeconds('deep-mend', rank))).toEqual([1.5, 1.35, 1.2]);
    expect(ABILITY_IDS.filter((id) => abilityChannelSeconds(id, 1) !== undefined)).toEqual(['deep-mend']);
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
        // An ability's effect ends: only an elite's trait holds without end.
        if (deed.kind === 'effect') expect(scaled(effect(deed.effectId).seconds!, rank)).toBeGreaterThan(0);
        if (deed.kind === 'strike') expect(scaled(deed.damageShare, rank)).toBeGreaterThan(0);
        if (deed.kind === 'harm') expect(scaled(deed.damage, rank)).toBeGreaterThan(0);
        if (deed.kind === 'restore' || deed.kind === 'heal') expect(scaled(deed.amount, rank)).toBeGreaterThan(0);
        if (ability.channelSeconds !== undefined) expect(scaled(ability.channelSeconds, rank)).toBeGreaterThan(0);
      }
    }
  });
});

describe('the hand rule', () => {
  const held = [undefined, ...(Object.keys(BASE_ITEMS) as BaseItemId[]).map(plain)];
  const allowing = (fits: (item: ReturnType<typeof plain> | undefined) => boolean) => held.filter(fits).map((item) => item?.baseId);

  it("is slot 1's: the main hand attacks a nightmare and the Moonstone mends a dreamer, by the same reading of the hands", () => {
    for (const mainHand of held) {
      for (const offHand of held) {
        const hands = holding(mainHand, offHand);
        expect(handAllows('mainHand', hands)).toBe(engageAction('nightmare', 'fighter', hands) === 'attack');
        expect(handAllows('moonstone', hands)).toBe(engageAction('dreamer', 'healer', hands) === 'mend');
      }
    }
  });

  it("asks an empty main hand or a weapon in it of the Fighter's kit, the Moonstone in the off hand of the Healer's, and a focus there of the Mystic's", () => {
    const kits = Object.fromEntries(ABILITY_IDS.map((id) => [teaching(abilityTeaching(id)).role, new Set<string>()]));
    for (const id of ABILITY_IDS) kits[teaching(abilityTeaching(id)).role]!.add(ability(id).hand);
    expect(kits).toEqual({ fighter: new Set(['mainHand']), healer: new Set(['moonstone']), mystic: new Set(['focus']) });
    expect(allowing((item) => handAllows('mainHand', holding(item, undefined)))).toEqual([
      undefined,
      'dagger',
      'cudgel',
      'sword',
      'mace',
      'bone-dagger',
      'sabre',
      'war-axe',
    ]);
    expect(allowing((item) => handAllows('moonstone', holding(undefined, item)))).toEqual(['moonstone']);
    expect(allowing((item) => handAllows('focus', holding(undefined, item)))).toEqual(['wand', 'skull-staff']);
  });

  it('reads each need in its own hand alone', () => {
    for (const item of held) {
      expect(handAllows('mainHand', holding(undefined, item))).toBe(true);
      expect(handAllows('moonstone', holding(item, undefined))).toBe(false);
      expect(handAllows('focus', holding(item, undefined))).toBe(false);
    }
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
    hands: holding(plain('cudgel'), undefined),
    energy: { balanceCurrent: ABILITIES.lunge.cost, spiritCurrent: 0 },
    now: 10,
    globalReadyAt: 10,
    readyAt: { lunge: 10 },
    channelling: false,
  };
  const inReach = ghost(1);

  it('lands on the recipient once every need is met, a cooldown ending at this moment included', () => {
    expect(abilityAllowed(ready, 'lunge', inReach)).toBe(inReach);
    expect(abilityAllowed({ ...ready, hands: {} }, 'lunge', inReach)).toBe(inReach);
  });

  it.each([
    ['the caster has fallen', { caster: { ...caster, fallen: true } }, 'fallen'],
    ['the teaching is not held', { ranks: ranks({ strike: 2 }) }, 'untaught'],
    ['what is in the main hand does not swing', { hands: holding(plain('moonstone'), undefined) }, 'hand'],
    ['the pool is short of the cost', { energy: { balanceCurrent: ABILITIES.lunge.cost - 1, spiritCurrent: 100 } }, 'cost'],
    ['its own cooldown runs', { readyAt: { lunge: 10.1 } }, 'cooldown'],
    ['the global cooldown runs', { globalReadyAt: 10.1 }, 'cooldown'],
    ['a channel of theirs is under way', { channelling: true }, 'channelling'],
  ] as const)('refuses while %s, naming it', (_label, change, refusal) => {
    expect(abilityAllowed({ ...ready, ...change }, 'lunge', inReach)).toBeUndefined();
    expect(abilityRefusal({ ...ready, ...change }, 'lunge', inReach)).toBe(refusal);
  });

  it('refuses with no recipient', () => {
    expect(abilityAllowed(ready, 'lunge', undefined)).toBeUndefined();
    expect(abilityAllowed(ready, 'lunge', ghost(10))).toBeUndefined();
    expect([abilityRefusal(ready, 'lunge', undefined), abilityRefusal(ready, 'lunge', inReach)]).toEqual(['recipient', undefined]);
  });

  it('names the first need missed, in the order the rule checks them', () => {
    const moonstoneInMainHand = holding(plain('moonstone'), undefined);
    expect(abilityRefusal({ ...ready, channelling: true, hands: moonstoneInMainHand, globalReadyAt: 11 }, 'lunge', undefined)).toBe('channelling');
    expect(abilityRefusal({ ...ready, hands: moonstoneInMainHand, globalReadyAt: 11 }, 'lunge', undefined)).toBe('hand');
  });

  it("is held back only by the ability's own cooldown, not another's", () => {
    expect(abilityAllowed({ ...ready, energy: { balanceCurrent: 100, spiritCurrent: 0 }, readyAt: { lunge: 99 } }, 'brace', undefined)).toBe(caster);
  });
});
