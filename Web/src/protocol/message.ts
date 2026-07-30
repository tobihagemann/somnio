import type {
  AdminSayMessage,
  BumpNPCMessage,
  DateTickMessage,
  Energy,
  EnterPortalMessage,
  EnterSectorMessage,
  EntityMessage,
  EquipToggleMessage,
  HelloMessage,
  InventoryMessage,
  LeaveMessage,
  LoginMessage,
  LoginResultMessage,
  MainCharacterMessage,
  PositionMessage,
  RedeemSessionMessage,
  RegisterMessage,
  RegisterResultMessage,
  RevokeSessionMessage,
  SayMessage,
  SessionRevokedMessage,
  SessionTokenMessage,
} from './payloads'
import { isClientOnlyTag } from './tags'
import type { ClientToServerTag } from './tags'

/**
 * Discriminated union mirroring `SomnioMessage`. `tag` is the discriminator and `payload`
 * carries the struct, matching the `{"tag":"<verb>","payload":{...}}` frame shape exactly.
 */
export type SomnioMessage =
  | { tag: 'login'; payload: LoginMessage }
  | { tag: 'register'; payload: RegisterMessage }
  | { tag: 'clientPosition'; payload: PositionMessage }
  | { tag: 'clientSay'; payload: SayMessage }
  | { tag: 'equipToggle'; payload: EquipToggleMessage }
  | { tag: 'bumpNPC'; payload: BumpNPCMessage }
  | { tag: 'enterPortal'; payload: EnterPortalMessage }
  | { tag: 'redeemSession'; payload: RedeemSessionMessage }
  | { tag: 'revokeSession'; payload: RevokeSessionMessage }
  | { tag: 'hello'; payload: HelloMessage }
  | { tag: 'loginResult'; payload: LoginResultMessage }
  | { tag: 'registerResult'; payload: RegisterResultMessage }
  | { tag: 'enterSector'; payload: EnterSectorMessage }
  | { tag: 'mainCharacter'; payload: MainCharacterMessage }
  | { tag: 'entity'; payload: EntityMessage }
  | { tag: 'serverPosition'; payload: PositionMessage }
  | { tag: 'serverSay'; payload: SayMessage }
  | { tag: 'energy'; payload: Energy }
  | { tag: 'dateTick'; payload: DateTickMessage }
  | { tag: 'inventory'; payload: InventoryMessage }
  | { tag: 'leave'; payload: LeaveMessage }
  | { tag: 'adminSay'; payload: AdminSayMessage }
  | { tag: 'sessionToken'; payload: SessionTokenMessage }
  | { tag: 'sessionRevoked'; payload: SessionRevokedMessage }

/**
 * Direction check that narrows the **message**, not just its tag. A predicate over
 * `message.tag` alone leaves `message` un-narrowed, so the dispatcher's `never` exhaustiveness
 * guard would still see the client-only variants and fail to compile.
 */
export function isClientOnlyMessage(
  message: SomnioMessage
): message is Extract<SomnioMessage, { tag: ClientToServerTag }> {
  return isClientOnlyTag(message.tag)
}

/**
 * Compile-time exhaustiveness guard. Swift's enum switch is exhaustive by compiler
 * enforcement; a TypeScript `switch` silently ignores an unhandled case unless the default
 * branch is typed `never`, so every dispatcher over this union routes its default here.
 */
export function assertNever(value: never, context: string): never {
  throw new Error(`${context}: unhandled case ${JSON.stringify(value)}`)
}
