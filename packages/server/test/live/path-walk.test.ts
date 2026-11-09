import { describe, expect, it } from 'vitest';
import registryJSON from '@somnio/core/data/ModelRegistry.json' with { type: 'json' };
import {
  MOVE_SUBSTEP,
  OUTDOOR_SPACE_ID,
  SOMNIO_CONSTANTS,
  buildSpaceCollision,
  distance,
  findPath,
  gaitMetresPerSecond,
  isLegalMove,
  parseModelRegistry,
  rasterizeWalkable,
  resolveMove,
  walkRasterInputs,
} from '@somnio/core';
import type { Body, Point, SpaceCollision, WalkRaster } from '@somnio/core';
import { encodeSomnioMessage } from '@somnio/protocol';
import type { SectorView, SomnioMessage } from '@somnio/protocol';
import { loadSectorFixtures } from '../../../core/test/support/sectorFixture.ts';
import { loadWorld } from '../../src/sectors/sectorCache.ts';
import { WorldRouter } from '../../src/world/worldRouter.ts';
import { TestClient, gameplayURL, withLiveServer } from '../support/liveServer.ts';
import { testLogger } from '../support/logger.ts';
import { makeCharacter } from '../support/sectorFactory.ts';
import { makeStubConnectionDependencies } from '../support/stubDependencies.ts';
import { StubCharacterRepository, StubNPCDialogStateRepository, StubSessionRepository } from '../support/stubRepositories.ts';

/**
 * An honest client walking found paths through the committed world is never corrected. The
 * scripted client here walks as the browser's follower does. It finds a path with `findPath` over
 * the walk rasters of the sectors it was sent, round the NPCs it was shown. It runs each tick in
 * substeps through `resolveMove` and reports every 100 ms of real time. Before a substep the
 * server's `isLegalMove` would refuse from the last report, it reports where it stands.
 */

const REGISTRY = parseModelRegistry(registryJSON);
const RADIUS = SOMNIO_CONSTANTS.playerRadius;
const TICK_MS = 100;

/** A server over the committed world holding one character at `at` in `spaceId`, and a token that resumes it. */
async function committedWorld(spaceId: string, at: Point) {
  const sectors = loadSectorFixtures();
  const sessions = new StubSessionRepository();
  const accountId = crypto.randomUUID();
  const { token } = await sessions.issue(accountId, 3600);
  const characters = new StubCharacterRepository(new Map([[accountId, [makeCharacter(at, 'walker', spaceId)]]]));
  const world = loadWorld(new Map(sectors.map((sector) => [sector.name, sector])), registryJSON);
  const worldRouter = await WorldRouter.create(world, characters, new StubNPCDialogStateRepository(), testLogger());
  return { dependencies: await makeStubConnectionDependencies({ sessions, characters, worldRouter }), token };
}

/** Sends a request the server always answers and reads through to its answer: every frame the server sent before it. */
async function settle(client: TestClient): Promise<SomnioMessage[]> {
  client.send(encodeSomnioMessage({ tag: 'revokeSession', payload: { token: 'unknown' } }));
  return (await client.until('sessionRevoked')).before;
}

interface HeldSpace {
  collision: SpaceCollision;
  rasters: WalkRaster[];
  npcs: Body[];
}

/** Resumes the character and builds the space as the client holds it from the join's frames. */
async function join(client: TestClient, token: string): Promise<HeldSpace> {
  await client.next();
  client.send(encodeSomnioMessage({ tag: 'redeemSession', payload: { token } }));
  const entered = await client.until('enterSpace');
  if (entered.target.tag !== 'enterSpace') throw new Error('expected enterSpace');
  const frames = await settle(client);
  const sectors: SectorView[] = frames.flatMap((frame) => (frame.tag === 'sector' ? [frame.payload.sector] : []));
  const npcs = frames.flatMap((frame) =>
    frame.tag === 'entity' && frame.payload.kind === 'npc' ? [{ x: frame.payload.x, z: frame.payload.z, radius: frame.payload.radius }] : [],
  );
  const collision = buildSpaceCollision({ id: entered.target.payload.spaceId, sectors }, REGISTRY);
  return { collision, rasters: sectors.map((sector) => rasterizeWalkable(walkRasterInputs(collision, sector))), npcs };
}

/** Walks the path found from `from` to `to` at a run, reporting as the browser does, and answers where it ends. */
async function walkPath(client: TestClient, space: HeldSpace, from: Point, to: Point): Promise<Point> {
  const path = findPath({ collision: space.collision, rasters: space.rasters }, from, to, space.npcs, new Set());
  expect(path.reached).toBe(true);
  let position = from;
  let reported = from;
  const report = (at: Point): void => {
    client.send(encodeSomnioMessage({ tag: 'move', payload: { x: at.x, z: at.z, facing: 0, gait: 'run' } }));
    reported = at;
  };
  for (const waypoint of path.waypoints) {
    while (distance(position, waypoint) > 1e-9) {
      await new Promise((resolve) => setTimeout(resolve, TICK_MS));
      const away = distance(position, waypoint);
      const metres = Math.min(away, (gaitMetresPerSecond('run') * TICK_MS) / 1000);
      const substeps = Math.ceil(metres / MOVE_SUBSTEP);
      const leg = { x: (waypoint.x - position.x) / away, z: (waypoint.z - position.z) / away };
      for (let index = 1; index <= substeps; index += 1) {
        const target =
          index === substeps && metres === away ? waypoint : { x: position.x + (leg.x * metres) / substeps, z: position.z + (leg.z * metres) / substeps };
        const step = resolveMove(space.collision, position, target, RADIUS, space.npcs, []);
        expect(distance(step.position, target), `a substep toward (${waypoint.x}, ${waypoint.z})`).toBeLessThan(1e-9);
        if (!isLegalMove(space.collision, reported, step.position, RADIUS, space.npcs)) report(position);
        position = step.position;
      }
      report(position);
    }
  }
  return position;
}

describe('a client walking found paths over a live socket', () => {
  it.each([
    {
      name: 'round the townhall',
      space: OUTDOOR_SPACE_ID,
      npcs: 0,
      route: [
        { x: 31.5, z: 2 },
        { x: 38, z: 9.5 },
      ],
    },
    {
      name: 'round Libus in the Library and back',
      space: 'EdariaLibrary',
      npcs: 1,
      route: [
        { x: 2.7, z: 4.4 },
        { x: 6.5, z: 6 },
        { x: 2, z: 2 },
      ],
    },
  ])(
    'is never corrected walking $name',
    async ({ space: spaceId, npcs, route }) => {
      const world = await committedWorld(spaceId, route[0]!);
      await withLiveServer({ dependencies: world.dependencies }, async (server) => {
        const client = await TestClient.open(gameplayURL(server));
        const space = await join(client, world.token);
        expect(space.npcs).toHaveLength(npcs);

        let at = route[0]!;
        for (const goal of route.slice(1)) at = await walkPath(client, space, at, goal);

        expect((await settle(client)).filter((frame) => frame.tag === 'correction')).toEqual([]);
        // The control: a report the server refuses is answered, so the silence above is acceptance.
        client.send(encodeSomnioMessage({ tag: 'move', payload: { x: at.x + 30, z: at.z, facing: 0, gait: 'run' } }));
        expect((await settle(client)).filter((frame) => frame.tag === 'correction')).toEqual([{ tag: 'correction', payload: at }]);
        await client.close();
      });
    },
    20_000,
  );
});
