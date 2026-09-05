import { BOOT_DEFAULT_WORLD_CLOCK } from '@somnio/core';
import type { Sector, WorldClock } from '@somnio/core';
import type { SessionRepository } from '@somnio/data';
import type { ConnectionDependencies } from '../../src/connection/dependencies.ts';
import type { Logger } from '../../src/logging.ts';
import { WorldClockService } from '../../src/services/worldClockService.ts';
import { WorldRouter } from '../../src/world/worldRouter.ts';
import { testLogger } from './logger.ts';
import {
  StubAccountRepository,
  StubCharacterRepository,
  StubInventoryRepository,
  StubNPCDialogStateRepository,
  StubRegistrationRepository,
  StubSessionRepository,
  StubWorldClockRepository,
} from './stubRepositories.ts';

export interface StubDependencyOptions {
  logger?: Logger;
  outboxHighWatermark?: number;
  sessions?: SessionRepository;
  sectors?: ReadonlyMap<string, Sector>;
  characters?: StubCharacterRepository;
  accounts?: StubAccountRepository;
  initialClock?: WorldClock;
  worldRouter?: WorldRouter;
}

/**
 * A fully-stubbed `ConnectionDependencies` over an empty world. `sectors` and `characters` are
 * overridable together because the login join needs *both* to get past its guards.
 */
export async function makeStubConnectionDependencies(options: StubDependencyOptions = {}): Promise<ConnectionDependencies> {
  const logger = options.logger ?? testLogger();
  const characters = options.characters ?? new StubCharacterRepository();
  const worldRouter = options.worldRouter ?? (await WorldRouter.create(options.sectors ?? new Map(), characters, new StubNPCDialogStateRepository(), logger));
  const worldClock = new WorldClockService(worldRouter, new StubWorldClockRepository(), options.initialClock ?? BOOT_DEFAULT_WORLD_CLOCK, logger);
  return {
    accounts: options.accounts ?? new StubAccountRepository(),
    characters,
    inventories: new StubInventoryRepository(),
    registrations: new StubRegistrationRepository(),
    npcDialogStates: new StubNPCDialogStateRepository(),
    sessions: options.sessions ?? new StubSessionRepository(),
    worldRouter,
    worldClock,
    outboxHighWatermark: options.outboxHighWatermark ?? 1024,
    logger,
  };
}
