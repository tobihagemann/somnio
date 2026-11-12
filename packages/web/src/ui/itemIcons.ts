import type { BaseItemId } from '@somnio/core';
import { element } from './dom';

/**
 * Each item's icon, by its base: a coloured picture of its own model on a transparent ground, which
 * the asset pipeline renders into the pack's `UI/Items/`, where `Scripts/bundle-web-assets.sh` names
 * each one. No rarity is drawn in it: the part that holds it draws the rarity's edge.
 */
export const ITEM_ICONS: Record<BaseItemId, string> = {
  dagger: '/assets/UI/Items/dagger.png',
  cudgel: '/assets/UI/Items/cudgel.png',
  sword: '/assets/UI/Items/sword.png',
  mace: '/assets/UI/Items/mace.png',
  buckler: '/assets/UI/Items/buckler.png',
  shield: '/assets/UI/Items/shield.png',
  moonstone: '/assets/UI/Items/moonstone.png',
  wand: '/assets/UI/Items/wand.png',
  'bone-dagger': '/assets/UI/Items/bone-dagger.png',
  sabre: '/assets/UI/Items/sabre.png',
  'war-axe': '/assets/UI/Items/war-axe.png',
  'iron-buckler': '/assets/UI/Items/iron-buckler.png',
  'skull-shield': '/assets/UI/Items/skull-shield.png',
  'skull-staff': '/assets/UI/Items/skull-staff.png',
  cap: '/assets/UI/Items/cap.png',
  tunic: '/assets/UI/Items/tunic.png',
  gloves: '/assets/UI/Items/gloves.png',
  trousers: '/assets/UI/Items/trousers.png',
  boots: '/assets/UI/Items/boots.png',
  amulet: '/assets/UI/Items/amulet.png',
  ring: '/assets/UI/Items/ring.png',
};

/** An item's icon as an element, decorative by construction: the accessible name lives on the control. */
export function itemIcon(baseId: BaseItemId): HTMLImageElement {
  return element('img', { className: 'hud-item-icon', attributes: { src: ITEM_ICONS[baseId], alt: '', draggable: 'false' } });
}
