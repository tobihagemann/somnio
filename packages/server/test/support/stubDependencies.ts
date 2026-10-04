import { BOOT_DEFAULT_WORLD_SECONDS } from '@somnio/core';
import type { Sector } from '@somnio/core';
import type { SessionRepository } from '@somnio/data';
import { AttemptLimiter } from '../../src/connection/attemptLimiter.ts';
import type { ConnectionDependencies } from '../../src/connection/dependencies.ts';
import type { Logger } from '../../src/logging.ts';
import { WorldClockService } from '../../src/services/worldClockService.ts';
import { WorldRouter } from '../../src/world/worldRouter.ts';
import { testLogger } from './logger.ts';
import { makeWorld } from './sectorFactory.ts';
import {
  StubAccountRepository,
  StubCharacterRepository,
  StubInventoryRepository,
  StubNPCDialogStateRepository,
  StubRegistrationRepository,
  StubSessionRepository,
  StubWorldClockRepository,
} from './stubRepositories.ts';

export function enabledAttemptLimiter(): AttemptLimiter {
  return new AttemptLimiter({ enabled: true, logger: testLogger() });
}

export interface StubDependencyOptions {
  logger?: Logger;
  outboxHighWatermark?: number;
  sessions?: SessionRepository;
  sectors?: readonly Sector[];
  characters?: StubCharacterRepository;
  accounts?: StubAccountRepository;
  initialWorldSeconds?: number;
  worldRouter?: WorldRouter;
  /** Defaults to a disabled limiter, so a suite that never asks for the limit is never throttled. */
  attemptLimiter?: AttemptLimiter;
}

/**
 * A fully-stubbed `ConnectionDependencies` over a world of the starter sector alone. `sectors` and
 * `characters` are overridable together because a join into another sector needs both.
 */
export async function makeStubConnectionDependencies(options: StubDependencyOptions = {}): Promise<ConnectionDependencies> {
  const logger = options.logger ?? testLogger();
  const characters = options.characters ?? new StubCharacterRepository();
  const worldRouter = options.worldRouter ?? (await WorldRouter.create(makeWorld(options.sectors), characters, new StubNPCDialogStateRepository(), logger));
  const worldClock = new WorldClockService(new StubWorldClockRepository(), options.initialWorldSeconds ?? BOOT_DEFAULT_WORLD_SECONDS, logger);
  return {
    accounts: options.accounts ?? new StubAccountRepository(),
    characters,
    inventories: new StubInventoryRepository(),
    registrations: new StubRegistrationRepository(),
    npcDialogStates: new StubNPCDialogStateRepository(),
    sessions: options.sessions ?? new StubSessionRepository(),
    worldRouter,
    worldClock,
    attemptLimiter: options.attemptLimiter ?? new AttemptLimiter({ enabled: false, logger }),
    outboxHighWatermark: options.outboxHighWatermark ?? 1024,
    logger,
  };
}
