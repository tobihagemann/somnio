import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppShell, element } from '@/ui';
import { installDebugAPI, makeDebugAPI } from '@/debugApi';
import { ClientWorld } from '@/client';
import { TEST_REGISTRY, outdoorSector } from '../../core/test/support/worldFixture.ts';
import { clientEntity } from './helpers/worldFixture';

/**
 * The `window.somnio` introspection surface.
 *
 * It exists because a WebGL canvas is opaque to a DOM-driving agent: the panels and the chat input
 * are snapshot-able, but the character's position, the sector it stands in, and whether a model resolved
 * are not. These assertions pin the shape agent recipes depend on, and the gating that keeps it off
 * a production page nobody asked to debug.
 */

describe('the debug API', () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = element('div');
    document.body.append(container);
  });

  afterEach(() => {
    container.remove();
    delete (window as unknown as Record<string, unknown>).somnio;
  });

  function shell(): AppShell {
    return new AppShell({
      container,
      capabilities: { hasWebGL: true, isDesktop: true },
      startRendering: false,
    });
  }

  it('reports a disconnected session without throwing', () => {
    const api = makeDebugAPI(shell());

    expect(api.connectionState()).toBe('disconnected');
    expect(api.player()).toBeUndefined();
    expect(api.spaceId()).toBeUndefined();
    expect(api.sectorName()).toBeUndefined();
    expect(api.entities()).toEqual([]);
    expect(api.chatHistory()).toEqual([]);
  });

  it('reports the local player once the entity stream has placed it', () => {
    const app = shell();
    app.controller.selfId = 'self';
    app.controller.entities.set('self', clientEntity({ position: { x: 12.8, z: 9.6 }, facing: 90 }));
    app.controller.entities.set('npc:EdariaMitte/libus', clientEntity({ id: 'npc:EdariaMitte/libus', kind: 'npc', name: 'Libus', position: { x: 3, z: 4 } }));

    const api = makeDebugAPI(app);
    expect(api.player()).toEqual({ x: 12.8, z: 9.6, facing: 90, gait: 'jog', name: 'Tester' });
    expect(api.entities()).toEqual([
      { id: 'self', kind: 'player', name: 'Tester', x: 12.8, z: 9.6 },
      { id: 'npc:EdariaMitte/libus', kind: 'npc', name: 'Libus', x: 3, z: 4 },
    ]);
  });

  it('reports the space, and the sector the predicted position stands in', () => {
    const app = shell();
    const world = new ClientWorld('outdoors', TEST_REGISTRY);
    world.addSector(outdoorSector('EdariaMitte', { x: 0, z: 0 }));
    world.addSector(outdoorSector('Nordwiese', { x: 0, z: -20 }));
    app.controller.world = world;
    const api = makeDebugAPI(app);

    expect(api.spaceId()).toBe('outdoors');
    expect(api.sectorName()).toBeUndefined();

    world.follow({ x: 10, z: -5 }, app.controller.renderSurface);
    expect(api.sectorName()).toBe('Nordwiese');
  });

  it('returns chat lines already localized, as the panel renders them', () => {
    const app = shell();
    app.controller.appendChat({ kind: 'joined', playerName: 'Peer' });

    // An agent asserting on a chat line has to see the same text a player would, not a tag name.
    expect(makeDebugAPI(app).chatHistory()).toEqual(['Peer entered the game.']);
  });

  it('installs unconditionally in a dev build', () => {
    expect(installDebugAPI(shell(), { isDevelopment: true, search: '' })).toBe(true);
    expect((window as unknown as Record<string, unknown>).somnio).toBeDefined();
  });

  it('stays off a production page that did not ask for it', () => {
    // `entities()` reports every peer's name and position, which is more than the
    // rendered view gives away — so it is opt-in rather than always present.
    expect(installDebugAPI(shell(), { isDevelopment: false, search: '' })).toBe(false);
    expect((window as unknown as Record<string, unknown>).somnio).toBeUndefined();
  });

  it('installs in production when explicitly requested', () => {
    expect(installDebugAPI(shell(), { isDevelopment: false, search: '?debug=1' })).toBe(true);
  });
});
