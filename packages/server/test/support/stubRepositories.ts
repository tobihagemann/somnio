import { BOOT_DEFAULT_WORLD_CLOCK } from '@somnio/core'
import type { Account, Character, InventoryRow, NPCDialogState, WorldClock } from '@somnio/core'
import type {
  AccountRepository,
  CharacterRepository,
  InventoryRepository,
  IssuedSession,
  NPCDialogStateKey,
  NPCDialogStateRepository,
  RegistrationRepository,
  RegistrationRequest,
  ResolvedSession,
  SessionRepository,
  WorldClockRepository,
} from '@somnio/data'

/**
 * Shared repository doubles. Most answer the "do nothing" contract; the account and character
 * stubs take an overridable fixture, and `StubSessionRepository` records call counts. A double
 * only one suite drives stays private beside that suite.
 */
export class StubAccountRepository implements AccountRepository {
  /**
   * Exact, case-sensitive lookup where the Postgres repository matches `LOWER(NORMALIZE(...))`.
   * Deliberately not reimplemented: a second copy of the rule could agree with itself while
   * disagreeing with the column. The integration suite covers the predicate.
   */
  private readonly accountsByName: ReadonlyMap<string, Account>

  constructor(accountsByName: ReadonlyMap<string, Account> = new Map()) {
    this.accountsByName = accountsByName
  }

  create(): Promise<Account> {
    throw new Error('StubAccountRepository: create is not used by these tests')
  }

  findByName(name: string): Promise<Account | undefined> {
    return Promise.resolve(this.accountsByName.get(name))
  }

  findById(): Promise<Account | undefined> {
    return Promise.resolve(undefined)
  }
}

export class StubCharacterRepository implements CharacterRepository {
  private readonly charactersByAccount: ReadonlyMap<string, Character[]>

  constructor(charactersByAccount: ReadonlyMap<string, Character[]> = new Map()) {
    this.charactersByAccount = charactersByAccount
  }

  create(): Promise<Character> {
    throw new Error('StubCharacterRepository: create is not used by these tests')
  }

  findByAccount(accountId: string): Promise<Character[]> {
    return Promise.resolve(this.charactersByAccount.get(accountId) ?? [])
  }

  findByName(): Promise<Character | undefined> {
    return Promise.resolve(undefined)
  }

  snapshot(): Promise<boolean> {
    return Promise.resolve(false)
  }

  persistCheckpoint(): Promise<boolean> {
    return Promise.resolve(false)
  }
}

export class StubInventoryRepository implements InventoryRepository {
  loadAll(): Promise<InventoryRow[]> {
    return Promise.resolve([])
  }

  replaceAll(): Promise<void> {
    return Promise.resolve()
  }
}

export class StubRegistrationRepository implements RegistrationRepository {
  register(_request: RegistrationRequest): Promise<{ account: Account; character: Character }> {
    return Promise.reject(new Error('StubRegistrationRepository: register is not used by these tests'))
  }
}

export class StubNPCDialogStateRepository implements NPCDialogStateRepository {
  find(_sectorName: string, _npcIndex: number): Promise<NPCDialogState | undefined> {
    return Promise.resolve(undefined)
  }

  loadAll(_sectorName: string): Promise<NPCDialogState[]> {
    return Promise.resolve([])
  }

  allKeys(): Promise<NPCDialogStateKey[]> {
    return Promise.resolve([])
  }

  upsert(_state: NPCDialogState): Promise<void> {
    return Promise.resolve()
  }

  reset(_sectorName: string, _npcIndex: number): Promise<void> {
    return Promise.resolve()
  }

  deleteOrphans(_keys: readonly NPCDialogStateKey[]): Promise<void> {
    return Promise.resolve()
  }
}

export class StubWorldClockRepository implements WorldClockRepository {
  load(): Promise<WorldClock> {
    return Promise.resolve({ ...BOOT_DEFAULT_WORLD_CLOCK })
  }

  save(): Promise<void> {
    return Promise.resolve()
  }
}

/**
 * In-memory session store that actually issues, resolves, and revokes. Keyed by the raw token
 * rather than a digest so a test can assert against what it handed out. The call counts exist
 * so a handler test can assert a guard fired *before* the lookup: the response alone is the same
 * either way.
 */
export class StubSessionRepository implements SessionRepository {
  private readonly issued = new Map<string, { accountId: string; expiresAt: Date }>()
  private nextTokenNumber = 0
  redeemCallCount = 0
  revokeCallCount = 0

  /** Tokens minted, including any later revoked or expired away. */
  get issuedCount(): number {
    return this.nextTokenNumber
  }

  issue(accountId: string, lifetimeSeconds: number): Promise<IssuedSession> {
    this.nextTokenNumber += 1
    const token = `stub-token-${this.nextTokenNumber}`
    const expiresAt = new Date(Date.now() + lifetimeSeconds * 1000)
    this.issued.set(token, { accountId, expiresAt })
    return Promise.resolve({ token, expiresAt })
  }

  redeem(token: string): Promise<ResolvedSession | undefined> {
    this.redeemCallCount += 1
    const entry = this.issued.get(token)
    if (entry === undefined || entry.expiresAt.getTime() <= Date.now()) return Promise.resolve(undefined)
    return Promise.resolve({ accountId: entry.accountId, expiresAt: entry.expiresAt })
  }

  revoke(token: string, accountId: string): Promise<boolean> {
    this.revokeCallCount += 1
    const entry = this.issued.get(token)
    if (entry === undefined || entry.accountId !== accountId) return Promise.resolve(false)
    this.issued.delete(token)
    return Promise.resolve(true)
  }

  deleteExpired(asOf: Date): Promise<number> {
    let count = 0
    for (const [token, entry] of this.issued) {
      if (entry.expiresAt.getTime() <= asOf.getTime()) {
        this.issued.delete(token)
        count += 1
      }
    }
    return Promise.resolve(count)
  }

  isStored(token: string): boolean {
    return this.issued.has(token)
  }

  plant(token: string, accountId: string, expiresAt: Date): void {
    this.issued.set(token, { accountId, expiresAt })
  }
}

/** Distinguishable from a real database error, so a degraded-path test cannot pass on an unrelated throw. */
export class RepositoryFailure extends Error {
  constructor() {
    super('rigged repository failure')
    this.name = 'RepositoryFailure'
  }
}

/**
 * A session repository whose every operation throws — the degraded-database branch, where the
 * `catch` in each handler is the only thing that turns the throw into a frame the client can act
 * on.
 */
export const failingSessionRepository: SessionRepository = {
  issue: () => Promise.reject(new RepositoryFailure()),
  redeem: () => Promise.reject(new RepositoryFailure()),
  revoke: () => Promise.reject(new RepositoryFailure()),
  deleteExpired: () => Promise.reject(new RepositoryFailure()),
}

export function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: crypto.randomUUID(),
    name: 'tester',
    passwordHash: '',
    email: 'tester@example.invalid',
    createdAt: new Date(),
    ...overrides,
  }
}
