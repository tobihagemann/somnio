import type {
  AccountRepository,
  CharacterRepository,
  InventoryRepository,
  NPCDialogStateRepository,
  RegistrationRepository,
  SessionRepository,
} from '@somnio/data';
import type { Logger } from '../logging.ts';
import type { WorldClockService } from '../services/worldClockService.ts';
import type { WorldRouter } from '../world/worldRouter.ts';
import type { AttemptLimiter } from './attemptLimiter.ts';

/** Everything a connection needs; repositories are interfaces so tests substitute stubs. */
export interface ConnectionDependencies {
  accounts: AccountRepository;
  characters: CharacterRepository;
  inventories: InventoryRepository;
  registrations: RegistrationRepository;
  npcDialogStates: NPCDialogStateRepository;
  sessions: SessionRepository;
  worldRouter: WorldRouter;
  worldClock: WorldClockService;
  /** The pre-login budgets per client address: logins, registrations, and `/admin` bearers. */
  attemptLimiter: AttemptLimiter;
  /** The failed logins per account, keyed by the folded nickname, whatever address they come from. */
  accountLimiter: AttemptLimiter;
  outboxHighWatermark: number;
  /** How long a socket may stay without logging in before the server closes it. */
  loginDeadlineMs: number;
  logger: Logger;
}
