import type { WorldClock } from '@somnio/core'
import type { AdminDependencies } from '../../src/handlers/adminDispatcher.ts'
import type { AdminWorldRouter } from '../../src/world/worldRouter.ts'
import { makeStubConnectionDependencies } from './stubDependencies.ts'
import { StubAdminWorldRouter } from './stubAdminWorldRouter.ts'
import { tempLogging } from './tempLogging.ts'
import type { TempLogging } from './tempLogging.ts'

export interface AdminDependencyOptions {
  worldRouter?: AdminWorldRouter
  serverVersion?: string
  initialClock?: WorldClock
  logging?: TempLogging
}

/** Admin dependencies over a stub router and temp log files; the world clock service ticks a private empty router. */
export async function makeAdminDependencies(
  options: AdminDependencyOptions = {}
): Promise<AdminDependencies & { logging: TempLogging }> {
  const logging = options.logging ?? tempLogging()
  const connection = await makeStubConnectionDependencies(
    options.initialClock === undefined ? {} : { initialClock: options.initialClock }
  )
  return {
    worldRouter: options.worldRouter ?? new StubAdminWorldRouter(),
    worldClock: connection.worldClock,
    serverVersion: options.serverVersion ?? '1.0.0',
    gameplayLog: logging.gameplayFile,
    adminLog: logging.adminFile,
    logger: logging.adminLogger('dispatch'),
    logging,
  }
}
