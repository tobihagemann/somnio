import { isWardrobeBase } from '@somnio/core';
import type { BaseItemId, Tier, WardrobeBaseId } from '@somnio/core';
import type { Role } from '@somnio/protocol';
import { element } from './dom';

/**
 * Each item's icon: a coloured picture of its own model on a transparent ground, which the asset
 * pipeline renders into the pack's `UI/Items/`, where `Scripts/bundle-web-assets.sh` names each one.
 * No rarity is drawn in it: the part that holds it draws the rarity's edge. A weapon, a shield, or a
 * focus has one picture for its base, armour and jewellery one for its design at each tier, and a set
 * piece one for its line's design.
 */
export const ITEM_ICONS: Record<Exclude<BaseItemId, WardrobeBaseId>, string> = {
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
};

export const WARDROBE_ICONS: Record<WardrobeBaseId, Record<Tier, string>> = {
  cap: {
    1: '/assets/UI/Items/cap.png',
    2: '/assets/UI/Items/cap-t2.png',
    3: '/assets/UI/Items/cap-t3.png',
    4: '/assets/UI/Items/cap-t4.png',
    5: '/assets/UI/Items/cap-t5.png',
  },
  shoulders: {
    1: '/assets/UI/Items/shoulders.png',
    2: '/assets/UI/Items/shoulders-t2.png',
    3: '/assets/UI/Items/shoulders-t3.png',
    4: '/assets/UI/Items/shoulders-t4.png',
    5: '/assets/UI/Items/shoulders-t5.png',
  },
  tunic: {
    1: '/assets/UI/Items/tunic.png',
    2: '/assets/UI/Items/tunic-t2.png',
    3: '/assets/UI/Items/tunic-t3.png',
    4: '/assets/UI/Items/tunic-t4.png',
    5: '/assets/UI/Items/tunic-t5.png',
  },
  gloves: {
    1: '/assets/UI/Items/gloves.png',
    2: '/assets/UI/Items/gloves-t2.png',
    3: '/assets/UI/Items/gloves-t3.png',
    4: '/assets/UI/Items/gloves-t4.png',
    5: '/assets/UI/Items/gloves-t5.png',
  },
  trousers: {
    1: '/assets/UI/Items/trousers.png',
    2: '/assets/UI/Items/trousers-t2.png',
    3: '/assets/UI/Items/trousers-t3.png',
    4: '/assets/UI/Items/trousers-t4.png',
    5: '/assets/UI/Items/trousers-t5.png',
  },
  boots: {
    1: '/assets/UI/Items/boots.png',
    2: '/assets/UI/Items/boots-t2.png',
    3: '/assets/UI/Items/boots-t3.png',
    4: '/assets/UI/Items/boots-t4.png',
    5: '/assets/UI/Items/boots-t5.png',
  },
  amulet: {
    1: '/assets/UI/Items/amulet.png',
    2: '/assets/UI/Items/amulet-t2.png',
    3: '/assets/UI/Items/amulet-t3.png',
    4: '/assets/UI/Items/amulet-t4.png',
    5: '/assets/UI/Items/amulet-t5.png',
  },
  bracelet: {
    1: '/assets/UI/Items/bracelet.png',
    2: '/assets/UI/Items/bracelet-t2.png',
    3: '/assets/UI/Items/bracelet-t3.png',
    4: '/assets/UI/Items/bracelet-t4.png',
    5: '/assets/UI/Items/bracelet-t5.png',
  },
};

/** A set piece's icon, its line's design, by base and role at each tier its designs exist at (`SET_TIERS`). */
export const WARDROBE_LINE_ICONS: Record<WardrobeBaseId, Record<Role, Partial<Record<Tier, string>>>> = {
  cap: {
    fighter: { 3: '/assets/UI/Items/cap-fighter-t3.png' },
    healer: { 3: '/assets/UI/Items/cap-healer-t3.png' },
    mystic: { 3: '/assets/UI/Items/cap-mystic-t3.png' },
  },
  shoulders: {
    fighter: { 3: '/assets/UI/Items/shoulders-fighter-t3.png' },
    healer: { 3: '/assets/UI/Items/shoulders-healer-t3.png' },
    mystic: { 3: '/assets/UI/Items/shoulders-mystic-t3.png' },
  },
  tunic: {
    fighter: { 3: '/assets/UI/Items/tunic-fighter-t3.png' },
    healer: { 3: '/assets/UI/Items/tunic-healer-t3.png' },
    mystic: { 3: '/assets/UI/Items/tunic-mystic-t3.png' },
  },
  gloves: {
    fighter: { 3: '/assets/UI/Items/gloves-fighter-t3.png' },
    healer: { 3: '/assets/UI/Items/gloves-healer-t3.png' },
    mystic: { 3: '/assets/UI/Items/gloves-mystic-t3.png' },
  },
  trousers: {
    fighter: { 3: '/assets/UI/Items/trousers-fighter-t3.png' },
    healer: { 3: '/assets/UI/Items/trousers-healer-t3.png' },
    mystic: { 3: '/assets/UI/Items/trousers-mystic-t3.png' },
  },
  boots: {
    fighter: { 3: '/assets/UI/Items/boots-fighter-t3.png' },
    healer: { 3: '/assets/UI/Items/boots-healer-t3.png' },
    mystic: { 3: '/assets/UI/Items/boots-mystic-t3.png' },
  },
  amulet: {
    fighter: { 3: '/assets/UI/Items/amulet-fighter-t3.png' },
    healer: { 3: '/assets/UI/Items/amulet-healer-t3.png' },
    mystic: { 3: '/assets/UI/Items/amulet-mystic-t3.png' },
  },
  bracelet: {
    fighter: { 3: '/assets/UI/Items/bracelet-fighter-t3.png' },
    healer: { 3: '/assets/UI/Items/bracelet-healer-t3.png' },
    mystic: { 3: '/assets/UI/Items/bracelet-mystic-t3.png' },
  },
};

/**
 * An item's icon as an element, decorative by construction: the accessible name lives on the control.
 * A line comes only at a tier of `SET_TIERS`, as `knownItem` holds every item to, and counts only on armour and jewellery.
 */
export function itemIcon(baseId: BaseItemId, tier: Tier, line: Role | undefined): HTMLImageElement {
  const src = !isWardrobeBase(baseId) ? ITEM_ICONS[baseId] : line === undefined ? WARDROBE_ICONS[baseId][tier] : WARDROBE_LINE_ICONS[baseId][line][tier]!;
  return element('img', { className: 'hud-item-icon', attributes: { src, alt: '', draggable: 'false' } });
}
