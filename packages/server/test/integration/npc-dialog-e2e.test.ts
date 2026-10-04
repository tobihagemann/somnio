import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SOMNIO_CONSTANTS, dialogSteps } from '@somnio/core';
import { PostgresNPCDialogStateRepository, STARTER_SECTOR } from '@somnio/data';
import type { TickDigest } from '../../src/world/spaceActor.ts';
import { collectMessages, serverSays } from '../support/frames.ts';
import { attachPlayer, makeClockedSpace } from '../support/sectorFactory.ts';
import { fixtureWorld, makeDatabaseDependencies, standableNear, startDatabase } from './support/harness.ts';
import type { DatabaseHarness } from './support/harness.ts';

const world = fixtureWorld();
const libus = world.spaces.get(STARTER_SECTOR)!.sectors[0]!.npcs.find((npc) => npc.id === 'libus')!;
const LIBUS = `npc:${STARTER_SECTOR}/libus`;
const steps = dialogSteps(libus.dialogScript);
const COOLDOWN_MS = SOMNIO_CONSTANTS.npcDialogCooldownSeconds * 1000;

let harness: DatabaseHarness;

beforeAll(async () => {
  harness = await startDatabase();
});
afterAll(async () => {
  await harness.stop();
});

/** The committed library on a clock the test advances, with a player beside Libus. */
function library(name: string) {
  const { clock, space } = makeClockedSpace(world, STARTER_SECTOR);
  const beside = standableNear(space, libus, SOMNIO_CONSTANTS.npcInteractionRadius);
  return { clock, space, ...attachPlayer(space, beside, name, { spaceId: STARTER_SECTOR }) };
}

describe('NPC dialog end to end', () => {
  it('steps a cooldown apart walk the dialog cursor across all script steps then wrap', async () => {
    const { clock, space, outbox, entityId } = library('alice');
    const digests: TickDigest[] = [];
    space.handleBump(LIBUS, entityId);
    for (let step = 0; step < steps.length; step += 1) {
      digests.push(space.step(0.05));
      clock.ms += COOLDOWN_MS;
    }
    // The wrap cleared targeting; a re-bump restarts at step 1.
    space.handleBump(LIBUS, entityId);
    digests.push(space.step(0.05));

    const says = serverSays(await collectMessages(outbox));
    const expected = steps.map((step) => step.replaceAll('$name', 'alice'));
    expect(says).toEqual([...expected, expected[0]]);
    expect(digests.flatMap((digest) => digest.dialogUpserts)).toHaveLength(steps.length);
    expect(digests.flatMap((digest) => digest.dialogResets)).toEqual([{ sectorName: STARTER_SECTOR, npcId: 'libus' }]);
  });

  it('a bump outside the interaction radius produces no say or dialog upsert', async () => {
    const { space } = makeClockedSpace(world, STARTER_SECTOR);
    const { outbox, entityId } = attachPlayer(space, world.starterSpawn.position, 'far', { spaceId: STARTER_SECTOR });
    space.handleBump(LIBUS, entityId);
    const digests = [space.step(0.05), space.step(0.05)];
    expect(serverSays(await collectMessages(outbox))).toEqual([]);
    expect(digests.every((digest) => digest.dialogUpserts.length === 0)).toBe(true);
  });

  it('the dialog cursor persists across a server restart', async () => {
    expect(steps.length).toBeGreaterThanOrEqual(3);
    const first = await makeDatabaseDependencies(harness.db);
    const space = first.worldRouter.space(STARTER_SECTOR)!;
    const beside = standableNear(space, libus, SOMNIO_CONSTANTS.npcInteractionRadius);
    const { entityId } = attachPlayer(space, beside, 'alice', { spaceId: STARTER_SECTOR });
    space.handleBump(LIBUS, entityId);
    // One emit through the router, so the persistence path is the production one.
    await first.worldRouter.persistDialogDigest(first.worldRouter.runTickAcrossSpaces(0.05));
    const persisted = await new PostgresNPCDialogStateRepository(harness.db).find(STARTER_SECTOR, 'libus');
    expect(persisted?.scriptStep).toBe(2);

    const second = await makeDatabaseDependencies(harness.db);
    const restarted = second.worldRouter.space(STARTER_SECTOR)!;
    const again = attachPlayer(restarted, beside, 'alice', { spaceId: STARTER_SECTOR });
    restarted.handleBump(LIBUS, again.entityId);
    restarted.step(0.05);
    expect(serverSays(await collectMessages(again.outbox))[0]).toBe(steps[1]!.replaceAll('$name', 'alice'));
  });
});
