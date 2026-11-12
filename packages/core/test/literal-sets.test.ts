import { GAITS, SOMNIO_PROTOCOL_CONSTANTS } from '@somnio/protocol';
import { describe, expect, it } from 'vitest';
import { ABILITIES } from '../src/abilities.ts';
import { SOMNIO_CONSTANTS } from '../src/constants.ts';
import { EFFECTS } from '../src/effects.ts';
import { gaitMetresPerSecond } from '../src/gait.ts';
import { AFFIXES, rollItem } from '../src/affixes.ts';
import { hashString, seededSequence } from '../src/hash.ts';
import { BASE_ITEMS } from '../src/items.ts';
import { FIRST_TEACHING, TEACHINGS, TEACHING_IDS, TRIALS, isTeachingId, taskSpec, teaching } from '../src/lucidity.ts';
import { BOSS_MOVES, ELITE_TRAITS, ELITE_TRAIT_IDS, MONSTER_KINDS, MONSTER_KIND_IDS, bossMoves, isEliteTraitId, monsterKind } from '../src/monsterKinds.ts';
import { PEOPLES } from '../src/people.ts';
import { SPEECH } from '../src/speech.ts';

/**
 * Literal pins for the string sets and tables this package owns. Their members are persisted
 * (`people`, a base id, an affix id) or written into sector files (`kind`), so a renamed member would round-trip
 * cleanly through every codec test while orphaning every saved row that carries the old name.
 */
describe('literal sets', () => {
  it('pins the peoples', () => {
    expect(PEOPLES).toEqual(['vigils', 'sopors', 'umbrae', 'lumina']);
  });

  it('pins the base items', () => {
    expect(BASE_ITEMS).toEqual({
      dagger: { labelKey: 'Dagger', slot: 'mainHand', tier: 1, weapon: { damage: 6, balanceCost: 10 } },
      cudgel: { labelKey: 'Cudgel', slot: 'mainHand', tier: 1, weapon: { damage: 8, balanceCost: 18 } },
      sword: { labelKey: 'Short sword', slot: 'mainHand', tier: 1, weapon: { damage: 11, balanceCost: 24 } },
      mace: { labelKey: 'Mace', slot: 'mainHand', tier: 1, weapon: { damage: 14, balanceCost: 32 } },
      buckler: { labelKey: 'Buckler', slot: 'offHand', tier: 1, implicit: { guard: 2 } },
      shield: { labelKey: 'Round shield', slot: 'offHand', tier: 1, implicit: { guard: 4 } },
      moonstone: { labelKey: 'Moonstone', slot: 'offHand', tier: 1, trialOnly: true },
      wand: { labelKey: 'Wand', slot: 'offHand', tier: 1, focus: true },
      'bone-dagger': { labelKey: 'Bone dagger', slot: 'mainHand', tier: 3, weapon: { damage: 10, balanceCost: 12 } },
      sabre: { labelKey: 'Sabre', slot: 'mainHand', tier: 3, weapon: { damage: 18, balanceCost: 26 } },
      'war-axe': { labelKey: 'War axe', slot: 'mainHand', tier: 3, weapon: { damage: 24, balanceCost: 36 } },
      'iron-buckler': { labelKey: 'Iron buckler', slot: 'offHand', tier: 3, implicit: { guard: 5 } },
      'skull-shield': { labelKey: 'Skull shield', slot: 'offHand', tier: 3, implicit: { guard: 9 } },
      'skull-staff': { labelKey: 'Skull staff', slot: 'offHand', tier: 3, focus: true, implicit: { spiritMax: 10 } },
      cap: { labelKey: 'Leather cap', slot: 'head', tier: 1, implicit: { guard: 1 } },
      tunic: { labelKey: 'Padded tunic', slot: 'chest', tier: 1, implicit: { guard: 3 } },
      gloves: { labelKey: 'Leather gloves', slot: 'hands', tier: 1, implicit: { guard: 1 } },
      trousers: { labelKey: 'Leather trousers', slot: 'legs', tier: 1, implicit: { guard: 2 } },
      boots: { labelKey: 'Leather boots', slot: 'feet', tier: 1, implicit: { guard: 1 } },
      amulet: { labelKey: 'Amulet', slot: 'neck', tier: 1, implicit: { healthMax: 5 } },
      ring: { labelKey: 'Iron ring', slot: 'ring', tier: 1, implicit: { healthMax: 2 } },
    });
  });

  it('pins the affixes', () => {
    expect(AFFIXES).toEqual({
      health: { stat: 'healthMax', slots: ['offHand', 'head', 'chest', 'hands', 'legs', 'feet'], tiers: { 1: [3, 8], 3: [10, 18] } },
      balance: { stat: 'balanceMax', slots: ['mainHand', 'head', 'chest', 'hands', 'legs', 'feet'], tiers: { 1: [3, 8], 3: [10, 18] } },
      spirit: { stat: 'spiritMax', slots: ['offHand', 'neck', 'ring'], tiers: { 1: [3, 8], 3: [10, 18] } },
      damage: { stat: 'damage', slots: ['mainHand', 'hands', 'neck', 'ring'], tiers: { 1: [1, 3], 3: [4, 7] } },
      guard: { stat: 'guard', slots: ['offHand', 'head', 'chest', 'hands', 'legs', 'feet'], tiers: { 1: [1, 3], 3: [4, 7] } },
      'swing-speed': { stat: 'swingSpeed', slots: ['mainHand', 'hands'], tiers: { 1: [3, 8], 3: [9, 14] } },
      'balance-recovery': { stat: 'balanceRecovery', slots: ['mainHand', 'head', 'chest', 'legs', 'feet', 'neck', 'ring'], tiers: { 1: [5, 15], 3: [16, 30] } },
      'spirit-recovery': { stat: 'spiritRecovery', slots: ['offHand', 'neck', 'ring'], tiers: { 1: [5, 15], 3: [16, 30] } },
      'mend-depth': { stat: 'mendDepth', slots: ['offHand', 'neck', 'ring'], tiers: { 1: [1, 3], 3: [4, 7] } },
      'ward-strength': { stat: 'wardStrength', slots: ['offHand', 'neck', 'ring'], tiers: { 1: [5, 15], 3: [16, 30] } },
    });
  });

  /** An `inventory` frame carries every affix of each item, and its decoder refuses more than the cap. */
  it('fits every affix a rare item rolls in one inventory frame', () => {
    const random = seededSequence(hashString('affix cap'));
    const most = Math.max(...Array.from({ length: 100 }, () => rollItem('amulet', 1, 'rare', random).affixes.length));
    expect(most).toBeLessThanOrEqual(SOMNIO_PROTOCOL_CONSTANTS.maxItemAffixes);
  });

  it('pins the monster kinds', () => {
    expect(MONSTER_KIND_IDS).toEqual(['ghost', 'skeleton-minion', 'skeleton-warrior', 'necromancer']);
    expect(MONSTER_KINDS).toEqual({
      ghost: {
        name: 'Ghost',
        tier: 1,
        characterModelId: 'ghost',
        radius: 0.3,
        metresPerSecond: 2.4,
        aggroRadius: 3.84,
        respawnSeconds: 60,
        health: 60,
        restHealthPerSecond: 1,
        strikeSeconds: 1.5,
        hitChance: 0.6,
        damage: 9,
        balanceDamage: 5,
        bounty: 12,
      },
      'skeleton-minion': {
        name: 'Skeleton',
        tier: 3,
        characterModelId: 'skeleton-minion',
        radius: 0.3,
        metresPerSecond: 2.6,
        aggroRadius: 4.5,
        respawnSeconds: 45,
        health: 70,
        restHealthPerSecond: 1,
        strikeSeconds: 1.2,
        hitChance: 0.6,
        damage: 12,
        balanceDamage: 5,
        bounty: 14,
      },
      'skeleton-warrior': {
        name: 'Skeleton Warrior',
        tier: 3,
        characterModelId: 'skeleton-warrior',
        radius: 0.3,
        metresPerSecond: 2.2,
        aggroRadius: 4.5,
        respawnSeconds: 75,
        health: 160,
        restHealthPerSecond: 2,
        strikeSeconds: 1.8,
        hitChance: 0.65,
        damage: 20,
        balanceDamage: 10,
        bounty: 30,
      },
      necromancer: {
        name: 'Necromancer',
        tier: 3,
        characterModelId: 'necromancer',
        radius: 0.3,
        metresPerSecond: 2,
        aggroRadius: 6,
        respawnSeconds: 600,
        health: 900,
        restHealthPerSecond: 10,
        strikeSeconds: 2,
        hitChance: 0.7,
        damage: 24,
        balanceDamage: 12,
        bounty: 200,
      },
    });
    expect(monsterKind('ghost')).toBe(MONSTER_KINDS.ghost);
  });

  /** A spawn of a boss's kind spawns a boss, so a kind renamed out of this table would come back as an ordinary nightmare. */
  it('pins the bosses', () => {
    expect(Object.keys(BOSS_MOVES)).toEqual(['necromancer']);
    expect(bossMoves('necromancer')).toBe(BOSS_MOVES.necromancer);
    expect(bossMoves('skeleton-minion')).toBeUndefined();
  });

  /** A trait id travels on an elite's `entity` frame, and its effect id on the `effects` frames. */
  it('pins the elite traits', () => {
    expect(ELITE_TRAIT_IDS).toEqual(['stony', 'shielded']);
    expect(ELITE_TRAITS).toEqual({
      stony: { effectId: 'stony', names: { ghost: 'Stony Ghost', 'skeleton-minion': 'Stony Skeleton', 'skeleton-warrior': 'Stony Skeleton Warrior' } },
      shielded: {
        effectId: 'shielded',
        renewSeconds: 8,
        names: { ghost: 'Shielded Ghost', 'skeleton-minion': 'Shielded Skeleton', 'skeleton-warrior': 'Shielded Skeleton Warrior' },
      },
    });
    expect(isEliteTraitId('stony')).toBe(true);
    expect(isEliteTraitId('toString')).toBe(false);
  });

  /** A teaching id is stored with every rank a character holds, beside the character's one role, and a held task is stored by its role and teaching. */
  it('pins the teachings with their roles', () => {
    expect(Object.fromEntries(TEACHING_IDS.map((id) => [id, TEACHINGS[id].role]))).toEqual({
      strike: 'fighter',
      guard: 'fighter',
      'follow-through': 'fighter',
      'balance-recovery': 'fighter',
      toughening: 'fighter',
      cleave: 'fighter',
      challenge: 'fighter',
      brace: 'fighter',
      lunge: 'fighter',
      rally: 'fighter',
      touch: 'healer',
      depth: 'healer',
      'drawing-back': 'healer',
      'spirit-deepening': 'healer',
      'deep-mend': 'healer',
      renewal: 'healer',
      radiance: 'healer',
      calm: 'healer',
      ward: 'mystic',
      weaken: 'mystic',
      bind: 'mystic',
      'dream-bolt': 'mystic',
      veil: 'mystic',
      'sense-the-fallen': 'mystic',
      'mystic-spirit-deepening': 'mystic',
    });
    expect(FIRST_TEACHING).toEqual({ fighter: 'strike', healer: 'touch', mystic: 'ward' });
  });

  it('pins the ability each teaching teaches', () => {
    expect(Object.fromEntries(TEACHING_IDS.flatMap((id) => (teaching(id).ability === undefined ? [] : [[id, teaching(id).ability]])))).toEqual({
      cleave: 'cleave',
      challenge: 'challenge',
      brace: 'brace',
      lunge: 'lunge',
      rally: 'rally',
      'deep-mend': 'deep-mend',
      renewal: 'renewal',
      radiance: 'radiance',
      calm: 'calm',
      ward: 'ward',
      weaken: 'weaken',
      bind: 'bind',
      'dream-bolt': 'dream-bolt',
      veil: 'veil',
    });
  });

  /** A `lucidity` frame carries a rank for each teaching held, and its decoder refuses more than the cap. */
  it('fits a rank of every teaching in one lucidity frame', () => {
    expect(TEACHING_IDS.length).toBeLessThanOrEqual(SOMNIO_PROTOCOL_CONSTANTS.maxLucidityRanks);
  });

  /** An `effects` frame lists each effect its holder holds, and a `cooldowns` frame each cooldown running; their decoders refuse more than the caps. */
  it("fits every effect in one effects frame and every ability's cooldown in one cooldowns frame", () => {
    expect(Object.keys(EFFECTS).length).toBeLessThanOrEqual(SOMNIO_PROTOCOL_CONSTANTS.maxEntityEffects);
    expect(Object.keys(ABILITIES).length).toBeLessThanOrEqual(SOMNIO_PROTOCOL_CONSTANTS.maxAbilityCooldowns);
  });

  /** A task's progress is stored as a bare number, which means something only against the kind of task it counts. */
  it('pins the kind of every trial and gate', () => {
    expect(Object.fromEntries(Object.entries(TRIALS).map(([role, trial]) => [role, trial.kind]))).toEqual({
      fighter: 'driveOff',
      healer: 'reach',
      mystic: 'reachAll',
    });
    const gated = TEACHING_IDS.filter((id) => teaching(id).gate !== undefined);
    expect(Object.fromEntries(gated.map((id) => [id, taskSpec({ role: TEACHINGS[id].role, teachingId: id })?.kind]))).toEqual({
      'follow-through': 'driveOff',
      'drawing-back': 'mend',
    });
  });

  it('names only its own teachings in what a teaching needs, each of the same role', () => {
    for (const id of TEACHING_IDS) {
      const needs = teaching(id).needs;
      if (needs === undefined) continue;
      expect(isTeachingId(needs.teachingId) && teaching(needs.teachingId).role).toBe(teaching(id).role);
    }
  });

  it('pins how far each kind of speech carries', () => {
    expect(SPEECH).toEqual({
      whisper: { clearMetres: 1.5, reachMetres: 3 },
      say: { clearMetres: 6, reachMetres: 12 },
      yell: { clearMetres: 40, reachMetres: 80 },
      doorMuffleMetres: 44,
    });
  });

  it('gives every gait a speed', () => {
    expect(GAITS.map(gaitMetresPerSecond)).toEqual([1, 2, 3]);
  });
});

/** Both sides of the movement check read these, so their values are pinned, not only their use. */
describe('constants', () => {
  it('are pinned to their literal values', () => {
    expect(SOMNIO_CONSTANTS).toEqual({
      playerRadius: 0.3,
      npcRadius: 0.3,
      pathTolerance: 0.01,
      maxStepHeight: 0.3,
      doorTriggerDepth: 0.58,
      npcInteractionRadius: 2,
      doorUseSlack: 1,
      maxSectorNPCs: 4096,
      maxSectorMonsterSpawns: 4096,
      maxSpawnAlive: 16,
      npcDialogCooldownSeconds: 3,
      npcGreetingPauseSeconds: 30,
      minOutdoorSectorExtent: 16,
      speechBubbleWidthPixels: 150,
      speechBubbleFontSize: 10,
      maxSectorFileBytes: 16_777_216,
    });
  });
});
