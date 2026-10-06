import type {
  AdminSayMessage,
  AskTaskMessage,
  BlowMessage,
  ClientSayMessage,
  CompleteTaskMessage,
  ConditionMessage,
  CorrectionMessage,
  DoorRefusedMessage,
  EmptyMessage,
  Energy,
  EnterSpaceMessage,
  EntityMessage,
  EquipToggleMessage,
  HelloMessage,
  InventoryMessage,
  LeaveMessage,
  LoginMessage,
  LoginResultMessage,
  LucidityMessage,
  MoveMessage,
  MovesMessage,
  RaisingMessage,
  RedeemSessionMessage,
  RegisterMessage,
  RegisterResultMessage,
  RevokeSessionMessage,
  SayMessage,
  SectorMessage,
  SessionRevokedMessage,
  SessionTokenMessage,
  StudyMessage,
  SwingMessage,
  TalkMessage,
  TendMessage,
  UseDoorMessage,
  UseItemMessage,
} from './payloads.ts';
import { isClientOnlyTag } from './tags.ts';
import type { ClientToServerTag } from './tags.ts';

/**
 * `tag` is the discriminator and `payload` carries the struct, matching the
 * `{"tag":"<verb>","payload":{...}}` frame shape exactly.
 */
export type SomnioMessage =
  | { tag: 'login'; payload: LoginMessage }
  | { tag: 'register'; payload: RegisterMessage }
  | { tag: 'move'; payload: MoveMessage }
  | { tag: 'clientSay'; payload: ClientSayMessage }
  | { tag: 'equipToggle'; payload: EquipToggleMessage }
  | { tag: 'talk'; payload: TalkMessage }
  | { tag: 'swing'; payload: SwingMessage }
  | { tag: 'tend'; payload: TendMessage }
  | { tag: 'useDoor'; payload: UseDoorMessage }
  | { tag: 'askTask'; payload: AskTaskMessage }
  | { tag: 'completeTask'; payload: CompleteTaskMessage }
  | { tag: 'abandonTask'; payload: EmptyMessage }
  | { tag: 'study'; payload: StudyMessage }
  | { tag: 'wake'; payload: EmptyMessage }
  | { tag: 'useItem'; payload: UseItemMessage }
  | { tag: 'redeemSession'; payload: RedeemSessionMessage }
  | { tag: 'revokeSession'; payload: RevokeSessionMessage }
  | { tag: 'hello'; payload: HelloMessage }
  | { tag: 'loginResult'; payload: LoginResultMessage }
  | { tag: 'registerResult'; payload: RegisterResultMessage }
  | { tag: 'enterSpace'; payload: EnterSpaceMessage }
  | { tag: 'sector'; payload: SectorMessage }
  | { tag: 'entity'; payload: EntityMessage }
  | { tag: 'moves'; payload: MovesMessage }
  | { tag: 'correction'; payload: CorrectionMessage }
  | { tag: 'doorRefused'; payload: DoorRefusedMessage }
  | { tag: 'serverSay'; payload: SayMessage }
  | { tag: 'energy'; payload: Energy }
  | { tag: 'inventory'; payload: InventoryMessage }
  | { tag: 'leave'; payload: LeaveMessage }
  | { tag: 'lucidity'; payload: LucidityMessage }
  | { tag: 'condition'; payload: ConditionMessage }
  | { tag: 'blow'; payload: BlowMessage }
  | { tag: 'raising'; payload: RaisingMessage }
  | { tag: 'adminSay'; payload: AdminSayMessage }
  | { tag: 'sessionToken'; payload: SessionTokenMessage }
  | { tag: 'sessionRevoked'; payload: SessionRevokedMessage };

/**
 * Direction check that narrows the **message**, not just its tag. A predicate over
 * `message.tag` alone leaves `message` un-narrowed, so the dispatcher's `never` exhaustiveness
 * guard would still see the client-only variants and fail to compile.
 */
export function isClientOnlyMessage(message: SomnioMessage): message is Extract<SomnioMessage, { tag: ClientToServerTag }> {
  return isClientOnlyTag(message.tag);
}

/**
 * Compile-time exhaustiveness guard. A TypeScript `switch` silently ignores an unhandled case
 * unless the default branch is typed `never`, so every dispatcher over this union routes its
 * default here.
 */
export function assertNever(value: never, context: string): never {
  throw new Error(`${context}: unhandled case ${JSON.stringify(value)}`);
}
