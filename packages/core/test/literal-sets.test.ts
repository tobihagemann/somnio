import { GAITS } from '@somnio/protocol';
import { describe, expect, it } from 'vitest';
import { SOMNIO_CONSTANTS } from '../src/constants.ts';
import { gaitMetresPerSecond } from '../src/gait.ts';
import { ITEMS } from '../src/items.ts';
import { MONSTER_KINDS, MONSTER_KIND_IDS, monsterKind } from '../src/monsterKinds.ts';
import { PEOPLES } from '../src/people.ts';

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
    expect(ITEMS).toEqual({ purse: { labelKey: 'Purse' }, cudgel: { labelKey: 'Cudgel' } });
  });

  it('pins the monster kinds', () => {
    expect(MONSTER_KIND_IDS).toEqual(['gespenst']);
    expect(MONSTER_KINDS).toEqual({
      gespenst: { name: 'Gespenst', characterModelId: 'gespenst', radius: 0.3, metresPerSecond: 2.4, aggroRadius: 3.84, respawnSeconds: 60 },
    });
    expect(monsterKind('gespenst')).toBe(MONSTER_KINDS.gespenst);
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
      npcInteractionRadius: 1.28,
      doorUseSlack: 1,
      maxSectorNPCs: 4096,
      maxSectorMonsterSpawns: 4096,
      maxSpawnAlive: 16,
      npcDialogCooldownSeconds: 3,
      minOutdoorSectorExtent: 16,
      speechBubbleWidthPixels: 150,
      speechBubbleFontSize: 10,
      maxSectorFileBytes: 16_777_216,
    });
  });
});
