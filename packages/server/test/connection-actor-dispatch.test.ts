import { afterEach, describe, expect, it, vi } from 'vitest';
import { NO_LUCIDITY, OUTDOOR_SPACE_ID } from '@somnio/core';
import type { Character, InventoryRow, Sector } from '@somnio/core';
import type { SomnioMessage } from '@somnio/protocol';
import { CLOSE_PROTOCOL_ERROR, ConnectionActor } from '../src/connection/connectionActor.ts';
import { CUDGEL_IN_HAND, GHOST, MONDSTEIN_IN_HAND, RESPAWN_MS, energy, lucidity, payloads } from './support/combat.ts';
import { collectMessages } from './support/frames.ts';
import { attachPlayer, makeMonsterSpawn, makeNPC, makeSector } from './support/sectorFactory.ts';
import { makeStubConnectionDependencies } from './support/stubDependencies.ts';

const move = { x: 10, z: 20, facing: 1, gait: 'run' } as const;
const moves = { moves: [{ id: 'peer', ...move }] };
const leave = { entityId: 'peer', leftGame: true };
const entity = {
  id: 'npc:EdariaBibliothek/libus',
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
  nickname: 'Saibot',
  password: 'p',
  passwordRepeat: 'p',
  people: 'wachen',
  email: 'info@example.com',
};
const sessionToken = { token: 'tok', expiresInSeconds: 2_592_000 };

const cases: { label: string; message: SomnioMessage; attachFirst: boolean }[] = [
  { label: 'pre-login moves', message: { tag: 'moves', payload: moves }, attachFirst: false },
  { label: 'pre-login entity', message: { tag: 'entity', payload: entity }, attachFirst: false },
  {
    label: 'pre-login hello',
    message: { tag: 'hello', payload: { protocolVersion: 1 } },
    attachFirst: false,
  },
  { label: 'pre-login leave', message: { tag: 'leave', payload: leave }, attachFirst: false },
  { label: 'pre-login move', message: { tag: 'move', payload: move }, attachFirst: false },
  { label: 'pre-login clientSay', message: { tag: 'clientSay', payload: { text: 'Hallo Welt' } }, attachFirst: false },
  {
    label: 'pre-login equipToggle',
    message: { tag: 'equipToggle', payload: { slot: 1, hand: 'left' } },
    attachFirst: false,
  },
  { label: 'pre-login talk', message: { tag: 'talk', payload: { npcId: entity.id } }, attachFirst: false },
  { label: 'pre-login swing', message: { tag: 'swing', payload: { targetId: entity.id } }, attachFirst: false },
  { label: 'pre-login tend', message: { tag: 'tend', payload: { targetId: entity.id } }, attachFirst: false },
  {
    label: 'pre-login useDoor',
    message: { tag: 'useDoor', payload: { sector: 'EdariaBibliothek', doorId: 'exit' } },
    attachFirst: false,
  },
  { label: 'pre-login askTask', message: { tag: 'askTask', payload: { npcId: entity.id } }, attachFirst: false },
  { label: 'pre-login completeTask', message: { tag: 'completeTask', payload: { npcId: entity.id } }, attachFirst: false },
  { label: 'pre-login abandonTask', message: { tag: 'abandonTask', payload: {} }, attachFirst: false },
  { label: 'pre-login study', message: { tag: 'study', payload: { npcId: entity.id, teachingId: 'strike' } }, attachFirst: false },
  { label: 'pre-login wake', message: { tag: 'wake', payload: {} }, attachFirst: false },
  { label: 'pre-login useItem', message: { tag: 'useItem', payload: { slot: 1 } }, attachFirst: false },
  {
    label: 'post-attach login',
    message: { tag: 'login', payload: { nickname: 'n', password: 'p' } },
    attachFirst: true,
  },
  { label: 'post-attach register', message: { tag: 'register', payload: register }, attachFirst: true },
  { label: 'post-attach moves', message: { tag: 'moves', payload: moves }, attachFirst: true },
  { label: 'post-attach entity', message: { tag: 'entity', payload: entity }, attachFirst: true },
  { label: 'post-attach leave', message: { tag: 'leave', payload: leave }, attachFirst: true },
  { label: 'pre-login lucidity', message: { tag: 'lucidity', payload: { ranks: [] } }, attachFirst: false },
  { label: 'post-attach lucidity', message: { tag: 'lucidity', payload: { ranks: [] } }, attachFirst: true },
  { label: 'post-attach condition', message: { tag: 'condition', payload: { entityId: 'peer', condition: 'fallen' } }, attachFirst: true },
  { label: 'post-attach blow', message: { tag: 'blow', payload: { attackerId: 'peer', targetId: 'monster:1', hit: true } }, attachFirst: true },
  {
    label: 'post-attach raising',
    message: { tag: 'raising', payload: { healerId: 'peer', targetId: 'player', state: 'begun', seconds: 6 } },
    attachFirst: true,
  },
  {
    label: 'pre-login revokeSession',
    message: { tag: 'revokeSession', payload: { token: 'tok' } },
    attachFirst: false,
  },
  {
    label: 'post-attach redeemSession',
    message: { tag: 'redeemSession', payload: { token: 'tok' } },
    attachFirst: true,
  },
  {
    label: 'pre-login sessionToken',
    message: { tag: 'sessionToken', payload: sessionToken },
    attachFirst: false,
  },
  {
    label: 'post-attach sessionToken',
    message: { tag: 'sessionToken', payload: sessionToken },
    attachFirst: true,
  },
  {
    label: 'pre-login sessionRevoked',
    message: { tag: 'sessionRevoked', payload: { revoked: true } },
    attachFirst: false,
  },
  {
    label: 'post-attach sessionRevoked',
    message: { tag: 'sessionRevoked', payload: { revoked: true } },
    attachFirst: true,
  },
];

/**
 * Close-enforcement sentinel for `ConnectionActor.dispatch`: every state-illegal tag must close
 * 1002. The keep-open branches run the real handlers and are covered by their own suites.
 */
describe('ConnectionActor.dispatch', () => {
  it.each(cases)('closes with protocolError for $label', async ({ message, attachFirst }) => {
    const connection = new ConnectionActor(await makeStubConnectionDependencies());
    if (attachFirst) connection.markAttached('player', 'EdariaBibliothek', crypto.randomUUID());
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
  const HEILER: Partial<Character> = { lucidity: lucidity('heiler', { touch: 1 }), energy: energy({ healthCurrent: 50 }) };
  const TRIAL_PASSED: Partial<Character> = { lucidity: { ...NO_LUCIDITY, task: { role: 'kaempfer', teachingId: undefined, progress: 1 } } };

  afterEach(() => vi.restoreAllMocks());

  /** A dreamer beside Pugnax, with a hurt dreamer in a Mondstein's reach. */
  async function attached(character: Partial<Character>, inventory: InventoryRow[], overrides: Partial<Sector> = {}) {
    const sectors = [makeSector('Town', { npcs: [{ ...makeNPC('pugnax', { x: 10, z: 8 }, ''), service: 'kaempferMaster' }], ...overrides })];
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
    ['a swing', {}, [], () => ({ tag: 'swing', payload: {} }), (a) => a.own().character.energy.balanceCurrent, 92],
    ['a tend', HEILER, [MONDSTEIN_IN_HAND], (a) => ({ tag: 'tend', payload: { targetId: a.hurtId } }), (a) => a.hurt().energy.healthCurrent, 60],
    [
      'a use of the Mondstein',
      HEILER,
      [MONDSTEIN_IN_HAND],
      () => ({ tag: 'useItem', payload: { slot: MONDSTEIN_IN_HAND.slot } }),
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
    ['a request for the trial', {}, [], () => ({ tag: 'askTask', payload: { npcId: PUGNAX } }), (a) => a.own().character.lucidity.task?.role, 'kaempfer'],
    [
      "a request for a teaching's task",
      { lucidity: lucidity('kaempfer', { strike: 2 }) },
      [],
      () => ({ tag: 'askTask', payload: { npcId: PUGNAX, teachingId: 'follow-through' } }),
      (a) => a.own().character.lucidity.task?.teachingId,
      'follow-through',
    ],
    ['a trial handed in', TRIAL_PASSED, [], () => ({ tag: 'completeTask', payload: { npcId: PUGNAX } }), (a) => a.own().character.lucidity.role, 'kaempfer'],
    [
      'a teaching to study',
      { lucidity: lucidity('kaempfer', { strike: 1 }) },
      [],
      () => ({ tag: 'study', payload: { npcId: PUGNAX, teachingId: 'toughening' } }),
      (a) => a.own().character.lucidity.study,
      'toughening',
    ],
  ])('takes %s to the space', async (_label, character, inventory, message, read, expected) => {
    const a = await attached(character, inventory);
    expect(read(a)).not.toEqual(expected);
    expect(await a.connection.dispatch(message(a))).toEqual({ kind: 'keepOpen' });
    a.space.step(0.05);
    expect(read(a)).toEqual(expected);
  });

  /** The space runs on the machine's clock here, and a nightmare takes its respawn time to appear. */
  it('takes a swing to the space with the nightmare it names', async () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(0);
    const a = await attached({}, [], { monsterSpawns: [makeMonsterSpawn({ x: 10, z: 10.2 })] });
    now.mockReturnValue(RESPAWN_MS);
    a.space.step(0);

    expect(await a.connection.dispatch({ tag: 'swing', payload: { targetId: GHOST } })).toEqual({ kind: 'keepOpen' });

    const swings = payloads(await collectMessages(a.connection.outbox), 'blow').filter((blow) => blow.attackerId !== GHOST);
    expect(swings).toMatchObject([{ targetId: GHOST }]);
  });
});
