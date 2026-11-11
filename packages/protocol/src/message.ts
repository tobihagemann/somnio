import type {
  AbilityMessage,
  AdminSayMessage,
  AskTaskMessage,
  BlowMessage,
  BuyMessage,
  CharacterResultMessage,
  CharactersMessage,
  ClientSayMessage,
  CompleteTaskMessage,
  ConditionMessage,
  CooldownsMessage,
  CorrectionMessage,
  CreateCharacterMessage,
  DeleteCharacterMessage,
  DoorRefusedMessage,
  DropItemMessage,
  EffectsMessage,
  EmptyMessage,
  Energy,
  EngageMessage,
  EnterSpaceMessage,
  EntityMessage,
  EquipMessage,
  HeldMessage,
  HelloMessage,
  InventoryMessage,
  LeaveMessage,
  LoginMessage,
  LoginResultMessage,
  LootGoneMessage,
  LootMessage,
  LucidityMessage,
  MendMessage,
  MoveItemMessage,
  MoveMessage,
  MovesMessage,
  OtherSessionsMessage,
  OtherSessionsRevokedMessage,
  PickUpMessage,
  RaisingMessage,
  RedeemSessionMessage,
  RegisterMessage,
  RegisterResultMessage,
  RevokeSessionMessage,
  SayMessage,
  SectorMessage,
  SelectCharacterMessage,
  SellMessage,
  SensedMessage,
  SessionRevokedMessage,
  SessionTokenMessage,
  StudyMessage,
  TalkMessage,
  TargetMessage,
  UnequipMessage,
  UseAbilityMessage,
  UseDoorMessage,
  VitalsMessage,
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
  | { tag: 'createCharacter'; payload: CreateCharacterMessage }
  | { tag: 'selectCharacter'; payload: SelectCharacterMessage }
  | { tag: 'deleteCharacter'; payload: DeleteCharacterMessage }
  | { tag: 'move'; payload: MoveMessage }
  | { tag: 'clientSay'; payload: ClientSayMessage }
  | { tag: 'equip'; payload: EquipMessage }
  | { tag: 'unequip'; payload: UnequipMessage }
  | { tag: 'moveItem'; payload: MoveItemMessage }
  | { tag: 'dropItem'; payload: DropItemMessage }
  | { tag: 'pickUp'; payload: PickUpMessage }
  | { tag: 'talk'; payload: TalkMessage }
  | { tag: 'target'; payload: TargetMessage }
  | { tag: 'engage'; payload: EngageMessage }
  | { tag: 'useAbility'; payload: UseAbilityMessage }
  | { tag: 'useDoor'; payload: UseDoorMessage }
  | { tag: 'askTask'; payload: AskTaskMessage }
  | { tag: 'completeTask'; payload: CompleteTaskMessage }
  | { tag: 'abandonTask'; payload: EmptyMessage }
  | { tag: 'study'; payload: StudyMessage }
  | { tag: 'buy'; payload: BuyMessage }
  | { tag: 'sell'; payload: SellMessage }
  | { tag: 'wake'; payload: EmptyMessage }
  | { tag: 'redeemSession'; payload: RedeemSessionMessage }
  | { tag: 'revokeSession'; payload: RevokeSessionMessage }
  | { tag: 'revokeOtherSessions'; payload: EmptyMessage }
  | { tag: 'hello'; payload: HelloMessage }
  | { tag: 'loginResult'; payload: LoginResultMessage }
  | { tag: 'registerResult'; payload: RegisterResultMessage }
  | { tag: 'characters'; payload: CharactersMessage }
  | { tag: 'characterResult'; payload: CharacterResultMessage }
  | { tag: 'enterSpace'; payload: EnterSpaceMessage }
  | { tag: 'sector'; payload: SectorMessage }
  | { tag: 'entity'; payload: EntityMessage }
  | { tag: 'moves'; payload: MovesMessage }
  | { tag: 'correction'; payload: CorrectionMessage }
  | { tag: 'doorRefused'; payload: DoorRefusedMessage }
  | { tag: 'serverSay'; payload: SayMessage }
  | { tag: 'energy'; payload: Energy }
  | { tag: 'inventory'; payload: InventoryMessage }
  | { tag: 'loot'; payload: LootMessage }
  | { tag: 'lootGone'; payload: LootGoneMessage }
  | { tag: 'leave'; payload: LeaveMessage }
  | { tag: 'lucidity'; payload: LucidityMessage }
  | { tag: 'condition'; payload: ConditionMessage }
  | { tag: 'held'; payload: HeldMessage }
  | { tag: 'vitals'; payload: VitalsMessage }
  | { tag: 'effects'; payload: EffectsMessage }
  | { tag: 'blow'; payload: BlowMessage }
  | { tag: 'ability'; payload: AbilityMessage }
  | { tag: 'cooldowns'; payload: CooldownsMessage }
  | { tag: 'raising'; payload: RaisingMessage }
  | { tag: 'mend'; payload: MendMessage }
  | { tag: 'sensed'; payload: SensedMessage }
  | { tag: 'adminSay'; payload: AdminSayMessage }
  | { tag: 'sessionToken'; payload: SessionTokenMessage }
  | { tag: 'sessionRevoked'; payload: SessionRevokedMessage }
  | { tag: 'otherSessions'; payload: OtherSessionsMessage }
  | { tag: 'otherSessionsRevoked'; payload: OtherSessionsRevokedMessage };

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
