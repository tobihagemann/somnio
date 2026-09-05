import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dialogSteps, npcRuntimePosition } from '@somnio/core';
import { PostgresNPCDialogStateRepository } from '@somnio/data';
import { ConnectionOutbox } from '../../src/connection/outbox.ts';
import { DIALOG_COOLDOWN_CAP, PerSectorActor } from '../../src/world/perSectorActor.ts';
import type { AITickDigest } from '../../src/world/perSectorActor.ts';
import { collectMessages, serverSays } from '../support/frames.ts';
import { testLogger } from '../support/logger.ts';
import { makeCharacter } from '../support/sectorFactory.ts';
import { fixtureSectors, makeDatabaseDependencies, startDatabase } from './support/harness.ts';
import type { DatabaseHarness } from './support/harness.ts';

const bibliothek = fixtureSectors().get('EdariaBibliothek')!;
const libus = bibliothek.npcs[0]!;
const LIBUS_INDEX = 1;
const steps = dialogSteps(libus.dialogScript);

let harness: DatabaseHarness;

beforeAll(async () => {
  harness = await startDatabase();
});
afterAll(async () => {
  await harness.stop();
});

/** One emit plus the cooldown walk back to the cap. */
function emitCycle(actor: PerSectorActor, digests: AITickDigest[]): void {
  digests.push(actor.runAITick());
  for (let count = 0; count < DIALOG_COOLDOWN_CAP; count += 1) digests.push(actor.runAITick());
}

describe('NPC dialog end to end', () => {
  it('repeated AI ticks walk the dialog cursor across all script steps then wrap', async () => {
    const actor = new PerSectorActor(bibliothek, { logger: testLogger() });
    const outbox = new ConnectionOutbox(4096);
    const entityIndex = actor.attach(makeCharacter(npcRuntimePosition(libus), 'alice', bibliothek.name), [], outbox);
    const digests: AITickDigest[] = [];
    actor.handleBumpNPC(LIBUS_INDEX, entityIndex);
    for (let step = 0; step < steps.length; step += 1) emitCycle(actor, digests);
    // The wrap cleared targeting; a re-bump restarts at step 1 after a full cooldown cycle.
    actor.handleBumpNPC(LIBUS_INDEX, entityIndex);
    emitCycle(actor, digests);

    const says = serverSays(await collectMessages(outbox));
    const expected = steps.map((step) => step.replaceAll('$name', 'alice'));
    expect(says).toEqual([...expected, expected[0]]);
    const upserts = digests.flatMap((digest) => digest.dialogUpserts);
    const resets = digests.flatMap((digest) => digest.dialogResets);
    expect(upserts.length).toBe(steps.length);
    expect(resets).toEqual([LIBUS_INDEX]);
  });

  it('a bump outside the interaction radius produces no say or dialog upsert', async () => {
    const actor = new PerSectorActor(bibliothek, { logger: testLogger() });
    const outbox = new ConnectionOutbox(1024);
    const runtime = npcRuntimePosition(libus);
    const entityIndex = actor.attach(makeCharacter({ x: runtime.x + 400, y: runtime.y }, 'far', bibliothek.name), [], outbox);
    actor.handleBumpNPC(LIBUS_INDEX, entityIndex);
    const digests = [actor.runAITick(), actor.runAITick()];
    expect(serverSays(await collectMessages(outbox))).toEqual([]);
    expect(digests.every((digest) => digest.dialogUpserts.length === 0)).toBe(true);
  });

  it('the dialog cursor persists across a server restart', async () => {
    expect(steps.length).toBeGreaterThanOrEqual(3);
    const first = await makeDatabaseDependencies(harness.db);
    const sector = first.worldRouter.sector(bibliothek.name)!;
    const entityIndex = sector.attach(makeCharacter(npcRuntimePosition(libus), 'alice', bibliothek.name), [], new ConnectionOutbox(4096));
    sector.handleBumpNPC(LIBUS_INDEX, entityIndex);
    // Two emits through the router, so the persistence path is the production one.
    for (let step = 0; step < 2; step += 1) {
      for (let tick = 0; tick <= DIALOG_COOLDOWN_CAP; tick += 1) await first.worldRouter.runAITickAcrossSectors();
    }
    const persisted = await new PostgresNPCDialogStateRepository(harness.db).find(bibliothek.name, LIBUS_INDEX);
    expect(persisted?.scriptStep).toBe(3);

    const second = await makeDatabaseDependencies(harness.db);
    const restarted = second.worldRouter.sector(bibliothek.name)!;
    const outbox = new ConnectionOutbox(4096);
    const again = restarted.attach(makeCharacter(npcRuntimePosition(libus), 'alice', bibliothek.name), [], outbox);
    restarted.handleBumpNPC(LIBUS_INDEX, again);
    restarted.runAITick();
    expect(serverSays(await collectMessages(outbox))[0]).toBe(steps[2]!.replaceAll('$name', 'alice'));
  });
});
