import type {
  AccountRepository,
  CharacterRepository,
  InventoryRepository,
  NPCDialogStateRepository,
  RegistrationRepository,
  SessionRepository,
} from '@somnio/data'
import type { Logger } from '../logging.ts'
import type { WorldClockService } from '../services/worldClockService.ts'
import type { WorldRouter } from '../world/worldRouter.ts'

/** Everything a connection needs; repositories are interfaces so tests substitute stubs. */
export interface ConnectionDependencies {
  accounts: AccountRepository
  characters: CharacterRepository
  inventories: InventoryRepository
  registrations: RegistrationRepository
  npcDialogStates: NPCDialogStateRepository
  sessions: SessionRepository
  worldRouter: WorldRouter
  worldClock: WorldClockService
  outboxHighWatermark: number
  logger: Logger
}
