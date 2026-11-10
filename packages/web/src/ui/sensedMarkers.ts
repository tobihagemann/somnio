import type { Point } from '@somnio/core';
import { compassPoint } from '@/client';
import { compassName, t } from '@/i18n';
import { SENSED_MARKER_PIXELS } from '@/scene/worldScene';
import type { PlacedMarkers } from '@/scene/worldScene';
import { HUD_ICONS, glyph } from './hudIcons';
import { element, setHidden } from './dom';
import { paintEffectColors } from './hud';

/** One marker's elements, and the name and direction it last showed, so a frame that changes neither writes no text. */
interface Marker {
  root: HTMLElement;
  arrow: HTMLElement;
  name: HTMLElement;
  label: string | undefined;
}

/**
 * The markers a Mystic who senses the fallen sees at the screen's edge, one toward each fallen
 * dreamer lying off screen, where the scene laid them out: a badge with a fallen figure, an arrow
 * round it pointing the way, and the dreamer's name. Each is named for a screen reader by who lies
 * fallen and in which direction. A marker keeps its elements from frame to frame, and only moves.
 */
export class SensedMarkers {
  readonly root: HTMLElement;
  private readonly markers: Marker[] = [];

  constructor() {
    this.root = element('div', { className: 'hud-sensed hidden', attributes: { role: 'group', 'aria-label': t('Fallen dreamers') } });
    paintEffectColors(this.root);
  }

  /** Lays the markers over the canvas at `canvas`, named by their direction from `from`, the player; `undefined` shows none. */
  render(placed: PlacedMarkers | undefined, canvas: DOMRect, from: Point | undefined): void {
    const markers = placed?.markers ?? [];
    setHidden(this.root, markers.length === 0);
    while (this.markers.length < markers.length) this.markers.push(this.marker());
    this.markers.forEach((marker, index) => {
      const shown = markers[index];
      setHidden(marker.root, shown === undefined);
      if (shown === undefined || placed === undefined) return;
      const left = canvas.left + ((shown.centre.x / placed.halfSize.x + 1) / 2) * canvas.width - SENSED_MARKER_PIXELS.width / 2;
      const top = canvas.top + ((1 - shown.centre.y / placed.halfSize.y) / 2) * canvas.height - SENSED_MARKER_PIXELS.height / 2;
      marker.root.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
      marker.arrow.style.transform = `rotate(${(-shown.toward * 180) / Math.PI}deg)`;
      const direction = from === undefined ? undefined : compassPoint(from, shown.at);
      const label = direction === undefined ? shown.name : t('%1$@ lies fallen to the %2$@', shown.name, compassName(direction, t));
      if (label === marker.label) return;
      marker.label = label;
      marker.name.textContent = shown.name;
      marker.root.setAttribute('aria-label', label);
    });
  }

  private marker(): Marker {
    const arrow = element('span', { className: 'hud-sensed__arrow', attributes: { 'aria-hidden': 'true' } });
    const name = element('span', { className: 'hud-sensed__name', attributes: { 'aria-hidden': 'true' } });
    const badge = element('span', { className: 'hud-sensed__badge', children: [glyph(HUD_ICONS.fallen), arrow] });
    const root = element('div', { className: 'hud-sensed__marker', attributes: { role: 'img' }, children: [badge, name] });
    root.style.width = `${SENSED_MARKER_PIXELS.width}px`;
    root.style.height = `${SENSED_MARKER_PIXELS.height}px`;
    this.root.append(root);
    return { root, arrow, name, label: undefined };
  }
}
