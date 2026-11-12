import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppShell, element } from '@/ui';
import { installDebugAPI, makeDebugAPI } from '@/debugApi';
import { ClientWorld } from '@/client';
import { TEST_REGISTRY, outdoorSector } from '../../core/test/support/worldFixture.ts';
import { carrying, inventoryFrame, item } from './helpers/inventory';
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
    vi.restoreAllMocks();
  });

  function shell(): AppShell {
    return new AppShell({
      container,
      capabilities: { hasWebGL: true },
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
    expect(api.walk()).toBeUndefined();
    expect(api.groundScreenPoint(0, 0)).toBeUndefined();
  });

  it("reports the local player once the entity stream has placed it, what a dreamer holds, and an elite's rank and trait", () => {
    const app = shell();
    app.controller.selfId = 'self';
    app.controller.entities.set('self', clientEntity({ position: { x: 12.8, z: 9.6 }, facing: 90, held: { mainHand: 'sword', offHand: 'moonstone' } }));
    app.controller.entities.set('npc:EdariaSquare/libus', clientEntity({ id: 'npc:EdariaSquare/libus', kind: 'npc', name: 'Libus', position: { x: 3, z: 4 } }));
    app.controller.entities.set('monster:1', clientEntity({ id: 'monster:1', kind: 'monster', name: 'Ghost', position: { x: 6, z: 7 } }));
    app.controller.entities.set(
      'monster:2',
      clientEntity({ id: 'monster:2', kind: 'monster', name: 'Ghost', position: { x: 8, z: 7 }, rank: 'elite', trait: 'shielded' }),
    );

    const api = makeDebugAPI(app);
    expect(api.player()).toEqual({ x: 12.8, z: 9.6, facing: 90, gait: 'jog', name: 'Tester' });
    expect(api.entities()).toEqual([
      { id: 'self', kind: 'player', name: 'Tester', x: 12.8, z: 9.6, condition: 'hale', held: { mainHand: 'sword', offHand: 'moonstone' } },
      { id: 'npc:EdariaSquare/libus', kind: 'npc', name: 'Libus', x: 3, z: 4, condition: 'hale' },
      { id: 'monster:1', kind: 'monster', name: 'Ghost', x: 6, z: 7, condition: 'hale' },
      { id: 'monster:2', kind: 'monster', name: 'Ghost', x: 8, z: 7, condition: 'hale', rank: 'elite', trait: 'shielded' },
    ]);
  });

  it("reports the player's own pools, lucidity, inventory, winded state, and open service panel", () => {
    const app = shell();
    const energy = { healthCurrent: 40, healthMax: 100, balanceCurrent: 0, balanceMax: 100, spiritCurrent: 70, spiritMax: 110 };
    const lucidity = { role: 'healer' as const, ranks: [{ teachingId: 'touch', rank: 1, practice: 2.5 }], study: 'touch' };
    app.controller.dispatch({ tag: 'enterSpace', payload: { spaceId: 'outdoors', selfId: 'self', people: 'vigils', worldSeconds: 0 } });
    app.controller.dispatch({ tag: 'energy', payload: energy });
    app.controller.dispatch({ tag: 'lucidity', payload: lucidity });
    const inventory = inventoryFrame(carrying({ coins: 12, worn: [item('moonstone')], bag: [item('cap')] }));
    app.controller.dispatch(inventory);
    app.session.servicePanel = clientEntity({ id: 'npc:EdariaHealerHall/sana', kind: 'npc', service: 'healerMaster' });

    const api = makeDebugAPI(app);
    expect(api.energy()).toEqual(energy);
    expect(api.lucidity()).toEqual(lucidity);
    expect(api.inventory()).toEqual(inventory.payload);
    expect(api.winded()).toBe(true);
    expect(api.servicePanel()).toBe('npc:EdariaHealerHall/sana');
    // No scene draws anything in this shell, so there is nowhere to point.
    expect(api.screenPoint('bren')).toBeUndefined();
  });

  it('reports the quests as the last frame said, and the quest marker of each carrier in view', () => {
    const app = shell();
    app.controller.dispatch({ tag: 'enterSpace', payload: { spaceId: 'outdoors', selfId: 'self', people: 'vigils', worldSeconds: 0 } });
    const world = new ClientWorld('outdoors', TEST_REGISTRY);
    world.addSector(
      outdoorSector(
        'Meadow',
        { x: 0, z: 0 },
        {
          placements: [{ id: 'notice-board-1', modelId: 'box', x: 16, z: 10, yaw: 0, elevation: 0 }],
          fixtures: [{ id: 'fixture-1', placement: 'notice-board-1', service: 'bountyBoard' }],
        },
      ),
    );
    app.controller.world = world;
    app.controller.entities.set('npc:EdariaLibrary/libus', clientEntity({ id: 'npc:EdariaLibrary/libus', kind: 'npc', name: 'Libus' }));
    const bounty = { day: 3, land: 'Meadow', monsterKind: 'ghost', objective: 'driveOff' as const, count: 4, reward: { coins: 20, gear: 1 } };
    const quests = { active: [{ questId: 'restless-graves', progress: [2] }], done: ['fighter-trial'], bounties: [bounty] };
    app.controller.dispatch({ tag: 'quests', payload: quests });

    const api = makeDebugAPI(app);
    expect(api.quests()).toEqual(quests);
    // Sana and Tacita offer their trials too, but stand out of view; no scene draws anything in this shell.
    expect(api.questMarkers()).toEqual([
      { carrierId: 'npc:EdariaLibrary/libus', marker: 'offer', screen: undefined },
      { carrierId: 'fixture:Meadow/fixture-1', marker: 'offer', screen: undefined },
    ]);
    // Before the player's body is placed the HUD shows nothing, the tracker included.
    expect(api.questTracker()).toEqual({
      shown: false,
      listShown: true,
      folded: false,
      quests: [{ questId: 'restless-graves', title: 'Restless graves', lines: ['Drive off 4 Skeletons in the Graveyard: 2/4'] }],
    });

    // A quest taken on is said over the world, and a quest done waits its turn behind it while the tracker lists it first.
    app.controller.dispatch({ tag: 'quests', payload: { ...quests, active: [{ questId: 'newcomer-errand', progress: [0, 0] }, ...quests.active] } });
    app.controller.dispatch({
      tag: 'quests',
      payload: {
        ...quests,
        active: [
          { questId: 'newcomer-errand', progress: [0, 0] },
          { questId: 'restless-graves', progress: [4] },
        ],
      },
    });
    expect(container.querySelector('.hud-quest-banner')?.textContent).toBe(
      "Quest acceptedA newcomer's errandVisit Mercus in his shop.Read the bounty board on the square.",
    );
    expect(api.questTracker().quests).toEqual([
      { questId: 'restless-graves', title: 'Restless graves', lines: [], returnTo: 'Return to Memor.' },
      { questId: 'newcomer-errand', title: "A newcomer's errand", lines: ['Visit Mercus in his shop: 0/1', 'Read the bounty board on the square: 0/1'] },
    ]);
  });

  it('reports the target, its vitals, the gaze lock, Run, and slot 1 with its action', () => {
    const app = shell();
    app.controller.dispatch({ tag: 'enterSpace', payload: { spaceId: 'outdoors', selfId: 'self', people: 'vigils', worldSeconds: 0 } });
    app.controller.entities.set('monster:1', clientEntity({ id: 'monster:1', kind: 'monster', name: 'Ghost' }));
    const api = makeDebugAPI(app);
    expect(api.target()).toBeUndefined();
    expect(api.gazeLocked()).toBe(false);
    expect(api.engaged()).toBe(false);
    expect(api.engageAction()).toBeUndefined();
    expect(api.running()).toBe(false);

    app.session.select('monster:1');
    app.session.gazeLocked = true;
    app.controller.dispatch({ tag: 'vitals', payload: { entityId: 'monster:1', health: 0.75 } });
    app.session.toggleEngage();
    app.session.toggleRun();

    expect(api.target()).toBe('monster:1');
    expect(api.vitals('monster:1')).toBe(0.75);
    expect(api.gazeLocked()).toBe(true);
    expect(api.engaged()).toBe(true);
    expect(api.engageAction()).toBe('attack');
    expect(api.running()).toBe(true);
  });

  it("reports the belt's abilities with the cooldown each waits on, and the effects of the player and the target in seconds", () => {
    const app = shell();
    app.controller.dispatch({ tag: 'enterSpace', payload: { spaceId: 'outdoors', selfId: 'self', people: 'vigils', worldSeconds: 0 } });
    app.controller.entities.set('self', clientEntity());
    app.controller.entities.set('monster:1', clientEntity({ id: 'monster:1', kind: 'monster', name: 'Ghost', position: { x: 12, z: 30 } }));
    const energy = { healthCurrent: 100, healthMax: 100, balanceCurrent: 100, balanceMax: 100, spiritCurrent: 100, spiritMax: 100 };
    const ranks = [
      { teachingId: 'brace', rank: 1, practice: 0 },
      { teachingId: 'lunge', rank: 1, practice: 0 },
    ];
    app.controller.dispatch({ tag: 'energy', payload: energy });
    app.controller.dispatch({ tag: 'lucidity', payload: { role: 'fighter', ranks } });
    app.controller.dispatch({ tag: 'cooldowns', payload: { globalSeconds: 0, cooldowns: [{ abilityId: 'brace', seconds: 9 }] } });
    app.session.select('monster:1');
    app.controller.dispatch({ tag: 'effects', payload: { entityId: 'self', effects: [{ effectId: 'braced', seconds: 4 }] } });
    app.controller.dispatch({ tag: 'effects', payload: { entityId: 'monster:1', effects: [{ effectId: 'challenged' }] } });
    const api = makeDebugAPI(app);

    // The nightmare stands too far off to leap to.
    const [brace, lunge] = api.abilities();
    expect([brace!.abilityId, brace!.usable, lunge]).toEqual(['brace', true, { abilityId: 'lunge', usable: false, cooldownSeconds: 0 }]);
    expect(brace!.cooldownSeconds).toBeCloseTo(9, 0);
    const [braced] = api.effects('self');
    expect(braced!.effectId).toBe('braced');
    expect(braced!.seconds).toBeCloseTo(4, 0);
    expect(api.effects('monster:1')).toEqual([{ effectId: 'challenged' }]);
  });

  it('reports a channel under way with the seconds it has left, until it lands', () => {
    // The page's clock stands still, so the seconds left are exact however slowly the test runs.
    vi.spyOn(performance, 'now').mockReturnValue(1000);
    const app = shell();
    app.controller.dispatch({ tag: 'enterSpace', payload: { spaceId: 'outdoors', selfId: 'self', people: 'vigils', worldSeconds: 0 } });
    app.controller.entities.set('self', clientEntity());
    const api = makeDebugAPI(app);
    expect(api.channel('self')).toBeUndefined();
    app.controller.dispatch({ tag: 'ability', payload: { entityId: 'self', abilityId: 'deep-mend', phase: 'start', seconds: 1.5 } });
    const channel = api.channel('self');
    expect(channel?.abilityId).toBe('deep-mend');
    expect(channel?.seconds).toBe(1.5);
    app.controller.dispatch({ tag: 'ability', payload: { entityId: 'self', abilityId: 'deep-mend', phase: 'done' } });
    expect(api.channel('self')).toBeUndefined();
  });

  it('reports a raise under way with its Healers and the seconds it has left, until it ends', () => {
    vi.spyOn(performance, 'now').mockReturnValue(1000);
    const app = shell();
    app.controller.dispatch({ tag: 'enterSpace', payload: { spaceId: 'outdoors', selfId: 'self', people: 'vigils', worldSeconds: 0 } });
    app.controller.entities.set('self', clientEntity({ condition: 'fallen' }));
    app.controller.entities.set('healer', clientEntity({ id: 'healer', kind: 'peer', name: 'Lumi' }));
    const api = makeDebugAPI(app);
    expect(api.raise('self')).toBeUndefined();
    app.controller.dispatch({ tag: 'raising', payload: { targetId: 'self', healerIds: ['healer'], state: 'holding', progress: 0.5, seconds: 3 } });
    const raise = api.raise('self');
    expect(raise?.healerNames).toEqual(['Lumi']);
    expect(raise?.seconds).toBe(3);
    app.controller.dispatch({ tag: 'raising', payload: { targetId: 'self', healerIds: ['healer'], state: 'done', progress: 1, seconds: 0 } });
    expect(api.raise('self')).toBeUndefined();
  });

  it('reports where each fallen dreamer lies, as the server last told a Mystic who senses them', () => {
    const app = shell();
    app.controller.dispatch({ tag: 'enterSpace', payload: { spaceId: 'outdoors', selfId: 'self', people: 'vigils', worldSeconds: 0 } });
    const api = makeDebugAPI(app);
    expect(api.sensed()).toEqual([]);
    app.controller.dispatch({ tag: 'sensed', payload: { bearings: [{ name: 'Mira', x: 30, z: 10 }] } });
    expect(api.sensed()).toEqual([{ name: 'Mira', x: 30, z: 10 }]);
  });

  it('reports a telegraph in view with the seconds left before it strikes, until it strikes or its caster is driven off or leaves view', () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(1000);
    const app = shell();
    app.controller.dispatch({ tag: 'enterSpace', payload: { spaceId: 'outdoors', selfId: 'self', people: 'vigils', worldSeconds: 0 } });
    const boss = clientEntity({ id: 'monster:1', kind: 'monster', name: 'Necromancer', rank: 'boss' });
    app.controller.entities.set('monster:1', boss);
    const api = makeDebugAPI(app);
    const wail = { id: 'telegraph-1', casterId: 'monster:1', kind: 'wail', x: 10, z: 10, radius: 4 } as const;
    expect(api.telegraphs()).toEqual([]);
    app.controller.dispatch({ tag: 'telegraph', payload: { ...wail, seconds: 2.5 } });
    now.mockReturnValue(2000);
    expect(api.telegraphs()).toEqual([{ ...wail, seconds: 1.5 }]);
    now.mockReturnValue(3500);
    expect(api.telegraphs()).toEqual([]);

    app.controller.dispatch({ tag: 'telegraph', payload: { ...wail, id: 'telegraph-2', seconds: 2.5 } });
    app.controller.entities.set('monster:1', { ...boss, condition: 'fallen' });
    expect(api.telegraphs()).toEqual([]);
    app.controller.entities.set('monster:1', boss);
    app.controller.dispatch({ tag: 'leave', payload: { entityId: 'monster:1', leftGame: false } });
    app.controller.entities.set('monster:1', boss);
    expect(api.telegraphs()).toEqual([]);
  });

  it("reports where the Character window draws the player's body and how far it is turned, and nothing while it is not shown", () => {
    const app = shell();
    const api = makeDebugAPI(app);
    expect(api.characterBody()).toBeUndefined();
    vi.spyOn(app.hud.portraits.body, 'getBoundingClientRect').mockReturnValue(new DOMRect(964, 182, 256, 172));
    expect(api.characterBody()).toEqual({ left: 964, top: 182, width: 256, height: 172, turnDegrees: expect.any(Number) });
  });

  it('reports the gaze lock as a left press on a nightmare takes it and the lock toggle lets go of it', () => {
    const app = shell();
    app.controller.dispatch({ tag: 'enterSpace', payload: { spaceId: 'outdoors', selfId: 'self', people: 'vigils', worldSeconds: 0 } });
    app.controller.entities.set('self', clientEntity());
    app.controller.entities.set('monster:1', clientEntity({ id: 'monster:1', kind: 'monster', name: 'Ghost', position: { x: 12, z: 10 } }));
    app.controller.presentedOverlay = undefined;
    const api = makeDebugAPI(app);

    app.session.pressEntity('monster:1');
    expect([api.target(), api.gazeLocked()]).toEqual(['monster:1', true]);
    app.session.toggleGazeLock();
    expect([api.target(), api.gazeLocked()]).toEqual(['monster:1', false]);
  });

  it('reports the walk under way as plain points', () => {
    const app = shell();
    const api = makeDebugAPI(app);

    app.session.predictor.walkTo({ x: 4, z: 5 });
    expect(api.walk()).toEqual({ kind: 'path', destination: { x: 4, z: 5 }, waypoints: [] });

    app.session.predictor.steerToward({ x: 6, z: 7 });
    expect(api.walk()).toEqual({ kind: 'steer', toward: { x: 6, z: 7 } });
  });

  it('reports the space, and the sector the predicted position stands in', () => {
    const app = shell();
    const world = new ClientWorld('outdoors', TEST_REGISTRY);
    world.addSector(outdoorSector('EdariaSquare', { x: 0, z: 0 }));
    world.addSector(outdoorSector('NorthMeadow', { x: 0, z: -20 }));
    app.controller.world = world;
    const api = makeDebugAPI(app);

    expect(api.spaceId()).toBe('outdoors');
    expect(api.sectorName()).toBeUndefined();

    world.follow({ x: 10, z: -5 }, app.controller.renderSurface);
    expect(api.sectorName()).toBe('NorthMeadow');
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
