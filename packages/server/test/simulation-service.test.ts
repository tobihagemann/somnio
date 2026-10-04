import { describe, expect, it, vi } from 'vitest';
import { OUTDOOR_SPACE_ID } from '@somnio/core';
import type { NPCDialogState } from '@somnio/core';
import { SimulationService } from '../src/services/simulationService.ts';
import { WorldRouter } from '../src/world/worldRouter.ts';
import { collectMessages } from './support/frames.ts';
import { testLogger } from './support/logger.ts';
import { attachPlayer, makeNPC, makeSector, makeWorld } from './support/sectorFactory.ts';
import { makeStubConnectionDependencies } from './support/stubDependencies.ts';
import { StubCharacterRepository, StubNPCDialogStateRepository } from './support/stubRepositories.ts';

/** A service over one outdoor sector, on a clock the test advances. */
async function simulation(npcDialogStates = new StubNPCDialogStateRepository()) {
  const clock = { ms: 0 };
  const sector = makeSector('Field', { npcs: [makeNPC('guard', { x: 10, z: 10 }, 'first.\n---\nsecond.')] });
  const router = await WorldRouter.create(makeWorld([sector]), new StubCharacterRepository(), npcDialogStates, testLogger());
  const service = new SimulationService(router, 50, () => clock.ms);
  const space = router.space(OUTDOOR_SPACE_ID)!;
  const join = (name: string, x: number) => attachPlayer(space, { x, z: 11.2 }, name);
  return { clock, router, service, space, join };
}

describe('SimulationService', () => {
  it('an aborted signal ends run() cleanly', async () => {
    const dependencies = await makeStubConnectionDependencies();
    const service = new SimulationService(dependencies.worldRouter, 5);
    const control = new AbortController();
    const run = service.run(control.signal);
    await new Promise((resolve) => setTimeout(resolve, 20));
    control.abort();
    await expect(run).resolves.toBeUndefined();
  });

  it('sends each connection one moves frame per 100 ms, holding the latest position of what moved', async () => {
    const { clock, service, space, join } = await simulation();
    const mover = join('mover', 5);
    const watcher = join('watcher', 15);
    const step = async (x: number) => {
      space.handleMove({ x, z: 11.2, facing: 90, gait: 'walk' }, mover.entityId);
      clock.ms += 50;
      await service.runPass();
    };
    for (const x of [5.1, 5.2, 5.3, 5.4, 5.5]) await step(x);
    const frames = (await collectMessages(watcher.outbox)).flatMap((message) => (message.tag === 'moves' ? [message.payload.moves] : []));
    // Five passes over 250 ms: the flushes fall on the second and the fourth.
    expect(frames).toEqual([
      [{ id: mover.entityId, x: 5.2, z: 11.2, facing: 90, gait: 'walk' }],
      [{ id: mover.entityId, x: 5.4, z: 11.2, facing: 90, gait: 'walk' }],
    ]);
    expect((await collectMessages(mover.outbox)).filter((message) => message.tag === 'moves')).toEqual([]);
  });

  it('steps each pass by the time since the previous one, clamped to a quarter second', async () => {
    const { clock, router, service } = await simulation();
    const stepped = vi.spyOn(router, 'runTickAcrossSpaces');
    clock.ms += 50;
    await service.runPass();
    clock.ms += 10_000;
    await service.runPass();
    expect(stepped.mock.calls).toEqual([[0.05], [0.25]]);
  });

  it('persists the dialog digest of the step it ran', async () => {
    const upserted: NPCDialogState[] = [];
    class RecordingDialogRepository extends StubNPCDialogStateRepository {
      override upsert(state: NPCDialogState): Promise<void> {
        upserted.push(state);
        return Promise.resolve();
      }
    }
    const { clock, service, space, join } = await simulation(new RecordingDialogRepository());
    space.handleBump('npc:Field/guard', join('talker', 10).entityId);
    clock.ms += 50;
    await service.runPass();
    expect(upserted).toEqual([{ sectorName: 'Field', npcId: 'guard', scriptStep: 2 }]);
  });
});
