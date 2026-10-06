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
const NPC_ID = 'npc:EdariaBibliothek/libus';
const MASTER_ID = 'npc:EdariaMitte/pugnax';

/** Every record array populated at once, with a placement that carries a non-zero `yaw` and `elevation`. */
const outdoorSector: SectorView = {
  name: 'EdariaMitte',
  kind: 'outdoor',
  origin: { x: 0, z: 0 },
  size: { width: 40.96, depth: 40.96 },
  floorMaterialId: 'grass-meadow',
  floorPatches: [{ id: 'patch-1', floorMaterialId: 'cobble-town', x: 16, z: 0, width: 8.96, depth: 20 }],
  placements: [{ id: 'townhall', modelId: 'building-townhall', x: 36.8, z: 4.48, yaw: 270, elevation: 0.75 }],
  blockers: [{ id: 'north-cliff', x: 0, z: 0, width: 16, depth: 0.64 }],
  doors: [{ id: 'to-edariabibliothek', placement: 'townhall', anchor: 'main', target: { sector: 'EdariaBibliothek', door: 'exit' } }],
};

const interiorSector: SectorView = {
  name: 'EdariaBibliothek',
  kind: 'interior',
  brightness: 75,
  size: { width: 10.24, depth: 7.68 },
  floorMaterialId: 'wood-warm',
  floorPatches: [],
  placements: [{ id: 'door-1', modelId: 'door', x: 5.12, z: 7.36, yaw: 0, elevation: 0 }],
  blockers: [],
  doors: [{ id: 'exit', placement: 'door-1', anchor: 'main', target: { sector: 'EdariaMitte', door: 'to-edariabibliothek' } }],
};

/** Every tag must appear, so a new message cannot ship without a fixture. */
export const GOLDEN_FRAME_ENTRIES: readonly GoldenFrameEntry[] = [
  { name: 'login', message: { tag: 'login', payload: { nickname: 'Saibot', password: 'hunter2' } } },
  {
    name: 'login-with-session-request',
    message: {
      tag: 'login',
      payload: { nickname: 'Saibot', password: 'hunter2', requestSessionToken: true },
    },
  },
  {
    name: 'register',
    message: {
      tag: 'register',
      payload: {
        nickname: 'Saibot',
        password: 'passw0rd',
        passwordRepeat: 'passw0rd',
        people: 'wachen',
        email: 'info@example.com',
      },
    },
  },
  { name: 'move', message: { tag: 'move', payload: { x: 10.25, z: 20.5, facing: 137.5, gait: 'jog' } } },
  { name: 'clientSay', message: { tag: 'clientSay', payload: { text: 'Hallo Welt' } } },
  { name: 'equipToggle', message: { tag: 'equipToggle', payload: { slot: 1, hand: 'right' } } },
  { name: 'talk', message: { tag: 'talk', payload: { npcId: NPC_ID } } },
  { name: 'swing', message: { tag: 'swing', payload: { targetId: 'monster:7' } } },
  { name: 'swing-air', message: { tag: 'swing', payload: {} } },
  { name: 'tend', message: { tag: 'tend', payload: { targetId: OTHER_PLAYER_ID } } },
  { name: 'tend-no-one', message: { tag: 'tend', payload: {} } },
  { name: 'useDoor', message: { tag: 'useDoor', payload: { sector: 'EdariaMitte', doorId: 'to-edariabibliothek' } } },
  { name: 'askTask', message: { tag: 'askTask', payload: { npcId: MASTER_ID, teachingId: 'follow-through' } } },
  { name: 'askTask-trial', message: { tag: 'askTask', payload: { npcId: MASTER_ID } } },
  { name: 'completeTask', message: { tag: 'completeTask', payload: { npcId: MASTER_ID } } },
  { name: 'abandonTask', message: { tag: 'abandonTask', payload: {} } },
  { name: 'study', message: { tag: 'study', payload: { npcId: MASTER_ID, teachingId: 'follow-through' } } },
  { name: 'wake', message: { tag: 'wake', payload: {} } },
  { name: 'useItem', message: { tag: 'useItem', payload: { slot: 2 } } },
  { name: 'redeemSession', message: { tag: 'redeemSession', payload: { token: 'tok-abc' } } },
  { name: 'revokeSession', message: { tag: 'revokeSession', payload: { token: 'tok-abc' } } },
  {
    name: 'hello',
    message: { tag: 'hello', payload: { protocolVersion: SOMNIO_PROTOCOL_CONSTANTS.helloVersion } },
  },
  { name: 'loginResult', message: { tag: 'loginResult', payload: { result: 'ok' } } },
  { name: 'registerResult', message: { tag: 'registerResult', payload: { result: 'nameNotAllowed' } } },
  {
    name: 'enterSpace',
    message: { tag: 'enterSpace', payload: { spaceId: 'outdoors', selfId: PLAYER_ID, worldSeconds: 14_515_243_200.5 } },
  },
  { name: 'sector', message: { tag: 'sector', payload: { sector: outdoorSector } } },
  { name: 'sector-interior', message: { tag: 'sector', payload: { sector: interiorSector } } },
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
    name: 'entity-with-service',
    message: {
      tag: 'entity',
      payload: {
        id: MASTER_ID,
        kind: 'npc',
        characterModelId: 'kaempfer-meister',
        name: 'Pugnax',
        radius: 0.3,
        x: 37.32,
        z: 33.2,
        facing: 0,
        gait: 'jog',
        condition: 'hale',
        service: 'kaempferMaster',
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
  { name: 'doorRefused', message: { tag: 'doorRefused', payload: { sector: 'EdariaMitte', doorId: 'to-edariabibliothek' } } },
  { name: 'serverSay', message: { tag: 'serverSay', payload: { entityId: NPC_ID, text: 'Wer bist du?' } } },
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
        rows: [
          { slot: 0, itemId: 'purse', quantity: 100 },
          { slot: 1, itemId: 'cudgel', quantity: 1, equippedHand: 'right' },
        ],
      },
    },
  },
  { name: 'leave', message: { tag: 'leave', payload: { entityId: PLAYER_ID, leftGame: true } } },
  {
    name: 'lucidity',
    message: {
      tag: 'lucidity',
      payload: {
        role: 'kaempfer',
        ranks: [
          { teachingId: 'strike', rank: 2, practice: 12.5 },
          { teachingId: 'follow-through', rank: 0, practice: 0 },
        ],
        study: 'strike',
        task: { role: 'kaempfer', teachingId: 'follow-through', progress: 1 },
      },
    },
  },
  { name: 'lucidity-empty', message: { tag: 'lucidity', payload: { ranks: [] } } },
  { name: 'condition', message: { tag: 'condition', payload: { entityId: 'monster:7', condition: 'hurt' } } },
  { name: 'blow', message: { tag: 'blow', payload: { attackerId: PLAYER_ID, targetId: 'monster:7', hit: true } } },
  { name: 'blow-air', message: { tag: 'blow', payload: { attackerId: PLAYER_ID, hit: false } } },
  { name: 'raising', message: { tag: 'raising', payload: { healerId: PLAYER_ID, targetId: OTHER_PLAYER_ID, state: 'begun', seconds: 6 } } },
  { name: 'adminSay', message: { tag: 'adminSay', payload: { text: 'Server restart in 5 minutes' } } },
  {
    name: 'sessionToken',
    message: { tag: 'sessionToken', payload: { token: 'tok-abc', expiresInSeconds: 2_592_000 } },
  },
  { name: 'sessionRevoked', message: { tag: 'sessionRevoked', payload: { revoked: true } } },
];
