import { afterEach, describe, expect, it, vi } from 'vitest';
import { OUTDOOR_SPACE_ID } from '@somnio/core';
import type { Character, Inventory, Sector } from '@somnio/core';
import type { SomnioMessage } from '@somnio/protocol';
import { CLOSE_PROTOCOL_ERROR, ConnectionActor } from '../src/connection/connectionActor.ts';
import type { ConnectionState } from '../src/connection/connectionActor.ts';
import { plain } from '../../core/test/support/items.ts';
import { COINS, CUDGEL, GHOST, MOONSTONE, RESPAWN_MS, carrying, energy, lucidity, payloads, wearing } from './support/combat.ts';
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
  { label: 'pre-login equip', message: { tag: 'equip', payload: { itemId: CUDGEL.id } }, state: 'awaitingLogin' },
  { label: 'pre-login unequip', message: { tag: 'unequip', payload: { slot: 'mainHand' } }, state: 'awaitingLogin' },
  { label: 'pre-login moveItem', message: { tag: 'moveItem', payload: { itemId: CUDGEL.id, place: 5 } }, state: 'awaitingLogin' },
  { label: 'pre-login dropItem', message: { tag: 'dropItem', payload: { itemId: CUDGEL.id, heading: 90 } }, state: 'awaitingLogin' },
  { label: 'pre-login pickUp', message: { tag: 'pickUp', payload: { lootId: 'loot-1' } }, state: 'awaitingLogin' },
  { label: 'pre-login interact', message: { tag: 'interact', payload: { carrierId: entity.id } }, state: 'awaitingLogin' },
  { label: 'pre-login target', message: { tag: 'target', payload: { targetId: entity.id } }, state: 'awaitingLogin' },
  { label: 'pre-login engage', message: { tag: 'engage', payload: { on: true } }, state: 'awaitingLogin' },
  { label: 'pre-login useAbility', message: { tag: 'useAbility', payload: { abilityId: 'brace' } }, state: 'awaitingLogin' },
  {
    label: 'pre-login useDoor',
    message: { tag: 'useDoor', payload: { sector: 'EdariaLibrary', doorId: 'exit' } },
    state: 'awaitingLogin',
  },
  { label: 'pre-login acceptQuest', message: { tag: 'acceptQuest', payload: { carrierId: entity.id, questId: 'fighter-trial' } }, state: 'awaitingLogin' },
  { label: 'pre-login turnInQuest', message: { tag: 'turnInQuest', payload: { carrierId: entity.id, questId: 'fighter-trial' } }, state: 'awaitingLogin' },
  { label: 'pre-login abandonQuest', message: { tag: 'abandonQuest', payload: { questId: 'fighter-trial' } }, state: 'awaitingLogin' },
  { label: 'pre-login study', message: { tag: 'study', payload: { carrierId: entity.id, teachingId: 'strike' } }, state: 'awaitingLogin' },
  { label: 'pre-login buy', message: { tag: 'buy', payload: { carrierId: entity.id, baseId: 'dagger' } }, state: 'awaitingLogin' },
  { label: 'pre-login sell', message: { tag: 'sell', payload: { carrierId: entity.id, itemId: CUDGEL.id } }, state: 'awaitingLogin' },
  { label: 'pre-login wake', message: { tag: 'wake', payload: {} }, state: 'awaitingLogin' },
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
  { label: 'post-attach held', message: { tag: 'held', payload: { entityId: 'peer', held: {} } }, state: 'attached' },
  {
    label: 'post-attach loot',
    message: { tag: 'loot', payload: { lootId: 'loot-1', x: 10, z: 12, contents: { kind: 'item', baseId: 'dagger', rarity: 'plain' } } },
    state: 'attached',
  },
  { label: 'post-attach lootGone', message: { tag: 'lootGone', payload: { lootId: 'loot-1' } }, state: 'attached' },
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
  // Pugnax's committed id, since the trial and the task he gives name him by it.
  const PUGNAX = 'npc:EdariaFighterHall/pugnax';
  const MERCUS = 'npc:EdariaFighterHall/mercus';
  const HEALER: Partial<Character> = { lucidity: lucidity('healer', { touch: 1 }), energy: energy({ healthCurrent: 50 }) };
  const TRIAL_PASSED: Partial<Character> = { quests: { active: [{ questId: 'fighter-trial', progress: [1] }], done: [] } };
  const TRIAL_HELD: Partial<Character> = { quests: { active: [{ questId: 'fighter-trial', progress: [0] }], done: [] } };

  afterEach(() => vi.restoreAllMocks());

  /** A dreamer beside Pugnax and Mercus, with a hurt dreamer in a Moonstone's reach. */
  async function attached(character: Partial<Character>, inventory: Inventory, overrides: Partial<Sector> = {}) {
    const npcs = [
      { ...makeNPC('pugnax', { x: 10, z: 8 }, ''), service: 'fighterMaster' as const },
      { ...makeNPC('mercus', { x: 8.6, z: 9.5 }, ''), service: 'shopkeeper' as const },
    ];
    const sectors = [makeSector('EdariaFighterHall', { npcs, ...overrides })];
    const dependencies = await makeStubConnectionDependencies({ sectors });
    const space = dependencies.worldRouter.space(OUTDOOR_SPACE_ID)!;
    const connection = new ConnectionActor(dependencies);
    const { entityId } = attachPlayer(space, { x: 10, z: 9.5 }, 'dreamer', { outbox: connection.outbox, character, inventory });
    connection.markAttached(entityId, OUTDOOR_SPACE_ID, crypto.randomUUID());
    const hurt = attachPlayer(space, { x: 10.6, z: 9.5 }, 'hurt', { character: { energy: energy({ healthCurrent: 50 }) } });
    return {
      connection,
      dependencies,
      space,
      own: () => space.snapshotForPlayer(entityId)!,
      hurt: () => space.snapshotForPlayer(hurt.entityId)!.character,
      hurtId: hurt.entityId,
    };
  }

  type Attached = Awaited<ReturnType<typeof attached>>;

  it.each<[string, Partial<Character>, Inventory, (a: Attached) => SomnioMessage, (a: Attached) => unknown, unknown]>([
    ['an equip', {}, carrying({ bag: [CUDGEL] }), () => ({ tag: 'equip', payload: { itemId: CUDGEL.id } }), (a) => a.own().inventory, wearing(CUDGEL)],
    ['an unequip', {}, wearing(CUDGEL), () => ({ tag: 'unequip', payload: { slot: 'mainHand' } }), (a) => a.own().inventory, carrying({ bag: [CUDGEL] })],
    [
      'a move in the bag',
      {},
      carrying({ bag: [CUDGEL] }),
      () => ({ tag: 'moveItem', payload: { itemId: CUDGEL.id, place: 5 } }),
      (a) => a.own().inventory.bag,
      [{ place: 5, item: CUDGEL }],
    ],
    [
      'a drop to the ground',
      {},
      carrying({ worn: [CUDGEL] }),
      () => ({ tag: 'dropItem', payload: { itemId: CUDGEL.id, heading: 0 } }),
      (a) => a.own().inventory,
      carrying(),
    ],
    [
      'a use of an ability',
      { lucidity: lucidity('fighter', { brace: 1 }) },
      carrying(),
      () => ({ tag: 'useAbility', payload: { abilityId: 'brace' } }),
      (a) => a.own().character.energy.balanceCurrent,
      85,
    ],
    [
      'a quest taken on',
      {},
      carrying(),
      () => ({ tag: 'acceptQuest', payload: { carrierId: PUGNAX, questId: 'fighter-trial' } }),
      (a) => a.own().character.quests.active,
      [{ questId: 'fighter-trial', progress: [0] }],
    ],
    [
      'a quest turned in',
      TRIAL_PASSED,
      carrying(),
      () => ({ tag: 'turnInQuest', payload: { carrierId: PUGNAX, questId: 'fighter-trial' } }),
      (a) => a.own().character.lucidity.role,
      'fighter',
    ],
    [
      'a quest given up',
      TRIAL_HELD,
      carrying(),
      () => ({ tag: 'abandonQuest', payload: { questId: 'fighter-trial' } }),
      (a) => a.own().character.quests.active,
      [],
    ],
    [
      'a teaching to study',
      { lucidity: lucidity('fighter', { strike: 1 }) },
      carrying(),
      () => ({ tag: 'study', payload: { carrierId: PUGNAX, teachingId: 'toughening' } }),
      (a) => a.own().character.lucidity.study,
      'toughening',
    ],
    [
      'a purchase',
      {},
      carrying({ coins: COINS }),
      () => ({ tag: 'buy', payload: { carrierId: MERCUS, baseId: 'dagger' } }),
      (a) => a.own().inventory,
      { coins: 40, equipped: {}, bag: [{ place: 0, item: { id: expect.any(String), ...plain('dagger') } }] },
    ],
    [
      'a sale',
      {},
      carrying({ coins: COINS, bag: [CUDGEL] }),
      () => ({ tag: 'sell', payload: { carrierId: MERCUS, itemId: CUDGEL.id } }),
      (a) => a.own().inventory,
      carrying({ coins: 110 }),
    ],
  ])('takes %s to the space', async (_label, character, inventory, message, read, expected) => {
    const a = await attached(character, inventory);
    expect(read(a)).not.toEqual(expected);
    expect(await a.connection.dispatch(message(a))).toEqual({ kind: 'keepOpen' });
    a.space.step(0.05);
    expect(read(a)).toEqual(expected);
  });

  it("saves the dropper's checkpoint without the item through the router the moment it is thrown", async () => {
    const a = await attached({}, carrying({ worn: [CUDGEL] }));
    const persistCheckpoint = vi.spyOn(a.dependencies.characters, 'persistCheckpoint');
    expect(await a.connection.dispatch({ tag: 'dropItem', payload: { itemId: CUDGEL.id, heading: 0 } })).toEqual({ kind: 'keepOpen' });
    expect(persistCheckpoint.mock.calls).toEqual([[expect.objectContaining({ id: a.own().character.id }), carrying()]]);
  });

  it('takes a pick-up to the space, which puts the item back in the bag under a new id', async () => {
    const a = await attached({}, carrying({ bag: [CUDGEL] }));
    a.space.handleDropItem(CUDGEL.id, 0, a.own().character.id);
    expect(a.own().inventory.bag).toEqual([]);
    expect(await a.connection.dispatch({ tag: 'pickUp', payload: { lootId: 'loot-1' } })).toEqual({ kind: 'keepOpen' });
    expect(a.own().inventory.bag).toEqual([{ place: 0, item: { ...CUDGEL, id: expect.not.stringMatching(CUDGEL.id) } }]);
  });

  it('takes a target to the space, which sends its health back', async () => {
    const a = await attached({}, carrying());
    expect(await a.connection.dispatch({ tag: 'target', payload: { targetId: a.hurtId } })).toEqual({ kind: 'keepOpen' });
    expect(payloads(await collectMessages(a.connection.outbox), 'vitals')).toEqual([{ entityId: a.hurtId, health: 0.5 }]);
  });

  it('takes Mend to the space, which mends the target', async () => {
    const a = await attached(HEALER, wearing(MOONSTONE));
    expect(await a.connection.dispatch({ tag: 'target', payload: { targetId: a.hurtId } })).toEqual({ kind: 'keepOpen' });
    expect(await a.connection.dispatch({ tag: 'engage', payload: { on: true } })).toEqual({ kind: 'keepOpen' });
    a.space.step(0.05);
    expect(a.hurt().energy.healthCurrent).toBe(60);
  });

  /** The space runs on the machine's clock here, and a nightmare takes its respawn time to appear. */
  it('takes Attack to the space, which swings at the target in front', async () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(0);
    const a = await attached({}, carrying(), { monsterSpawns: [makeMonsterSpawn({ x: 10, z: 10.2 })] });
    now.mockReturnValue(RESPAWN_MS);
    a.space.step(0);

    expect(await a.connection.dispatch({ tag: 'target', payload: { targetId: GHOST } })).toEqual({ kind: 'keepOpen' });
    expect(await a.connection.dispatch({ tag: 'engage', payload: { on: true } })).toEqual({ kind: 'keepOpen' });
    a.space.step(0);

    const swings = payloads(await collectMessages(a.connection.outbox), 'blow').filter((blow) => blow.attackerId !== GHOST);
    expect(swings).toMatchObject([{ targetId: GHOST }]);
  });
});
