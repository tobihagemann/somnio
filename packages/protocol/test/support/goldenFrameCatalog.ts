import { SOMNIO_PROTOCOL_CONSTANTS } from '../../src/index.ts'
import type { SomnioMessage, WireSector } from '../../src/index.ts'

/**
 * The canonical golden-frame set: one named frame per message tag, plus fully populated nested
 * payloads.
 *
 * This catalog is the *only* declaration of the fixture contents; `golden-frames.test.ts` records
 * what pinning them against a committed file catches that the round trips cannot.
 */
export interface GoldenFrameEntry {
  name: string
  message: SomnioMessage
}

/**
 * Every nested wire shape populated at once, so the fixture exercises `WireObject`'s rotation, the
 * NPC's float heading, the monster spawn's boolean, and a floor patch.
 */
const populatedSector: WireSector = {
  name: 'EdariaMitte',
  version: 1,
  dimensions: { width: 16, height: 12 },
  floorMaterialID: 'grass-meadow',
  light: { indoor: false, brightness: 100 },
  objects: [
    { x: 128, y: 256, modelID: 'door', sourceWidth: 64, sourceHeight: 32, priority: 3, rotation: 270 },
  ],
  collisionMasks: [{ x: 128, y: 256, width: 64, height: 32 }],
  portals: [{ x: 0, y: 0, width: 32, height: 32, targetSectorName: 'Nordwiese', direction: 1 }],
  npcs: [
    {
      spawnX: 320,
      spawnY: 192,
      spawnBoxWidth: 64,
      spawnBoxHeight: 64,
      maskWidth: 32,
      maskHeight: 48,
      name: 'Libus',
      figure: 16,
      direction: 270,
      behaviorTag: 0,
      dialogScript: 'Hallo $name, willkommen!',
    },
  ],
  monsterSpawns: [
    {
      spawnX: 640,
      spawnY: 384,
      spawnBoxWidth: 128,
      spawnBoxHeight: 128,
      monsterWidth: 32,
      monsterHeight: 48,
      name: 'Gespenst',
      figure: 0,
      bounded: true,
      spawnHP: 100,
      spawnBalance: 100,
      spawnMana: 100,
      aiScriptIndex: 3,
    },
  ],
  floorPatches: [{ floorMaterialID: 'cobble-town', x: 0, y: 0, width: 512, height: 128 }],
}

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
        characterClass: 0,
        gender: 1,
        email: 'info@example.com',
      },
    },
  },
  {
    name: 'clientPosition',
    message: { tag: 'clientPosition', payload: { entityIndex: 0, x: 10, y: 20, facing: 137.5, tempo: 2 } },
  },
  { name: 'clientSay', message: { tag: 'clientSay', payload: { entityIndex: 0, text: 'Hallo Welt' } } },
  { name: 'equipToggle', message: { tag: 'equipToggle', payload: { slot: 1, hand: 2 } } },
  { name: 'bumpNPC', message: { tag: 'bumpNPC', payload: { npcIndex: 4 } } },
  { name: 'enterPortal', message: { tag: 'enterPortal', payload: { portalIndex: 2 } } },
  { name: 'redeemSession', message: { tag: 'redeemSession', payload: { token: 'tok-abc' } } },
  { name: 'revokeSession', message: { tag: 'revokeSession', payload: { token: 'tok-abc' } } },
  {
    name: 'hello',
    message: { tag: 'hello', payload: { protocolVersion: SOMNIO_PROTOCOL_CONSTANTS.helloVersion } },
  },
  { name: 'loginResult', message: { tag: 'loginResult', payload: { result: 0 } } },
  { name: 'registerResult', message: { tag: 'registerResult', payload: { result: 3 } } },
  { name: 'enterSector', message: { tag: 'enterSector', payload: { sector: populatedSector } } },
  { name: 'mainCharacter', message: { tag: 'mainCharacter', payload: { entityIndex: 5 } } },
  {
    name: 'entity',
    message: {
      tag: 'entity',
      payload: {
        entityIndex: 9,
        figure: 0,
        gender: 1,
        maskWidth: 32,
        maskHeight: 48,
        type: 0,
        name: 'Libus',
        x: 10,
        y: 12,
        facing: 359.96875,
        tempo: 2,
      },
    },
  },
  {
    name: 'serverPosition',
    message: { tag: 'serverPosition', payload: { entityIndex: 7, x: 10, y: 20, facing: 0, tempo: 4 } },
  },
  { name: 'serverSay', message: { tag: 'serverSay', payload: { entityIndex: 3, text: 'Wer bist du?' } } },
  {
    name: 'energy',
    message: {
      tag: 'energy',
      payload: {
        hpCurrent: 100,
        hpMax: 100,
        balanceCurrent: 50,
        balanceMax: 100,
        manaCurrent: 25,
        manaMax: 50,
      },
    },
  },
  { name: 'dateTick', message: { tag: 'dateTick', payload: { hour: 7, minute: 33 } } },
  {
    name: 'inventory',
    message: {
      tag: 'inventory',
      payload: {
        rows: [
          { slot: 0, category: 0, itemId: 0, extras: [{ key: 'gold', value: 100 }], equippedHand: 0 },
          { slot: 1, category: 1, itemId: 0, extras: [], equippedHand: 2 },
        ],
      },
    },
  },
  { name: 'leave', message: { tag: 'leave', payload: { entityIndex: 4, leftGame: true } } },
  { name: 'adminSay', message: { tag: 'adminSay', payload: { text: 'Server restart in 5 minutes' } } },
  {
    name: 'sessionToken',
    message: { tag: 'sessionToken', payload: { token: 'tok-abc', expiresInSeconds: 2_592_000 } },
  },
  { name: 'sessionRevoked', message: { tag: 'sessionRevoked', payload: { revoked: true } } },
]
