import { afterEach, describe, expect, it, vi } from 'vitest';
import { bundledModelRegistry, dialogLine, dialogSteps } from '@somnio/core';
import { setLocale } from '@/i18n';
import type { Point } from '@somnio/core';
import type { ClientEntity, RaiseProgress, SpeechBubbleRequest } from '@/client';
import { SplashDirector } from '@/splash/director';
import type { SplashSurface } from '@/splash/director';
import { shotFocus } from '@/splash/reel';
import type { SplashShot, Viewport } from '@/splash/reel';
import { splashSectors } from '@/splash/sectors';

/**
 * The director against a surface that records what it is asked to draw, with small reels of the
 * test's own over the committed sectors, stepped at a fixed frame.
 */

const registry = bundledModelRegistry();
const FRAME = 0.05;
const VIEWPORT: Viewport = { width: 1440, height: 900 };

type Call = { name: keyof SplashSurface; args: unknown[]; dip: number };

/** A surface that records every call, and the dip the director stood at as it was made. */
function recordingSurface(): {
  surface: SplashSurface;
  calls: Call[];
  watch: (director: SplashDirector) => void;
  fail: (name: keyof SplashSurface, when: (call: Call) => boolean) => void;
  /** Whether the scene reports what it draws as settled; it does unless a test says otherwise. */
  scene: { settled: boolean };
} {
  const scene = { settled: true };
  const calls: Call[] = [];
  let director: SplashDirector | undefined;
  let failing: { name: keyof SplashSurface; when: (call: Call) => boolean } | undefined;
  const record =
    (name: keyof SplashSurface) =>
    (...args: unknown[]): boolean => {
      const call = { name, args, dip: director?.dipOpacity ?? 0 };
      calls.push(call);
      if (failing?.name === name && failing.when(call)) throw new Error(`${name} failed`);
      return false;
    };
  const names: (keyof SplashSurface)[] = [
    'showSplash',
    'addSector',
    'placeEntity',
    'removeEntity',
    'updatePosition',
    'updateCondition',
    'showBlow',
    'showRaising',
    'showSpeechBubble',
    'setClock',
    'frameShot',
  ];
  const surface = { ...Object.fromEntries(names.map((name) => [name, record(name)])), isSettled: () => scene.settled } as unknown as SplashSurface;
  return {
    surface,
    calls,
    scene,
    watch: (watched) => {
      director = watched;
    },
    fail: (name, when) => {
      failing = { name, when };
    },
  };
}

function directing(reel: readonly SplashShot[], reducedMotion = false) {
  const rig = recordingSurface();
  const session = { attached: false };
  const director = new SplashDirector(rig.surface, registry, () => 0, { reducedMotion, attached: () => session.attached, reel });
  rig.watch(director);
  director.setViewport(VIEWPORT.width, VIEWPORT.height);
  const step = (seconds: number): void => {
    for (let elapsed = 0; elapsed < seconds - 1e-9; elapsed += FRAME) director.update(FRAME);
  };
  const named = (name: keyof SplashSurface): Call[] => rig.calls.filter((call) => call.name === name);
  return { ...rig, director, session, step, named };
}

const WALKER = 'splash:walker';
const STROLLER = 'splash:stroller';
const NEWCOMER = 'splash:newcomer';
const WALKER_PATH: Point[] = [
  { x: 20, z: 22 },
  { x: 21, z: 22 },
];

/** Two outdoor shots and an indoor one. The walker walks on into the second shot; the stroller is left behind in the first. */
const REEL: SplashShot[] = [
  {
    id: 'first',
    space: 'outdoors',
    seconds: 6,
    hour: 10,
    camera: { kind: 'subject', subject: WALKER, side: 'left', drop: 0.4, scale: { from: 3, to: 3 }, span: 0 },
    actors: [
      { kind: 'peer', id: WALKER, name: 'Walker', at: { x: 18, z: 22 }, facing: 90, gait: 'walk', path: WALKER_PATH.slice(0, 1) },
      { kind: 'peer', id: STROLLER, name: 'Stroller', at: { x: 22, z: 24 }, facing: 0, gait: 'walk', path: [] },
    ],
    beats: [],
  },
  {
    id: 'second',
    space: 'outdoors',
    seconds: 6,
    hour: 12,
    camera: { kind: 'area', from: { point: { x: 20, z: 20 }, scale: 4 }, to: { point: { x: 21, z: 20 }, scale: 4 } },
    actors: [
      { kind: 'carried', id: WALKER, path: WALKER_PATH.slice(1) },
      { kind: 'peer', id: NEWCOMER, name: 'Newcomer', at: { x: 19, z: 24 }, facing: 0, gait: 'walk', path: [] },
    ],
    beats: [],
  },
  {
    id: 'indoors',
    space: 'EdariaInn',
    seconds: 6,
    hour: 12,
    camera: { kind: 'area', from: { point: { x: 2.5, z: 2.5 }, scale: 2 }, to: { point: { x: 2.5, z: 2.5 }, scale: 2 } },
    actors: [{ kind: 'npc', sector: 'EdariaInn', npc: 'quieta' }],
    beats: [],
  },
];

/** A dreamer who falls, then lies there while a Healer raises them. */
const RAISE_REEL: SplashShot[] = [
  {
    id: 'fall',
    space: 'outdoors',
    seconds: 6,
    hour: 13,
    camera: { kind: 'subject', subject: WALKER, side: 'left', drop: 0.4, scale: { from: 2.5, to: 2.5 }, span: 0 },
    actors: [{ kind: 'peer', id: WALKER, name: 'Walker', at: { x: 18, z: 22 }, facing: 90, gait: 'walk', path: [{ x: 19, z: 22 }] }],
    beats: [{ at: 2, kind: 'condition', id: WALKER, condition: 'fallen' }],
  },
  {
    id: 'raise',
    space: 'outdoors',
    seconds: 8,
    hour: 13,
    camera: { kind: 'subject', subject: WALKER, side: 'left', drop: 0.4, scale: { from: 2.5, to: 2.5 }, span: 0 },
    actors: [
      { kind: 'carried', id: WALKER, path: [] },
      { kind: 'peer', id: NEWCOMER, name: 'Healer', at: { x: 21, z: 23 }, facing: 270, gait: 'walk', path: [{ x: 19.6, z: 22.5 }], faces: WALKER },
    ],
    beats: [
      { at: 1.5, kind: 'raise', target: WALKER, raise: { progress: 0, seconds: 5 } },
      { at: 6.5, kind: 'condition', id: WALKER, condition: 'hale' },
      { at: 6.5, kind: 'raise', target: WALKER, raise: undefined },
    ],
  },
];

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the splash director', () => {
  it('stages the first shot on its first frame, framing its subject beside the card for the viewport', () => {
    const d = directing(REEL);
    d.director.update(FRAME);

    expect(d.calls[0]?.name).toBe('showSplash');
    expect(d.named('addSector').map((call) => (call.args[0] as { name: string }).name)).toEqual([
      'AutumnWood',
      'EdariaSquare',
      'NorthMeadow',
      'NorthWood',
      'SouthMeadow',
      'WestMeadow',
    ]);
    expect(d.named('placeEntity').map((call) => [(call.args[0] as ClientEntity).id, (call.args[0] as ClientEntity).condition])).toEqual([
      [WALKER, 'hale'],
      [STROLLER, 'hale'],
    ]);
    expect(d.named('frameShot')[0]?.args).toEqual([shotFocus({ x: 18, z: 22 }, 'left', 0.4, 3, VIEWPORT), 3]);
    expect(d.director.currentShotId).toBe('first');

    d.calls.length = 0;
    d.director.setViewport(2560, 1080);
    d.director.update(FRAME);
    const [focus] = d.named('frameShot')[0]!.args as [Point];
    expect(focus).not.toEqual(shotFocus({ x: 18, z: 22 }, 'left', 0.4, 3, VIEWPORT));
  });

  it('cuts to the next shot only at full dark, keeping the space and the figure it carries over', () => {
    const d = directing(REEL);
    d.director.update(FRAME);
    d.calls.length = 0;
    const dips: number[] = [];
    while (d.director.currentShotId === 'first') {
      d.director.update(FRAME);
      dips.push(d.director.dipOpacity);
    }
    d.step(0.3);

    expect(Math.max(...dips)).toBe(1);
    expect(d.director.dipOpacity).toBe(0);
    expect(d.named('showSplash')).toEqual([]);
    expect(d.named('addSector')).toEqual([]);
    const staging = d.calls.filter((call) => call.name === 'placeEntity' || call.name === 'removeEntity');
    expect(staging.map((call) => [call.name, call.args[0] as string | ClientEntity].map((part) => (typeof part === 'string' ? part : part.id)))).toEqual([
      ['removeEntity', STROLLER],
      ['placeEntity', NEWCOMER],
    ]);
    expect(staging.every((call) => call.dip === 1)).toBe(true);
  });

  it('holds a world staged afresh in the dark, its shot waiting, until the scene settles, then fades it in', () => {
    const d = directing(REEL);
    d.scene.settled = false;
    d.step(1);
    expect(d.director.dipOpacity).toBe(1);
    expect(d.named('updatePosition')).toEqual([]);

    d.scene.settled = true;
    d.director.update(FRAME);
    expect(d.director.dipOpacity).toBeGreaterThan(0);
    d.step(0.3);
    expect(d.director.dipOpacity).toBe(0);
    expect(d.named('updatePosition').length).toBeGreaterThan(0);
  });

  it('holds the cut to another space in the dark until the scene settles', () => {
    const d = directing(REEL);
    while (d.director.currentShotId !== 'indoors') d.director.update(FRAME);
    d.scene.settled = false;
    d.director.update(FRAME);
    d.step(1);
    expect(d.director.dipOpacity).toBe(1);

    d.scene.settled = true;
    d.step(0.3);
    expect(d.director.dipOpacity).toBe(0);
  });

  it('plays a world that never settles after three seconds in the dark', () => {
    const d = directing(REEL);
    d.scene.settled = false;
    d.step(2.9);
    expect(d.director.dipOpacity).toBe(1);
    d.step(0.4);
    expect(d.director.dipOpacity).toBe(0);
  });

  it('plays the reel from its first shot again after its last', () => {
    const d = directing(REEL);
    const seen: (string | undefined)[] = [];
    for (let frame = 0; frame < 20 / FRAME; frame += 1) {
      d.director.update(FRAME);
      if (seen.at(-1) !== d.director.currentShotId) seen.push(d.director.currentShotId);
    }
    expect(seen).toEqual(['first', 'second', 'indoors', 'first']);
  });

  it('holds the first shot with a still camera under reduced motion, its figures walking to the end of their paths', () => {
    const d = directing(REEL, true);
    const dips: number[] = [];
    for (let frame = 0; frame < 20 / FRAME; frame += 1) {
      d.director.update(FRAME);
      dips.push(d.director.dipOpacity);
      expect(d.director.currentShotId).toBe('first');
    }
    expect(Math.max(...dips)).toBe(0);
    expect(new Set(d.named('frameShot').map((call) => JSON.stringify(call.args)))).toHaveLength(1);
    expect(d.named('updatePosition').at(-1)?.args.slice(0, 2)).toEqual([WALKER, WALKER_PATH[0]]);
  });

  it('stops when a session attaches, and stages the first shot afresh only once restarted', () => {
    const d = directing(REEL);
    d.step(5.9);
    expect(d.director.dipOpacity).toBeGreaterThan(0);
    d.calls.length = 0;

    d.session.attached = true;
    d.director.update(FRAME);
    expect(d.calls).toEqual([]);
    expect(d.director.dipOpacity).toBe(0);
    expect(d.director.currentShotId).toBeUndefined();
    d.step(1);
    expect(d.calls).toEqual([]);

    d.session.attached = false;
    d.director.restart();
    d.director.update(FRAME);
    expect(d.calls[0]?.name).toBe('showSplash');
    expect(d.named('addSector')).toHaveLength(6);
    expect(d.director.currentShotId).toBe('first');
    expect(d.director.dipOpacity).toBe(0);
  });

  it('falls back to the empty splash and keeps still when staging throws, until restarted', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = directing([REEL[2]!, REEL[0]!]);
    d.director.update(FRAME);
    let sectorsAtCut = 0;
    d.fail('addSector', (call) => call.dip === 1 && (sectorsAtCut += 1) === 2);
    d.step(6.2);

    expect(error).toHaveBeenCalledTimes(1);
    expect(d.calls.at(-1)?.name).toBe('showSplash');
    expect(d.director.dipOpacity).toBe(0);
    d.calls.length = 0;
    for (let frame = 0; frame < 100; frame += 1) d.director.update(FRAME);
    expect(d.calls).toEqual([]);
    expect(error).toHaveBeenCalledTimes(1);

    d.director.restart();
    d.director.update(FRAME);
    expect(d.named('showSplash')).toHaveLength(1);
    expect(d.director.currentShotId).toBe('indoors');
  });

  /** Pugnax in his hall, greeting a dreamer as the committed sector scripts him. */
  function greeted(): SpeechBubbleRequest {
    const d = directing([
      {
        id: 'greeting',
        space: 'EdariaFighterHall',
        seconds: 6,
        hour: 12,
        camera: { kind: 'subject', subject: 'npc:EdariaFighterHall/pugnax', side: 'right', drop: 0.5, scale: { from: 2.2, to: 2.2 }, span: 0 },
        actors: [{ kind: 'npc', sector: 'EdariaFighterHall', npc: 'pugnax' }],
        beats: [{ at: 1, kind: 'greeting', npc: 'npc:EdariaFighterHall/pugnax', listener: 'Mira' }],
      },
    ]);
    d.step(1.5);
    return d.named('showSpeechBubble')[0]?.args[0] as SpeechBubbleRequest;
  }

  it("greets with the first step of the NPC's own dialog, said to the dreamer who came near", () => {
    const pugnax = splashSectors()
      .find((sector) => sector.name === 'EdariaFighterHall')!
      .npcs.find((npc) => npc.id === 'pugnax')!;
    const bubble = greeted();
    expect(bubble.entityId).toBe('npc:EdariaFighterHall/pugnax');
    expect(bubble.lines.join(' ')).toBe(dialogLine(dialogSteps(pugnax.dialogScript)[0]!, 'Mira'));
  });

  it('greets in the language the page reads in', () => {
    setLocale('de');
    try {
      expect(greeted().lines.join(' ')).toBe('Na, Mira? Halt dich gerade, wenn du mit mir sprichst.');
    } finally {
      setLocale('en');
    }
  });

  /** The scene runs the clock on by itself, so a shot set only once would drift out of daylight. */
  it('lights a shot at its hour on every frame', () => {
    const d = directing(REEL);
    d.step(2);
    expect(d.named('setClock').length).toBeGreaterThanOrEqual(2 / FRAME - 1);
    expect(new Set(d.named('setClock').map((call) => call.args[0]))).toEqual(new Set([10 * 3600]));
  });

  it('plays the shot again from its start out of the dark when the tab comes back, and never moves a fallen body', () => {
    const d = directing(RAISE_REEL);
    d.step(6 + 3);
    expect(d.director.currentShotId).toBe('raise');
    const raises = (): (RaiseProgress | undefined)[] => d.named('showRaising').map((call) => call.args[1] as RaiseProgress | undefined);
    expect(raises()).toEqual([{ progress: 0, seconds: 5 }]);

    d.director.replayShot();
    expect(d.director.dipOpacity).toBe(1);
    d.step(0.3);
    expect(d.director.dipOpacity).toBe(0);
    d.step(1.5);
    expect(raises()).toEqual([{ progress: 0, seconds: 5 }, undefined, { progress: 0, seconds: 5 }]);

    const fell = d.calls.findIndex((call) => call.name === 'updateCondition' && call.args[0] === WALKER && call.args[1] === 'fallen');
    expect(fell).toBeGreaterThan(-1);
    expect(d.calls.slice(fell).some((call) => call.name === 'updatePosition' && call.args[0] === WALKER)).toBe(false);
  });

  it("restores each figure's opening condition when it plays the shot again", () => {
    const d = directing(RAISE_REEL);
    d.step(6 + 7);
    expect(d.named('updateCondition').at(-1)?.args).toEqual([WALKER, 'hale']);
    d.calls.length = 0;

    d.director.replayShot();

    expect(d.named('updateCondition').map((call) => call.args)).toEqual([[WALKER, 'fallen']]);
  });

  it('shows the first shot without a fade under reduced motion once the scene settles', () => {
    const d = directing(REEL, true);
    d.scene.settled = false;
    d.step(1);
    expect(d.director.dipOpacity).toBe(1);

    d.scene.settled = true;
    d.director.update(FRAME);
    expect(d.director.dipOpacity).toBe(0);
  });

  it('keeps a reduced-motion world dark through a replay while it settles', () => {
    const d = directing(REEL, true);
    d.scene.settled = false;
    d.step(1);
    d.director.replayShot();
    expect(d.director.dipOpacity).toBe(1);

    d.scene.settled = true;
    d.director.update(FRAME);
    expect(d.director.dipOpacity).toBe(0);
  });

  it('plays the shot again without a dip under reduced motion', () => {
    const d = directing(REEL, true);
    d.step(3);
    d.calls.length = 0;

    d.director.replayShot();
    expect(d.named('updatePosition').map((call) => call.args.slice(0, 2))).toContainEqual([WALKER, { x: 18, z: 22 }]);
    expect(d.director.dipOpacity).toBe(0);
    d.step(1);
    expect(d.director.dipOpacity).toBe(0);
    expect(d.director.currentShotId).toBe('first');
  });

  /** A hidden tab draws no frames, so a session can attach with nothing to halt the reel before the tab returns. */
  it('leaves the scene alone when the tab comes back after a session attached', () => {
    const d = directing(REEL);
    d.step(3);
    expect(d.director.currentShotId).toBe('first');
    d.session.attached = true;
    d.calls.length = 0;

    d.director.replayShot();

    expect(d.calls).toEqual([]);
    expect(d.director.currentShotId).toBeUndefined();
  });
});
