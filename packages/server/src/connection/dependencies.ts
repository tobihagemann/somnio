import type { AccountRepository, CharacterRepository, ItemRepository, QuestRepository, SessionRepository } from '@somnio/data';
import type { Logger } from '../logging.ts';
import type { WorldClockService } from '../services/worldClockService.ts';
import type { WorldRouter } from '../world/worldRouter.ts';
import type { AttemptKind, AttemptLimiter } from './attemptLimiter.ts';
import type { FrameKind } from './frameLimits.ts';

/** Everything a connection needs; repositories are interfaces so tests substitute stubs. */
export interface ConnectionDependencies {
  accounts: AccountRepository;
  characters: CharacterRepository;
  items: ItemRepository;
  quests: QuestRepository;
  sessions: SessionRepository;
  worldRouter: WorldRouter;
  worldClock: WorldClockService;
  /** The pre-login budgets per client address: logins, registrations, and `/admin` bearers. */
  attemptLimiter: AttemptLimiter<AttemptKind>;
  /** The failed logins per account, keyed by the folded email, whatever address they come from. */
  accountLimiter: AttemptLimiter<AttemptKind>;
  /** The gameplay frame budgets per account. They outlive its connections, so a reconnect resumes them rather than starting full. */
  frameLimiter: AttemptLimiter<FrameKind>;
  outboxHighWatermark: number;
  /** How long a socket may stay without logging in before the server closes it. */
  loginDeadlineMs: number;
  /** How long a socket on the character card may go without a request there before the server closes it. */
  cardDeadlineMs: number;
  logger: Logger;
}
