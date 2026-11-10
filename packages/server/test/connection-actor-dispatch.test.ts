import { afterEach, describe, expect, it, vi } from 'vitest';
import { NO_LUCIDITY, OUTDOOR_SPACE_ID } from '@somnio/core';
import type { Character, InventoryRow, Sector } from '@somnio/core';
import type { SomnioMessage } from '@somnio/protocol';
import { CLOSE_PROTOCOL_ERROR, ConnectionActor } from '../src/connection/connectionActor.ts';
import type { ConnectionState } from '../src/connection/connectionActor.ts';
import { CUDGEL_IN_HAND, GHOST, MOONSTONE_IN_HAND, PURSE, RESPAWN_MS, energy, lucidity, payloads } from './support/combat.ts';
import { collectMessages } from './support/frames.ts';
import { attachPlayer, makeMonsterSpawn, makeNPC, makeSector } from './support/sectorFactory.ts';
import { makeStubConnectionDependencies } from './support/stubDependencies.ts';

const move = { x: 10, z: 20, facing: 1, gait: 'run' } as const;
const moves = { moves: [{ id: 'peer', ...move }] };
const leave = { entityId: 'peer', leftGame: true };
const entity = {
  id: 'npc:EdariaLibrary/libus',
  kind: 'npc',
  characterModelId: 'libus',
  name: 'Libus',
  radius: 0.3,
  x: 10,
  z: 12,
  facing: 0,
  gait: 'jog',
  condition: 'hale',
} as const;
const register = {
  email: 'info@example.com',
  password: 'p',
  passwordRepeat: 'p',
};
const characterId = crypto.randomUUID();
const sessionToken = { token: 'tok', expiresInSeconds: 2_592_000 };

const cases: { label: string; message: SomnioMessage; state: ConnectionState['kind'] }[] = [
  { label: 'pre-login moves', message: { tag: 'moves', payload: moves }, state: 'awaitingLogin' },
  { label: 'pre-login entity', message: { tag: 'entity', payload: entity }, state: 'awaitingLogin' },
  {
    label: 'pre-login hello',
    message: { tag: 'hello', payload: { protocolVersion: 1 } },
    state: 'awaitingLogin',
  },
  { label: 'pre-login leave', message: { tag: 'leave', payload: leave }, state: 'awaitingLogin' },
  { label: 'pre-login move', message: { tag: 'move', payload: move }, state: 'awaitingLogin' },
  { label: 'pre-login clientSay', message: { tag: 'clientSay', payload: { text: 'Hallo Welt', kind: 'say' } }, state: 'awaitingLogin' },
  {
    label: 'pre-login equipToggle',
    message: { tag: 'equipToggle', payload: { slot: 1, hand: 'left' } },
    state: 'awaitingLogin',
  },
  { label: 'pre-login talk', message: { tag: 'talk', payload: { npcId: entity.id } }, state: 'awaitingLogin' },
  { label: 'pre-login target', message: { tag: 'target', payload: { targetId: entity.id } }, state: 'awaitingLogin' },
  { label: 'pre-login engage', message: { tag: 'engage', payload: { on: true } }, state: 'awaitingLogin' },
  { label: 'pre-login useAbility', message: { tag: 'useAbility', payload: { abilityId: 'brace' } }, state: 'awaitingLogin' },
  {
    label: 'pre-login useDoor',
    message: { tag: 'useDoor', payload: { sector: 'EdariaLibrary', doorId: 'exit' } },
    state: 'awaitingLogin',
  },
  { label: 'pre-login askTask', message: { tag: 'askTask', payload: { npcId: entity.id } }, state: 'awaitingLogin' },
  { label: 'pre-login completeTask', message: { tag: 'completeTask', payload: { npcId: entity.id } }, state: 'awaitingLogin' },
  { label: 'pre-login abandonTask', message: { tag: 'abandonTask', payload: {} }, state: 'awaitingLogin' },
  { label: 'pre-login study', message: { tag: 'study', payload: { npcId: entity.id, teachingId: 'strike' } }, state: 'awaitingLogin' },
  { label: 'pre-login buy', message: { tag: 'buy', payload: { npcId: entity.id, itemId: 'dagger' } }, state: 'awaitingLogin' },
  { label: 'pre-login sell', message: { tag: 'sell', payload: { npcId: entity.id, itemId: 'cudgel' } }, state: 'awaitingLogin' },
  { label: 'pre-login wake', message: { tag: 'wake', payload: {} }, state: 'awaitingLogin' },
  { label: 'pre-login useItem', message: { tag: 'useItem', payload: { slot: 1 } }, state: 'awaitingLogin' },
  {
    label: 'post-attach login',
    message: { tag: 'login', payload: { email: 'n', password: 'p' } },
    state: 'attached',
  },
  { label: 'post-attach register', message: { tag: 'register', payload: register }, state: 'attached' },
  { label: 'post-attach moves', message: { tag: 'moves', payload: moves }, state: 'attached' },
  { label: 'post-attach entity', message: { tag: 'entity', payload: entity }, state: 'attached' },
  { label: 'post-attach leave', message: { tag: 'leave', payload: leave }, state: 'attached' },
  { label: 'pre-login lucidity', message: { tag: 'lucidity', payload: { ranks: [] } }, state: 'awaitingLogin' },
  { label: 'post-attach lucidity', message: { tag: 'lucidity', payload: { ranks: [] } }, state: 'attached' },
  { label: 'post-attach condition', message: { tag: 'condition', payload: { entityId: 'peer', condition: 'fallen' } }, state: 'attached' },
  { label: 'post-attach vitals', message: { tag: 'vitals', payload: { entityId: 'peer', health: 0.5 } }, state: 'attached' },
  { label: 'post-attach blow', message: { tag: 'blow', payload: { attackerId: 'peer', targetId: 'monster:1', hit: true } }, state: 'attached' },
  { label: 'post-attach effects', message: { tag: 'effects', payload: { entityId: 'peer', effects: [] } }, state: 'attached' },
  { label: 'post-attach ability', message: { tag: 'ability', payload: { entityId: 'peer', abilityId: 'brace' } }, state: 'attached' },
  { label: 'pre-login cooldowns', message: { tag: 'cooldowns', payload: { globalSeconds: 0, cooldowns: [] } }, state: 'awaitingLogin' },
  { label: 'post-attach cooldowns', message: { tag: 'cooldowns', payload: { globalSeconds: 0, cooldowns: [] } }, state: 'attached' },
  {
    label: 'post-attach raising',
    message: { tag: 'raising', payload: { targetId: 'player', healerIds: ['peer'], state: 'holding', progress: 0, seconds: 6 } },
    state: 'attached',
  },
  { label: 'post-attach mend', message: { tag: 'mend', payload: { targetId: 'player' } }, state: 'attached' },
  {
    label: 'pre-login revokeSession',
    message: { tag: 'revokeSession', payload: { token: 'tok' } },
    state: 'awaitingLogin',
  },
  { label: 'pre-login revokeOtherSessions', message: { tag: 'revokeOtherSessions', payload: {} }, state: 'awaitingLogin' },
  {
    label: 'post-attach redeemSession',
    message: { tag: 'redeemSession', payload: { token: 'tok' } },
    state: 'attached',
  },
  {
    label: 'pre-login sessionToken',
    message: { tag: 'sessionToken', payload: sessionToken },
    state: 'awaitingLogin',
  },
  {
    label: 'post-attach sessionToken',
    message: { tag: 'sessionToken', payload: sessionToken },
    state: 'attached',
  },
  {
    label: 'pre-login sessionRevoked',
    message: { tag: 'sessionRevoked', payload: { revoked: true } },
    state: 'awaitingLogin',
  },
  {
    label: 'post-attach sessionRevoked',
    message: { tag: 'sessionRevoked', payload: { revoked: true } },
    state: 'attached',
  },
  { label: 'pre-login otherSessions', message: { tag: 'otherSessions', payload: { count: 1 } }, state: 'awaitingLogin' },
  { label: 'post-attach otherSessions', message: { tag: 'otherSessions', payload: { count: 1 } }, state: 'attached' },
  {
    label: 'pre-login otherSessionsRevoked',
    message: { tag: 'otherSessionsRevoked', payload: { revoked: true, count: 1 } },
    state: 'awaitingLogin',
  },
  {
    label: 'post-attach otherSessionsRevoked',
    message: { tag: 'otherSessionsRevoked', payload: { revoked: true, count: 1 } },
    state: 'attached',
  },
  { label: 'pre-login createCharacter', message: { tag: 'createCharacter', payload: { name: 'Ida', people: 'vigils' } }, state: 'awaitingLogin' },
  { label: 'pre-login selectCharacter', message: { tag: 'selectCharacter', payload: { characterId } }, state: 'awaitingLogin' },
  { label: 'pre-login deleteCharacter', message: { tag: 'deleteCharacter', payload: { characterId } }, state: 'awaitingLogin' },
  { label: 'post-attach createCharacter', message: { tag: 'createCharacter', payload: { name: 'Ida', people: 'vigils' } }, state: 'attached' },
  { label: 'post-attach selectCharacter', message: { tag: 'selectCharacter', payload: { characterId } }, state: 'attached' },
  { label: 'post-attach deleteCharacter', message: { tag: 'deleteCharacter', payload: { characterId } }, state: 'attached' },
  { label: 'pre-login characters', message: { tag: 'characters', payload: { characters: [] } }, state: 'awaitingLogin' },
  { label: 'post-attach characterResult', message: { tag: 'characterResult', payload: { result: 'ok' } }, state: 'attached' },
  { label: 'choosing login', message: { tag: 'login', payload: { email: 'n', password: 'p' } }, state: 'authenticated' },
  { label: 'choosing register', message: { tag: 'register', payload: register }, state: 'authenticated' },
  { label: 'choosing redeemSession', message: { tag: 'redeemSession', payload: { token: 'tok' } }, state: 'authenticated' },
  { label: 'choosing move', message: { tag: 'move', payload: move }, state: 'authenticated' },
  { label: 'choosing clientSay', message: { tag: 'clientSay', payload: { text: 'Hallo Welt', kind: 'say' } }, state: 'authenticated' },
  { label: 'choosing target', message: { tag: 'target', payload: {} }, state: 'authenticated' },
  { label: 'choosing engage', message: { tag: 'engage', payload: { on: true } }, state: 'authenticated' },
  { label: 'choosing useAbility', message: { tag: 'useAbility', payload: { abilityId: 'brace' } }, state: 'authenticated' },
  { label: 'choosing useDoor', message: { tag: 'useDoor', payload: { sector: 'EdariaLibrary', doorId: 'exit' } }, state: 'authenticated' },
  { label: 'choosing wake', message: { tag: 'wake', payload: {} }, state: 'authenticated' },
  { label: 'choosing characters', message: { tag: 'characters', payload: { characters: [] } }, state: 'authenticated' },
  { label: 'choosing characterResult', message: { tag: 'characterResult', payload: { result: 'ok' } }, state: 'authenticated' },
  {
    label: 'choosing enterSpace',
    message: { tag: 'enterSpace', payload: { spaceId: 'outdoors', selfId: 'player', people: 'vigils', worldSeconds: 0 } },
    state: 'authenticated',
  },
];

/**
 * Close-enforcement sentinel for `ConnectionActor.dispatch`: every state-illegal tag must close
 * 1002. The keep-open branches run the real handlers and are covered by their own suites.
 */
describe('ConnectionActor.dispatch', () => {
  it.each(cases)('closes with protocolError for $label', async ({ message, state }) => {
    const connection = new ConnectionActor(await makeStubConnectionDependencies());
    if (state === 'authenticated') connection.markAuthenticated(crypto.randomUUID());
    if (state === 'attached') connection.markAttached('player', 'EdariaLibrary', crypto.randomUUID());
    const decision = await connection.dispatch(message);
    expect(decision).toEqual({ kind: 'close', code: CLOSE_PROTOCOL_ERROR, reason: 'frame validation failed' });
  });
});

/**
 * The keep-open branches of an attached connection, one verb each. The space's own suites call
 * its handlers directly, so only this shows that a frame reaches the handler it names.
 */
describe('an attached connection', () => {
  const PUGNAX = 'npc:Town/pugnax';
  const MERCUS = 'npc:Town/mercus';
  const HEALER: Partial<Character> = { lucidity: lucidity('healer', { touch: 1 }), energy: energy({ healthCurrent: 50 }) };
  const TRIAL_PASSED: Partial<Character> = { lucidity: { ...NO_LUCIDITY, task: { role: 'fighter', teachingId: undefined, progress: 1 } } };

  afterEach(() => vi.restoreAllMocks());

  /** A dreamer beside Pugnax and Mercus, with a hurt dreamer in a Moonstone's reach. */
  async function attached(character: Partial<Character>, inventory: InventoryRow[], overrides: Partial<Sector> = {}) {
    const npcs = [
      { ...makeNPC('pugnax', { x: 10, z: 8 }, ''), service: 'fighterMaster' as const },
      { ...makeNPC('mercus', { x: 8.6, z: 9.5 }, ''), service: 'shopkeeper' as const },
    ];
    const sectors = [makeSector('Town', { npcs, ...overrides })];
    const dependencies = await makeStubConnectionDependencies({ sectors });
    const space = dependencies.worldRouter.space(OUTDOOR_SPACE_ID)!;
    const connection = new ConnectionActor(dependencies);
    const { entityId } = attachPlayer(space, { x: 10, z: 9.5 }, 'dreamer', { outbox: connection.outbox, character, inventory });
    connection.markAttached(entityId, OUTDOOR_SPACE_ID, crypto.randomUUID());
    const hurt = attachPlayer(space, { x: 10.6, z: 9.5 }, 'hurt', { character: { energy: energy({ healthCurrent: 50 }) } });
    return {
      connection,
      space,
      own: () => space.snapshotForPlayer(entityId)!,
      hurt: () => space.snapshotForPlayer(hurt.entityId)!.character,
      hurtId: hurt.entityId,
    };
  }

  type Attached = Awaited<ReturnType<typeof attached>>;

  it.each<[string, Partial<Character>, InventoryRow[], (a: Attached) => SomnioMessage, (a: Attached) => unknown, unknown]>([
    [
      'a use of the Moonstone',
      HEALER,
      [MOONSTONE_IN_HAND],
      () => ({ tag: 'useItem', payload: { slot: MOONSTONE_IN_HAND.slot } }),
      (a) => a.own().character.energy.healthCurrent,
      60,
    ],
    [
      'an equip toggle',
      {},
      [{ ...CUDGEL_IN_HAND, equippedHand: undefined }],
      () => ({ tag: 'equipToggle', payload: { slot: CUDGEL_IN_HAND.slot, hand: 'right' } }),
      (a) => a.own().inventory,
      [CUDGEL_IN_HAND],
    ],
    [
      'a use of an ability',
      { lucidity: lucidity('fighter', { brace: 1 }) },
      [],
      () => ({ tag: 'useAbility', payload: { abilityId: 'brace' } }),
      (a) => a.own().character.energy.balanceCurrent,
      85,
    ],
    ['a request for the trial', {}, [], () => ({ tag: 'askTask', payload: { npcId: PUGNAX } }), (a) => a.own().character.lucidity.task?.role, 'fighter'],
    [
      "a request for a teaching's task",
      { lucidity: lucidity('fighter', { strike: 2 }) },
      [],
      () => ({ tag: 'askTask', payload: { npcId: PUGNAX, teachingId: 'follow-through' } }),
      (a) => a.own().character.lucidity.task?.teachingId,
      'follow-through',
    ],
    ['a trial handed in', TRIAL_PASSED, [], () => ({ tag: 'completeTask', payload: { npcId: PUGNAX } }), (a) => a.own().character.lucidity.role, 'fighter'],
    [
      'a teaching to study',
      { lucidity: lucidity('fighter', { strike: 1 }) },
      [],
      () => ({ tag: 'study', payload: { npcId: PUGNAX, teachingId: 'toughening' } }),
      (a) => a.own().character.lucidity.study,
      'toughening',
    ],
    [
      'a purchase',
      {},
      [PURSE],
      () => ({ tag: 'buy', payload: { npcId: MERCUS, itemId: 'dagger' } }),
      (a) => a.own().inventory,
      [
        { ...PURSE, quantity: 40 },
        { slot: 1, itemId: 'dagger', quantity: 1, equippedHand: undefined },
      ],
    ],
    [
      'a sale',
      {},
      [PURSE, CUDGEL_IN_HAND],
      () => ({ tag: 'sell', payload: { npcId: MERCUS, itemId: 'cudgel' } }),
      (a) => a.own().inventory,
      [{ ...PURSE, quantity: 115 }],
    ],
  ])('takes %s to the space', async (_label, character, inventory, message, read, expected) => {
    const a = await attached(character, inventory);
    expect(read(a)).not.toEqual(expected);
    expect(await a.connection.dispatch(message(a))).toEqual({ kind: 'keepOpen' });
    a.space.step(0.05);
    expect(read(a)).toEqual(expected);
  });

  it('takes a target to the space, which sends its health back', async () => {
    const a = await attached({}, []);
    expect(await a.connection.dispatch({ tag: 'target', payload: { targetId: a.hurtId } })).toEqual({ kind: 'keepOpen' });
    expect(payloads(await collectMessages(a.connection.outbox), 'vitals')).toEqual([{ entityId: a.hurtId, health: 0.5 }]);
  });

  it('takes Mend to the space, which mends the target', async () => {
    const a = await attached(HEALER, [MOONSTONE_IN_HAND]);
    expect(await a.connection.dispatch({ tag: 'target', payload: { targetId: a.hurtId } })).toEqual({ kind: 'keepOpen' });
    expect(await a.connection.dispatch({ tag: 'engage', payload: { on: true } })).toEqual({ kind: 'keepOpen' });
    a.space.step(0.05);
    expect(a.hurt().energy.healthCurrent).toBe(60);
  });

  /** The space runs on the machine's clock here, and a nightmare takes its respawn time to appear. */
  it('takes Attack to the space, which swings at the target in front', async () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(0);
    const a = await attached({}, [], { monsterSpawns: [makeMonsterSpawn({ x: 10, z: 10.2 })] });
    now.mockReturnValue(RESPAWN_MS);
    a.space.step(0);

    expect(await a.connection.dispatch({ tag: 'target', payload: { targetId: GHOST } })).toEqual({ kind: 'keepOpen' });
    expect(await a.connection.dispatch({ tag: 'engage', payload: { on: true } })).toEqual({ kind: 'keepOpen' });
    a.space.step(0);

    const swings = payloads(await collectMessages(a.connection.outbox), 'blow').filter((blow) => blow.attackerId !== GHOST);
    expect(swings).toMatchObject([{ targetId: GHOST }]);
  });
});
