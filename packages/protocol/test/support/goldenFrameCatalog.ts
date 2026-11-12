import { SOMNIO_PROTOCOL_CONSTANTS } from '../../src/index.ts';
import type { SectorView, SomnioMessage } from '../../src/index.ts';

/**
 * The canonical golden-frame set: one named frame per message tag, plus fully populated nested
 * payloads.
 *
 * This catalog is the *only* declaration of the fixture contents; `golden-frames.test.ts` records
 * what pinning them against a committed file catches that the round trips cannot.
 */
export interface GoldenFrameEntry {
  name: string;
  message: SomnioMessage;
}

const PLAYER_ID = '0b9f6c1e-5d4a-4e7b-9a6c-1d2e3f4a5b6c';
const OTHER_PLAYER_ID = '7c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
const FALLEN_PLAYER_ID = '3e4f5a6b-7c8d-4e9f-a0b1-c2d3e4f5a6b7';
const NPC_ID = 'npc:EdariaLibrary/libus';
const MASTER_ID = 'npc:EdariaFighterHall/pugnax';
const SHOPKEEPER_ID = 'npc:EdariaShop/mercus';
const BOARD_ID = 'fixture:EdariaSquare/fixture-1';
const SWORD_ID = '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b';
const MOONSTONE_ID = '0190a1b2-c3d5-7a1b-9c2d-3e4f5a6b7c8d';
const CAP_ID = '0190a1b2-c3d6-7b2c-8d3e-4f5a6b7c8d9e';
const RING_ID = '0190a1b2-c3d7-7c3d-8e4f-5a6b7c8d9eaf';
const LOOT_ID = 'loot-12';
const BOUNTY_ID = 'bounty:168000:Graveyard:skeleton-warrior:collect';
const BOUNTY = {
  day: 168000,
  land: 'Graveyard',
  monsterKind: 'skeleton-warrior',
  objective: 'collect',
  count: 4,
  reward: { coins: 120, gear: 3 },
} as const;

/** Every record array populated at once, both ground mark shapes, and a placement that carries a non-zero `yaw` and `elevation`. */
const outdoorSector: SectorView = {
  name: 'EdariaSquare',
  kind: 'outdoor',
  origin: { x: 0, z: 0 },
  size: { width: 40.96, depth: 40.96 },
  ground: {
    backgroundMaterialId: 'grass-meadow',
    marks: [
      {
        id: 'plaza',
        materialId: 'cobble-town',
        opacity: 1,
        shape: {
          kind: 'polygon',
          points: [
            { x: 16, z: 0 },
            { x: 24.96, z: 0 },
            { x: 24.96, z: 20 },
          ],
        },
      },
      {
        id: 'road',
        materialId: 'dirt-path',
        opacity: 0.8,
        shape: {
          kind: 'stroke',
          radius: 1.6,
          points: [
            { x: 2, z: 20 },
            { x: 38.96, z: 22 },
          ],
        },
      },
    ],
  },
  placements: [
    { id: 'townhall', modelId: 'building-townhall', x: 36.8, z: 4.48, yaw: 270, elevation: 0.75 },
    { id: 'tower', modelId: 'building-tower', x: 3.6, z: 28.5, yaw: 0, elevation: 0 },
    { id: 'notice-board-1', modelId: 'notice-board', x: 18.15, z: 18.1, yaw: 35, elevation: 0 },
  ],
  blockers: [{ id: 'north-cliff', x: 0, z: 0, width: 16, depth: 0.64 }],
  doors: [
    { id: 'to-edarialibrary', placement: 'townhall', anchor: 'main', target: { sector: 'EdariaLibrary', door: 'exit' } },
    { id: 'to-edariamystictower', placement: 'tower', anchor: 'main', target: { sector: 'EdariaMysticTower', door: 'exit' }, nightOnly: true },
  ],
  fixtures: [{ id: 'fixture-1', placement: 'notice-board-1', service: 'bountyBoard' }],
};

const interiorSector: SectorView = {
  name: 'EdariaLibrary',
  kind: 'interior',
  brightness: 75,
  size: { width: 10.24, depth: 7.68 },
  ground: { backgroundMaterialId: 'wood-warm', marks: [] },
  placements: [{ id: 'door-1', modelId: 'timber-room-threshold', x: 5.12, z: 7.36, yaw: 0, elevation: 0 }],
  blockers: [],
  doors: [{ id: 'exit', placement: 'door-1', anchor: 'main', target: { sector: 'EdariaSquare', door: 'to-edarialibrary' } }],
  fixtures: [],
};

/** Every tag must appear, so a new message cannot ship without a fixture. */
export const GOLDEN_FRAME_ENTRIES: readonly GoldenFrameEntry[] = [
  { name: 'login', message: { tag: 'login', payload: { email: 'info@example.com', password: 'hunter2' } } },
  {
    name: 'login-with-session-request',
    message: {
      tag: 'login',
      payload: { email: 'info@example.com', password: 'hunter2', requestSessionToken: true },
    },
  },
  { name: 'login-with-locale', message: { tag: 'login', payload: { email: 'info@example.com', password: 'hunter2', locale: 'de' } } },
  {
    name: 'register',
    message: {
      tag: 'register',
      payload: {
        email: 'info@example.com',
        password: 'passw0rd',
        passwordRepeat: 'passw0rd',
      },
    },
  },
  { name: 'createCharacter', message: { tag: 'createCharacter', payload: { name: 'Saibot', people: 'vigils' } } },
  { name: 'selectCharacter', message: { tag: 'selectCharacter', payload: { characterId: PLAYER_ID } } },
  { name: 'deleteCharacter', message: { tag: 'deleteCharacter', payload: { characterId: OTHER_PLAYER_ID } } },
  { name: 'move', message: { tag: 'move', payload: { x: 10.25, z: 20.5, facing: 137.5, gait: 'jog' } } },
  { name: 'clientSay', message: { tag: 'clientSay', payload: { text: 'Hallo Welt', kind: 'say' } } },
  { name: 'clientSay-yell', message: { tag: 'clientSay', payload: { text: 'Hilfe!', kind: 'yell' } } },
  { name: 'equip', message: { tag: 'equip', payload: { itemId: SWORD_ID } } },
  { name: 'equip-into-slot', message: { tag: 'equip', payload: { itemId: RING_ID, slot: 'ring2' } } },
  { name: 'unequip', message: { tag: 'unequip', payload: { slot: 'offHand' } } },
  { name: 'moveItem', message: { tag: 'moveItem', payload: { itemId: CAP_ID, place: 7 } } },
  { name: 'dropItem', message: { tag: 'dropItem', payload: { itemId: CAP_ID, heading: 247.5 } } },
  { name: 'pickUp', message: { tag: 'pickUp', payload: { lootId: LOOT_ID } } },
  { name: 'interact', message: { tag: 'interact', payload: { carrierId: NPC_ID } } },
  { name: 'interact-fixture', message: { tag: 'interact', payload: { carrierId: BOARD_ID } } },
  { name: 'target', message: { tag: 'target', payload: { targetId: 'monster:7' } } },
  { name: 'target-none', message: { tag: 'target', payload: {} } },
  { name: 'engage-on', message: { tag: 'engage', payload: { on: true } } },
  { name: 'engage-off', message: { tag: 'engage', payload: { on: false } } },
  { name: 'useAbility', message: { tag: 'useAbility', payload: { abilityId: 'brace' } } },
  { name: 'useDoor', message: { tag: 'useDoor', payload: { sector: 'EdariaSquare', doorId: 'to-edarialibrary' } } },
  { name: 'acceptQuest', message: { tag: 'acceptQuest', payload: { carrierId: MASTER_ID, questId: 'follow-through-task' } } },
  { name: 'turnInQuest', message: { tag: 'turnInQuest', payload: { carrierId: MASTER_ID, questId: 'follow-through-task' } } },
  { name: 'abandonQuest', message: { tag: 'abandonQuest', payload: { questId: 'follow-through-task' } } },
  { name: 'acceptQuest-bounty', message: { tag: 'acceptQuest', payload: { carrierId: BOARD_ID, questId: BOUNTY_ID } } },
  { name: 'study', message: { tag: 'study', payload: { carrierId: MASTER_ID, teachingId: 'follow-through' } } },
  { name: 'buy', message: { tag: 'buy', payload: { carrierId: SHOPKEEPER_ID, baseId: 'dagger' } } },
  { name: 'sell', message: { tag: 'sell', payload: { carrierId: SHOPKEEPER_ID, itemId: CAP_ID } } },
  { name: 'wake', message: { tag: 'wake', payload: {} } },
  { name: 'redeemSession', message: { tag: 'redeemSession', payload: { token: 'tok-abc' } } },
  { name: 'redeemSession-with-locale', message: { tag: 'redeemSession', payload: { token: 'tok-abc', locale: 'de' } } },
  { name: 'revokeSession', message: { tag: 'revokeSession', payload: { token: 'tok-abc' } } },
  { name: 'revokeOtherSessions', message: { tag: 'revokeOtherSessions', payload: {} } },
  {
    name: 'hello',
    message: { tag: 'hello', payload: { protocolVersion: SOMNIO_PROTOCOL_CONSTANTS.helloVersion } },
  },
  { name: 'loginResult', message: { tag: 'loginResult', payload: { result: 'ok' } } },
  { name: 'registerResult', message: { tag: 'registerResult', payload: { result: 'emailExists' } } },
  {
    name: 'characters',
    message: {
      tag: 'characters',
      payload: {
        characters: [
          { id: PLAYER_ID, name: 'Saibot', people: 'vigils', role: 'healer' },
          { id: OTHER_PLAYER_ID, name: 'Ida', people: 'umbrae' },
        ],
      },
    },
  },
  { name: 'characterResult', message: { tag: 'characterResult', payload: { result: 'nameExists' } } },
  {
    name: 'enterSpace',
    message: { tag: 'enterSpace', payload: { spaceId: 'outdoors', selfId: PLAYER_ID, people: 'umbrae', worldSeconds: 14_515_243_200.5 } },
  },
  { name: 'sector', message: { tag: 'sector', payload: { sector: outdoorSector } } },
  { name: 'sector-interior', message: { tag: 'sector', payload: { sector: interiorSector, outdoorDoorIds: ['exit'] } } },
  {
    name: 'entity',
    message: {
      tag: 'entity',
      payload: {
        id: NPC_ID,
        kind: 'npc',
        characterModelId: 'libus',
        name: 'Libus',
        radius: 0.3,
        x: 5.12,
        z: 3.84,
        facing: 359.96875,
        gait: 'walk',
        condition: 'hale',
      },
    },
  },
  {
    name: 'entity-player',
    message: {
      tag: 'entity',
      payload: {
        id: OTHER_PLAYER_ID,
        kind: 'player',
        characterModelId: 'dreamer',
        name: 'Alice',
        radius: 0.3,
        x: 12.5,
        z: 7.25,
        facing: 90,
        gait: 'run',
        condition: 'grazed',
        held: { mainHand: 'sword', offHand: 'moonstone' },
      },
    },
  },
  {
    name: 'entity-with-service',
    message: {
      tag: 'entity',
      payload: {
        id: MASTER_ID,
        kind: 'npc',
        characterModelId: 'fighter-master',
        name: 'Pugnax',
        radius: 0.3,
        x: 37.32,
        z: 33.2,
        facing: 0,
        gait: 'jog',
        condition: 'hale',
        service: 'fighterMaster',
      },
    },
  },
  {
    name: 'entity-mystic-master',
    message: {
      tag: 'entity',
      payload: {
        id: 'npc:EdariaMysticTower/tacita',
        kind: 'npc',
        characterModelId: 'libus',
        name: 'Tacita',
        radius: 0.3,
        x: 4.5,
        z: 3.25,
        facing: 180,
        gait: 'jog',
        condition: 'hale',
        service: 'mysticMaster',
      },
    },
  },
  {
    name: 'entity-elite',
    message: {
      tag: 'entity',
      payload: {
        id: 'monster:7',
        kind: 'monster',
        characterModelId: 'ghost',
        name: 'Ghost',
        radius: 0.3,
        x: 14.5,
        z: 6.25,
        facing: 180,
        gait: 'jog',
        condition: 'wounded',
        rank: 'elite',
        trait: 'shielded',
      },
    },
  },
  {
    name: 'entity-boss',
    message: {
      tag: 'entity',
      payload: {
        id: 'monster:3',
        kind: 'monster',
        characterModelId: 'necromancer',
        name: 'Necromancer',
        radius: 0.3,
        x: 9,
        z: 4.5,
        facing: 0,
        gait: 'jog',
        condition: 'hurt',
        rank: 'boss',
      },
    },
  },
  {
    name: 'entity-summoned',
    message: {
      tag: 'entity',
      payload: {
        id: 'monster:9',
        kind: 'monster',
        characterModelId: 'skeleton-minion',
        name: 'Skeleton',
        radius: 0.3,
        x: 10.75,
        z: 6,
        facing: 0,
        gait: 'jog',
        condition: 'hale',
        summonedBy: 'monster:3',
      },
    },
  },
  {
    name: 'moves',
    message: {
      tag: 'moves',
      payload: {
        moves: [
          { id: PLAYER_ID, x: 10.25, z: 20.5, facing: 0, gait: 'run' },
          { id: 'monster:7', x: 12, z: -3.5, facing: 222.5, gait: 'jog' },
        ],
      },
    },
  },
  { name: 'correction', message: { tag: 'correction', payload: { x: 10.25, z: 20.5 } } },
  { name: 'doorRefused', message: { tag: 'doorRefused', payload: { sector: 'EdariaSquare', doorId: 'to-edarialibrary' } } },
  {
    name: 'serverSay',
    message: { tag: 'serverSay', payload: { entityId: NPC_ID, name: 'Libus', kind: 'say', text: 'Greetings, Saibot!', clarity: 1, x: 5.12, z: 3.84 } },
  },
  {
    name: 'serverSay-through-door',
    message: { tag: 'serverSay', payload: { entityId: PLAYER_ID, name: 'Saibot', kind: 'yell', text: 'Hilfe ... hier!', clarity: 0.375, x: 36.8, z: 7.04 } },
  },
  {
    name: 'energy',
    message: {
      tag: 'energy',
      payload: {
        healthCurrent: 100,
        healthMax: 100,
        balanceCurrent: 50,
        balanceMax: 100,
        spiritCurrent: 25,
        spiritMax: 50,
      },
    },
  },
  {
    name: 'inventory',
    message: {
      tag: 'inventory',
      payload: {
        coins: 100,
        equipped: [
          {
            slot: 'mainHand',
            item: {
              id: SWORD_ID,
              baseId: 'sword',
              tier: 1,
              rarity: 'rare',
              affixes: [
                { affixId: 'damage', value: 2 },
                { affixId: 'swing-speed', value: 5 },
                { affixId: 'balance', value: 7 },
              ],
            },
          },
          { slot: 'offHand', item: { id: MOONSTONE_ID, baseId: 'moonstone', tier: 1, rarity: 'plain', affixes: [] } },
        ],
        bag: [{ place: 3, item: { id: CAP_ID, baseId: 'cap', tier: 1, rarity: 'magic', affixes: [{ affixId: 'guard', value: 2 }] } }],
      },
    },
  },
  {
    name: 'inventory-after-trade',
    message: {
      tag: 'inventory',
      payload: {
        coins: 105,
        equipped: [],
        bag: [],
        trade: { kind: 'sold', baseId: 'cap', rarity: 'magic', coins: 5 },
      },
    },
  },
  {
    name: 'inventory-after-drop',
    message: {
      tag: 'inventory',
      payload: { coins: 100, equipped: [], bag: [], dropped: { kind: 'item', baseId: 'cap', rarity: 'magic' } },
    },
  },
  {
    name: 'inventory-after-pick-up',
    message: {
      tag: 'inventory',
      payload: {
        coins: 100,
        equipped: [],
        bag: [{ place: 3, item: { id: CAP_ID, baseId: 'cap', tier: 1, rarity: 'magic', affixes: [{ affixId: 'guard', value: 2 }] } }],
        pickedUp: { kind: 'item', baseId: 'cap', rarity: 'magic' },
      },
    },
  },
  {
    name: 'inventory-after-turn-in',
    message: {
      tag: 'inventory',
      payload: {
        coins: 172,
        equipped: [],
        bag: [{ place: 0, item: { id: CAP_ID, baseId: 'cap', tier: 3, rarity: 'rare', affixes: [{ affixId: 'guard', value: 5 }] } }],
        rewarded: [{ kind: 'item', baseId: 'cap', rarity: 'rare' }],
      },
    },
  },
  {
    name: 'inventory-after-trophy',
    message: { tag: 'inventory', payload: { coins: 100, equipped: [], bag: [], pickedUp: { kind: 'trophy', monsterKind: 'skeleton-warrior' } } },
  },
  { name: 'loot', message: { tag: 'loot', payload: { lootId: LOOT_ID, x: 31.5, z: -12.25, contents: { kind: 'item', baseId: 'cap', rarity: 'magic' } } } },
  {
    name: 'loot-trophy',
    message: {
      tag: 'loot',
      payload: { lootId: LOOT_ID, x: 31.5, z: -12.25, contents: { kind: 'trophy', monsterKind: 'skeleton-warrior' }, from: { x: 31, z: -12 } },
    },
  },
  {
    name: 'loot-shared',
    message: { tag: 'loot', payload: { lootId: LOOT_ID, x: 31.5, z: -12.25, contents: { kind: 'item', baseId: 'cap', rarity: 'magic' }, shared: true } },
  },
  {
    name: 'loot-thrown',
    message: {
      tag: 'loot',
      payload: {
        lootId: LOOT_ID,
        x: 31.5,
        z: -12.25,
        contents: { kind: 'item', baseId: 'cap', rarity: 'magic' },
        shared: true,
        from: { x: 32.25, z: -11.5, entityId: PLAYER_ID },
      },
    },
  },
  {
    name: 'loot-thrown-from-hand',
    message: {
      tag: 'loot',
      payload: {
        lootId: LOOT_ID,
        x: 31.5,
        z: -12.25,
        contents: { kind: 'item', baseId: 'sword', rarity: 'rare' },
        shared: true,
        from: { x: 32.25, z: -11.5, entityId: PLAYER_ID, hand: 'mainHand' },
      },
    },
  },
  {
    name: 'loot-scattered',
    message: {
      tag: 'loot',
      payload: { lootId: LOOT_ID, x: 31.5, z: -12.25, contents: { kind: 'item', baseId: 'cap', rarity: 'rare' }, from: { x: 31, z: -12 } },
    },
  },
  { name: 'lootGone', message: { tag: 'lootGone', payload: { lootId: LOOT_ID } } },
  { name: 'leave', message: { tag: 'leave', payload: { entityId: PLAYER_ID, leftGame: true } } },
  { name: 'leave-crumbled', message: { tag: 'leave', payload: { entityId: 'monster:8', leftGame: false, crumbled: true } } },
  {
    name: 'lucidity',
    message: {
      tag: 'lucidity',
      payload: {
        role: 'fighter',
        ranks: [
          { teachingId: 'strike', rank: 2, practice: 12.5 },
          { teachingId: 'follow-through', rank: 0, practice: 0 },
        ],
        study: 'strike',
      },
    },
  },
  {
    name: 'lucidity-mystic',
    message: {
      tag: 'lucidity',
      payload: {
        role: 'mystic',
        ranks: [
          { teachingId: 'ward', rank: 2, practice: 4.5 },
          { teachingId: 'sense-the-fallen', rank: 1, practice: 0 },
        ],
        study: 'ward',
      },
    },
  },
  { name: 'lucidity-empty', message: { tag: 'lucidity', payload: { ranks: [] } } },
  {
    name: 'quests',
    message: {
      tag: 'quests',
      payload: { active: [{ questId: 'follow-through-task', progress: [2] }], done: ['fighter-trial'], bounties: [] },
    },
  },
  {
    name: 'quests-bounties',
    message: {
      tag: 'quests',
      payload: {
        active: [{ questId: BOUNTY_ID, progress: [1], definition: BOUNTY }],
        done: ['bounty:168000:AutumnWood:ghost:driveOff'],
        bounties: [BOUNTY, { day: 168000, land: 'AutumnWood', monsterKind: 'ghost', objective: 'driveOff', count: 10, reward: { coins: 120, gear: 1 } }],
      },
    },
  },
  { name: 'quests-empty', message: { tag: 'quests', payload: { active: [], done: [], bounties: [] } } },
  { name: 'condition', message: { tag: 'condition', payload: { entityId: 'monster:7', condition: 'hurt' } } },
  { name: 'held', message: { tag: 'held', payload: { entityId: OTHER_PLAYER_ID, held: { mainHand: 'dagger' } } } },
  { name: 'vitals', message: { tag: 'vitals', payload: { entityId: 'monster:7', health: 0.42 } } },
  { name: 'effects', message: { tag: 'effects', payload: { entityId: PLAYER_ID, effects: [{ effectId: 'braced', seconds: 3.25 }] } } },
  {
    name: 'effects-mystic',
    message: {
      tag: 'effects',
      payload: {
        entityId: PLAYER_ID,
        effects: [
          { effectId: 'warded', seconds: 11.5 },
          { effectId: 'veiled', seconds: 4 },
        ],
      },
    },
  },
  {
    name: 'effects-on-a-nightmare',
    message: {
      tag: 'effects',
      payload: {
        entityId: 'monster:7',
        effects: [
          { effectId: 'weakened', seconds: 7.75 },
          { effectId: 'bound', seconds: 2.5 },
        ],
      },
    },
  },
  {
    name: 'effects-on-an-elite',
    message: { tag: 'effects', payload: { entityId: 'monster:7', effects: [{ effectId: 'stony' }, { effectId: 'weakened', seconds: 7.75 }] } },
  },
  { name: 'effects-none', message: { tag: 'effects', payload: { entityId: 'monster:7', effects: [] } } },
  { name: 'blow', message: { tag: 'blow', payload: { attackerId: PLAYER_ID, targetId: 'monster:7', hit: true } } },
  { name: 'blow-miss', message: { tag: 'blow', payload: { attackerId: 'monster:7', targetId: PLAYER_ID, hit: false } } },
  { name: 'ability', message: { tag: 'ability', payload: { entityId: PLAYER_ID, abilityId: 'lunge', targetId: 'monster:7' } } },
  { name: 'ability-dream-bolt', message: { tag: 'ability', payload: { entityId: PLAYER_ID, abilityId: 'dream-bolt', targetId: 'monster:7' } } },
  {
    name: 'ability-dream-bolt-evaded',
    message: { tag: 'ability', payload: { entityId: PLAYER_ID, abilityId: 'dream-bolt', targetId: 'monster:7', evaded: true } },
  },
  { name: 'ability-on-self', message: { tag: 'ability', payload: { entityId: PLAYER_ID, abilityId: 'brace' } } },
  {
    name: 'ability-channel-start',
    message: { tag: 'ability', payload: { entityId: PLAYER_ID, abilityId: 'deep-mend', targetId: OTHER_PLAYER_ID, phase: 'start', seconds: 1.5 } },
  },
  {
    name: 'ability-channel-under-way',
    message: { tag: 'ability', payload: { entityId: PLAYER_ID, abilityId: 'deep-mend', targetId: OTHER_PLAYER_ID, phase: 'channel', seconds: 0.5 } },
  },
  {
    name: 'ability-channel-done',
    message: { tag: 'ability', payload: { entityId: PLAYER_ID, abilityId: 'deep-mend', targetId: OTHER_PLAYER_ID, phase: 'done' } },
  },
  { name: 'ability-channel-broken', message: { tag: 'ability', payload: { entityId: PLAYER_ID, abilityId: 'deep-mend', phase: 'broken' } } },
  { name: 'cooldowns', message: { tag: 'cooldowns', payload: { globalSeconds: 0.5, cooldowns: [{ abilityId: 'brace', seconds: 14.5 }] } } },
  { name: 'cooldowns-none', message: { tag: 'cooldowns', payload: { globalSeconds: 0, cooldowns: [] } } },
  {
    name: 'raising',
    message: {
      tag: 'raising',
      payload: { targetId: FALLEN_PLAYER_ID, healerIds: [PLAYER_ID, OTHER_PLAYER_ID], state: 'holding', progress: 0.25, seconds: 2.25 },
    },
  },
  {
    name: 'raising-paused',
    message: {
      tag: 'raising',
      payload: { targetId: FALLEN_PLAYER_ID, healerIds: [PLAYER_ID, OTHER_PLAYER_ID], state: 'holding', progress: 0.25, seconds: 2.75, pausedSeconds: [0, 1] },
    },
  },
  { name: 'mend', message: { tag: 'mend', payload: { targetId: OTHER_PLAYER_ID } } },
  {
    name: 'sensed',
    message: {
      tag: 'sensed',
      payload: {
        bearings: [
          { name: 'Ida', x: 31.5, z: -12.25 },
          { name: 'Mira', x: 2, z: 40.75 },
        ],
      },
    },
  },
  { name: 'sensed-none', message: { tag: 'sensed', payload: { bearings: [] } } },
  {
    name: 'telegraph',
    message: { tag: 'telegraph', payload: { id: 'telegraph-4', casterId: 'monster:3', kind: 'wail', x: 9, z: 4.5, radius: 4, seconds: 1.25 } },
  },
  { name: 'adminSay', message: { tag: 'adminSay', payload: { text: 'Server restart in 5 minutes' } } },
  {
    name: 'sessionToken',
    message: { tag: 'sessionToken', payload: { token: 'tok-abc', expiresInSeconds: 2_592_000 } },
  },
  { name: 'sessionRevoked', message: { tag: 'sessionRevoked', payload: { revoked: true } } },
  { name: 'otherSessions', message: { tag: 'otherSessions', payload: { count: 2 } } },
  { name: 'otherSessionsRevoked', message: { tag: 'otherSessionsRevoked', payload: { revoked: true, count: 2 } } },
];
