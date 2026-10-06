import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { OUTDOOR_SPACE_ID, SOMNIO_CONSTANTS, WORLD_TIME_RATE, dialogLine, dialogSteps, distance, headingFromCardinal, resolveDoor } from '@somnio/core';
import type { Point } from '@somnio/core';
import { PostgresCharacterRepository, PostgresWorldClockRepository, STARTER_SECTOR } from '@somnio/data';
import { CLOSE_GOING_AWAY } from '../../src/connection/connectionActor.ts';
import { TestClient } from '../support/liveServer.ts';
import {
  bootTestServer,
  closeAndAwaitCleanup,
  drainFrames,
  fixtureWorld,
  frame,
  joinFreshPlayer,
  joinFreshPlayerAt,
  loginOverWire,
  pollUntil,
  registerFrame,
  selfPosition,
  standableNear,
  startDatabase,
  uniqueNickname,
} from './support/harness.ts';
import type { DatabaseHarness, TestServer } from './support/harness.ts';

const SEEDED_WORLD_SECONDS = 20_000_000_000.25;
const LIBUS = `npc:${STARTER_SECTOR}/libus`;

let harness: DatabaseHarness;
let server: TestServer;
const world = fixtureWorld();
const bibliothek = world.spaces.get(STARTER_SECTOR)!.sectors[0]!;
const mitte = world.spaces.get(OUTDOOR_SPACE_ID)!.sectors.find((sector) => sector.name === 'EdariaMitte')!;
const libraryExit = resolveDoor(
  bibliothek,
  bibliothek.doors.find((door) => door.id === 'exit')!,
  world.registry,
)!;
const townhallDoor = resolveDoor(
  mitte,
  mitte.doors.find((door) => door.id === 'to-edariabibliothek')!,
  world.registry,
)!;

function library() {
  return server.server.worldRouter.space(STARTER_SECTOR)!;
}

/** A point a short step from `from` that a player can stand on. */
function stepFrom(from: Point): Point {
  return standableNear(library(), from, 2 * SOMNIO_CONSTANTS.playerRadius + 0.2);
}

beforeAll(async () => {
  harness = await startDatabase();
  await new PostgresWorldClockRepository(harness.db).save(SEEDED_WORLD_SECONDS);
  server = await bootTestServer(harness.url);
});
// A closed socket's server-side unregister and `leave` broadcast finish after the client's own
// close event, so without this a test's first joiner can receive the previous test's stale
// `leave` ahead of the one it waits for.
afterEach(async () => {
  await pollUntil(() => Promise.resolve(server.server.worldRouter.loggedInPlayerCount() === 0 ? true : undefined));
});
afterAll(async () => {
  await server.stop();
  await harness.stop();
});

describe('gameplay end to end', () => {
  it('register then login flow surfaces success codes', async () => {
    const nickname = uniqueNickname('alice');
    const client = await TestClient.open(server.url);
    await client.next();
    client.send(registerFrame(nickname));
    expect(await client.next()).toEqual({ tag: 'registerResult', payload: { result: 'ok' } });
    client.send(frame({ tag: 'login', payload: { nickname, password: 'secret-pass' } }));
    expect(await client.next()).toEqual({ tag: 'loginResult', payload: { result: 'ok' } });
    await client.close();
  });

  it('a fresh player joins the starter sector at its spawn, with the world clock in enterSpace', async () => {
    const joined = await joinFreshPlayer(server.url, 'fresh');
    expect(joined.join.map((message) => message.tag).slice(0, 7)).toEqual(['loginResult', 'enterSpace', 'sector', 'entity', 'inventory', 'energy', 'lucidity']);
    expect(joined.spaceId).toBe(STARTER_SECTOR);
    expect(selfPosition(joined)).toEqual({ x: bibliothek.spawn!.x, z: bibliothek.spawn!.z });
    const enter = joined.join[1]!;
    const worldSeconds = enter.tag === 'enterSpace' ? enter.payload.worldSeconds : Number.NaN;
    // The clock was loaded from the database and has only run forward since the boot.
    expect(worldSeconds).toBeGreaterThanOrEqual(SEEDED_WORLD_SECONDS);
    expect(worldSeconds).toBeLessThan(SEEDED_WORLD_SECONDS + 600 * WORLD_TIME_RATE);
    expect(joined.join.filter((message) => message.tag === 'entity').map((message) => message.tag === 'entity' && message.payload.id)).toContain(LIBUS);
    await joined.client.close();
  });

  it('a move reaches a peer in the same space in a moves batch and never echoes to the mover', async () => {
    const listener = await joinFreshPlayer(server.url, 'peer-a');
    const mover = await joinFreshPlayer(server.url, 'peer-b');
    const target = stepFrom(selfPosition(mover));
    mover.client.send(frame({ tag: 'move', payload: { ...target, facing: headingFromCardinal('east'), gait: 'walk' } }));
    const { target: observed } = await listener.client.until('moves');
    expect(observed).toEqual({ tag: 'moves', payload: { moves: [{ id: mover.entityId, ...target, facing: headingFromCardinal('east'), gait: 'walk' }] } });
    // Nothing the mover received since its join is its own move echoed back, or a correction.
    const after = await drainFrames(mover.client);
    expect(after.filter((message) => message.tag === 'moves' || message.tag === 'correction')).toEqual([]);
    await mover.client.close();
    await listener.client.close();
  });

  it('a door transfer moves the player in front of the counterpart door and broadcasts leave', async () => {
    const stayer = await joinFreshPlayer(server.url, 'stay');
    const walker = await joinFreshPlayerAt(server, 'walk', { space: STARTER_SECTOR, position: libraryExit.arrival });
    walker.client.send(frame({ tag: 'useDoor', payload: { sector: STARTER_SECTOR, doorId: 'exit' } }));
    const { target: enter } = await walker.client.until('enterSpace');
    expect(enter).toMatchObject({ tag: 'enterSpace', payload: { spaceId: OUTDOOR_SPACE_ID, selfId: walker.entityId } });
    const arrival = await drainFrames(walker.client);
    expect(arrival.flatMap((message) => (message.tag === 'sector' ? [message.payload.sector.name] : []))).toContain('EdariaMitte');
    const self = arrival.find((message) => message.tag === 'entity' && message.payload.id === walker.entityId);
    expect(self).toMatchObject({ payload: { x: townhallDoor.arrival.x, z: townhallDoor.arrival.z, facing: townhallDoor.facing } });
    const { target: leave } = await stayer.client.until('leave');
    expect(leave).toEqual({ tag: 'leave', payload: { entityId: walker.entityId, leftGame: false } });
    await walker.client.close();
    await stayer.client.close();
  });

  it('a move across the room and a door used from afar are both refused', async () => {
    const cheat = await joinFreshPlayer(server.url, 'cheat');
    const spawn = selfPosition(cheat);
    // The far corner is more than the 7.5 m a full movement allowance covers, whatever stands in between.
    const corner = { x: bibliothek.size.width - SOMNIO_CONSTANTS.playerRadius, z: bibliothek.size.depth - SOMNIO_CONSTANTS.playerRadius };
    expect(distance(spawn, corner)).toBeGreaterThan(7.5);
    cheat.client.send(frame({ tag: 'move', payload: { ...corner, facing: 0, gait: 'run' } }));
    cheat.client.send(frame({ tag: 'useDoor', payload: { sector: STARTER_SECTOR, doorId: 'exit' } }));
    const answers = await drainFrames(cheat.client);
    expect(answers).toEqual([
      { tag: 'correction', payload: spawn },
      { tag: 'doorRefused', payload: { sector: STARTER_SECTOR, doorId: 'exit' } },
    ]);
    expect(library().snapshotForPlayer(cheat.entityId)?.character.position).toEqual(spawn);
    await cheat.client.close();
  });

  it('an NPC greets the player who comes within speaking distance, answers their talk with its next line, and says none to one who asks from afar', async () => {
    const libus = bibliothek.npcs.find((npc) => npc.id === 'libus')!;
    const beside = standableNear(library(), libus, SOMNIO_CONSTANTS.npcInteractionRadius);
    const talker = await joinFreshPlayerAt(server, 'talker', { space: STARTER_SECTOR, position: beside });
    const line = (step: number) => ({
      tag: 'serverSay',
      payload: { entityId: LIBUS, text: dialogLine(dialogSteps(libus.dialogScript)[step]!, talker.nickname) },
    });
    expect((await talker.client.until('serverSay')).target).toEqual(line(0));
    const afar = await joinFreshPlayer(server.url, 'afar');
    expect(distance(selfPosition(afar), libus)).toBeGreaterThan(SOMNIO_CONSTANTS.npcInteractionRadius);
    afar.client.send(frame({ tag: 'talk', payload: { npcId: LIBUS } }));
    // The drain is answered behind the `talk`, so the one from afar is handled before the one from beside.
    expect(await drainFrames(afar.client)).toEqual([]);
    talker.client.send(frame({ tag: 'talk', payload: { npcId: LIBUS } }));
    expect((await talker.client.until('serverSay')).target).toEqual(line(1));
    // A line reaches everyone in the library, so this is all Libus has said since the `talk` from afar.
    expect(await drainFrames(afar.client)).toEqual([line(1)]);
    await talker.client.close();
    await afar.client.close();
  });

  it('graceful shutdown drains in-flight frames before closing connections', async () => {
    const local = await startDatabase();
    const own = await bootTestServer(local.url);
    try {
      const nickname = uniqueNickname('drainer');
      const client = await TestClient.open(own.url);
      await client.next();
      client.send(registerFrame(nickname));
      await client.until('registerResult');
      client.send(frame({ tag: 'login', payload: { nickname, password: 'secret-pass' } }));
      await client.until('lucidity');
      const characters = new PostgresCharacterRepository(local.db);
      const beforeShutdown = (await characters.findByName(nickname))!.lastSeen;
      const shutdown = own.server.shutdown();
      const closed = await client.closed;
      await shutdown;
      expect([CLOSE_GOING_AWAY, 1000]).toContain(closed.code);
      // The drain's snapshot landed: the shutdown checkpoint advanced the row, not only the close.
      const afterShutdown = (await characters.findByName(nickname))!.lastSeen;
      expect(afterShutdown.getTime()).toBeGreaterThan(beforeShutdown.getTime());
    } finally {
      own.logging.cleanup();
      await local.stop();
    }
  });

  it('a login requesting a session token can resume without a password', async () => {
    const nickname = uniqueNickname('resumer');
    const client = await TestClient.open(server.url);
    await client.next();
    client.send(registerFrame(nickname));
    await client.until('registerResult');
    await client.close();
    const first = await loginOverWire(server.url, nickname, { requestSessionToken: true });
    const token = first.join.find((message) => message.tag === 'sessionToken');
    expect(token?.tag).toBe('sessionToken');
    await closeAndAwaitCleanup(first, server);
    const second = await TestClient.open(server.url);
    await second.next();
    if (token?.tag === 'sessionToken') second.send(frame({ tag: 'redeemSession', payload: { token: token.payload.token } }));
    expect(await second.next()).toEqual({ tag: 'loginResult', payload: { result: 'ok' } });
    await second.close();
  });
});
