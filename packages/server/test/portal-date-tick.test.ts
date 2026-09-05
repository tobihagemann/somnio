import { describe, expect, it } from 'vitest';
import { BOOT_DEFAULT_WORLD_CLOCK, arrivalSpawn, sectorPixelCenter } from '@somnio/core';
import type { SectorPortal, WorldClock } from '@somnio/core';
import { ConnectionActor } from '../src/connection/connectionActor.ts';
import { PORTAL_LOST, handleEnterPortal } from '../src/handlers/gameplay.ts';
import type { PortalOutcome } from '../src/handlers/gameplay.ts';
import { collectMessages, dateTicks } from './support/frames.ts';
import { makeCharacter, makePortal, makeSector } from './support/sectorFactory.ts';
import { makeStubConnectionDependencies } from './support/stubDependencies.ts';

const outbound = makePortal({ x: 0, y: 0, width: 8, height: 8 }, 'B', 'outboundTrigger');

async function world(options: { clock?: WorldClock; sourcePortals?: SectorPortal[]; destinationPortals?: SectorPortal[] } = {}) {
  const dependencies = await makeStubConnectionDependencies({
    initialClock: options.clock ?? BOOT_DEFAULT_WORLD_CLOCK,
    sectors: new Map([
      ['A', makeSector('A', { portals: options.sourcePortals ?? [outbound] })],
      ['B', makeSector('B', { portals: options.destinationPortals ?? [] })],
    ]),
  });
  const connection = new ConnectionActor(dependencies);
  const actorA = dependencies.worldRouter.sector('A')!;
  const actorB = dependencies.worldRouter.sector('B')!;
  return { dependencies, connection, actorA, actorB };
}

function attachAt(w: Awaited<ReturnType<typeof world>>, at: { x: number; y: number }) {
  const entityIndex = w.actorA.attach(makeCharacter(at, 'tester', 'A'), [], w.connection.outbox);
  w.connection.markAttached(entityIndex, 'A', crypto.randomUUID());
  return entityIndex;
}

/** Narrows a hop that must have succeeded to its outcome. */
function moved(outcome: ReturnType<typeof handleEnterPortal>): PortalOutcome {
  if (outcome === undefined || outcome === PORTAL_LOST) throw new Error(`portal hop did not move: ${String(outcome)}`);
  return outcome;
}

describe('handleEnterPortal', () => {
  it('a successful hop emits a date tick to the moving connection after the destination enterSector', async () => {
    const w = await world({ clock: { second: 0, minute: 33, hour: 7, day: 1, month: 1, year: 500 } });
    const entityIndex = attachAt(w, { x: 1, y: 1 });
    const outcome = handleEnterPortal({ portalIndex: 0 }, entityIndex, 'A', w.connection, w.dependencies);
    const messages = await collectMessages(w.connection.outbox);
    expect(dateTicks(messages)[0]).toEqual({ hour: 7, minute: 33 });
    expect(outcome).toMatchObject({ sectorName: 'B' });
    const tags = messages.map((message) => message.tag);
    expect(tags.indexOf('dateTick')).toBeGreaterThan(tags.lastIndexOf('enterSector'));
  });

  it('places the player at the destination arrival spawn', async () => {
    const w = await world({
      destinationPortals: [makePortal({ x: 0, y: 0, width: 256, height: 256 }, 'B', 'arrivalPlacement')],
    });
    const entityIndex = attachAt(w, { x: 1, y: 1 });
    const outcome = moved(handleEnterPortal({ portalIndex: 0 }, entityIndex, 'A', w.connection, w.dependencies));
    expect(outcome.sectorName).toBe('B');
    expect(w.actorB.snapshotForPlayer(outcome.entityIndex)?.character.position).toEqual(arrivalSpawn(w.actorB.staticSector));
  });

  it('places the player inside the inbound arrival portal keyed to the source', async () => {
    const inbound = makePortal({ x: 128, y: 128, width: 256, height: 256 }, 'A', 'arrivalPlacement');
    const w = await world({ destinationPortals: [inbound] });
    const entityIndex = attachAt(w, { x: 1, y: 1 });
    const outcome = moved(handleEnterPortal({ portalIndex: 0 }, entityIndex, 'A', w.connection, w.dependencies));
    const placed = w.actorB.snapshotForPlayer(outcome.entityIndex)!.character.position;
    expect(placed.x).toBeGreaterThanOrEqual(inbound.x);
    expect(placed.x).toBeLessThan(inbound.x + inbound.width);
    expect(placed.y).toBeGreaterThanOrEqual(inbound.y);
    expect(placed.y).toBeLessThan(inbound.y + inbound.height);
  });

  it('recenters an out-of-bounds carry into a sector without an arrival portal', async () => {
    const w = await world();
    const entityIndex = attachAt(w, { x: 5000, y: 5000 });
    const outcome = moved(handleEnterPortal({ portalIndex: 0 }, entityIndex, 'A', w.connection, w.dependencies));
    expect(w.actorB.snapshotForPlayer(outcome.entityIndex)?.character.position).toEqual(sectorPixelCenter(w.actorB.staticSector));
  });

  it('rejects a non-outbound-trigger direction and snaps back', async () => {
    const w = await world({
      sourcePortals: [outbound, makePortal({ x: 16, y: 16, width: 8, height: 8 }, 'B', 'arrivalPlacement')],
    });
    const entityIndex = attachAt(w, { x: 1, y: 1 });
    expect(handleEnterPortal({ portalIndex: 1 }, entityIndex, 'A', w.connection, w.dependencies)).toBeUndefined();
    expect((await collectMessages(w.connection.outbox)).map((message) => message.tag)).toContain('serverPosition');
    expect(w.actorA.snapshotForPlayer(entityIndex)?.character.currentSector).toBe('A');
  });

  it('rejects an out-of-range index and snaps back', async () => {
    const w = await world();
    const entityIndex = attachAt(w, { x: 1, y: 1 });
    expect(handleEnterPortal({ portalIndex: 5 }, entityIndex, 'A', w.connection, w.dependencies)).toBeUndefined();
    expect((await collectMessages(w.connection.outbox)).map((message) => message.tag)).toContain('serverPosition');
  });
});
