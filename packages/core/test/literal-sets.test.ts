import { GAITS } from '@somnio/protocol';
import { describe, expect, it } from 'vitest';
import { SOMNIO_CONSTANTS } from '../src/constants.ts';
import { gaitMetresPerSecond } from '../src/gait.ts';
import { ITEMS } from '../src/items.ts';
import { FIRST_TEACHING, TEACHINGS, TEACHING_IDS, TRIALS, isTeachingId, taskSpec, teaching } from '../src/lucidity.ts';
import { MONSTER_KINDS, MONSTER_KIND_IDS, monsterKind } from '../src/monsterKinds.ts';
import { PEOPLES } from '../src/people.ts';
import { SPEECH } from '../src/speech.ts';

/**
 * Literal pins for the string sets and tables this package owns. Their members are persisted
 * (`people`, `itemId`) or written into sector files (`kind`), so a renamed member would round-trip
 * cleanly through every codec test while orphaning every saved row that carries the old name.
 */
describe('literal sets', () => {
  it('pins the peoples', () => {
    expect(PEOPLES).toEqual(['wachen', 'soporen', 'umbren', 'lumina']);
  });

  it('pins the items', () => {
    expect(ITEMS).toEqual({
      purse: { labelKey: 'Purse' },
      cudgel: { labelKey: 'Cudgel', weapon: { damage: 8, balanceCost: 18 } },
      mondstein: { labelKey: 'Mondstein' },
    });
  });

  it('pins the monster kinds', () => {
    expect(MONSTER_KIND_IDS).toEqual(['gespenst']);
    expect(MONSTER_KINDS).toEqual({
      gespenst: {
        name: 'Gespenst',
        characterModelId: 'gespenst',
        radius: 0.3,
        metresPerSecond: 2.4,
        aggroRadius: 3.84,
        respawnSeconds: 60,
        health: 60,
        strikeSeconds: 1.5,
        hitChance: 0.6,
        damage: 9,
        balanceDamage: 5,
        bounty: 12,
      },
    });
    expect(monsterKind('gespenst')).toBe(MONSTER_KINDS.gespenst);
  });

  /** A teaching id is stored with every rank a character holds, beside the character's one role, and a held task is stored by its role and teaching. */
  it('pins the teachings with their roles', () => {
    expect(Object.fromEntries(TEACHING_IDS.map((id) => [id, TEACHINGS[id].role]))).toEqual({
      strike: 'kaempfer',
      guard: 'kaempfer',
      'follow-through': 'kaempfer',
      'balance-recovery': 'kaempfer',
      toughening: 'kaempfer',
      touch: 'heiler',
      depth: 'heiler',
      'drawing-back': 'heiler',
      'spirit-deepening': 'heiler',
    });
    expect(FIRST_TEACHING).toEqual({ kaempfer: 'strike', heiler: 'touch' });
  });

  /** A task's progress is stored as a bare number, which means something only against the kind of task it counts. */
  it('pins the kind of every trial and gate', () => {
    expect({ kaempfer: TRIALS.kaempfer.kind, heiler: TRIALS.heiler.kind }).toEqual({ kaempfer: 'driveOff', heiler: 'reach' });
    const gated = TEACHING_IDS.filter((id) => teaching(id).gate !== undefined);
    expect(Object.fromEntries(gated.map((id) => [id, taskSpec({ role: TEACHINGS[id].role, teachingId: id }).kind]))).toEqual({
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
