import { afterEach, describe, expect, it } from 'vitest';
import { setLocale } from '@/i18n';
import { SensedMarkers } from '@/ui/sensedMarkers';
import type { PlacedMarkers } from '@/scene/worldScene';

/**
 * The markers toward the fallen a Mystic senses, against `happy-dom`: where each is laid over the
 * canvas, what it is named for a screen reader, and that it keeps its elements from frame to frame.
 * Where the scene lays them out is in `scene-world.test.ts`.
 */

afterEach(() => setLocale('en'));

const CANVAS = new DOMRect(0, 0, 800, 600);

/** Mira lying east of the player at (10, 10), her marker `x` metres right of the screen's middle on a screen 8 by 6 metres. */
function placed(x = 3, at = { x: 30, z: 10 }): PlacedMarkers {
  return { halfSize: { x: 4, y: 3 }, markers: [{ name: 'Mira', at, centre: { x, y: 0 }, toward: 0 }] };
}

const shownMarkers = (markers: SensedMarkers) => [...markers.root.querySelectorAll<HTMLElement>('.hud-sensed__marker:not(.hidden)')];

describe('the sensed markers', () => {
  it('lay each marker over the canvas where the scene placed it, named by who lies fallen and which way', () => {
    setLocale('en');
    const markers = new SensedMarkers();
    markers.render(placed(), CANVAS, { x: 10, z: 10 });
    const [marker] = shownMarkers(markers);
    expect(markers.root.classList.contains('hidden')).toBe(false);
    expect(marker!.getAttribute('role')).toBe('img');
    expect(marker!.getAttribute('aria-label')).toBe('Mira lies fallen to the east');
    expect(marker!.style.transform).toBe('translate(652px, 267px)');
    expect(marker!.textContent).toBe('Mira');
  });

  it('names the direction in German', () => {
    setLocale('de');
    const markers = new SensedMarkers();
    markers.render(placed(3, { x: 10, z: -20 }), CANVAS, { x: 10, z: 10 });
    expect(shownMarkers(markers)[0]!.getAttribute('aria-label')).toBe('Mira liegt gefallen im Norden');
  });

  it('keeps a marker’s elements while it moves, and hides them when there is none to show', () => {
    const markers = new SensedMarkers();
    markers.render(placed(3), CANVAS, { x: 10, z: 10 });
    const [first] = shownMarkers(markers);
    markers.render(placed(-3), CANVAS, { x: 10, z: 10 });
    const [moved] = shownMarkers(markers);
    expect(moved).toBe(first);
    expect(moved!.style.transform).toBe('translate(52px, 267px)');

    markers.render(undefined, CANVAS, { x: 10, z: 10 });
    expect(shownMarkers(markers)).toEqual([]);
    expect(markers.root.classList.contains('hidden')).toBe(true);
    markers.render(placed(), CANVAS, { x: 10, z: 10 });
    expect(shownMarkers(markers)[0]).toBe(first);
  });
});
