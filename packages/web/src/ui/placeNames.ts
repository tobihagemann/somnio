import { t } from '@/i18n';

/**
 * The name the clock shows for each committed sector, in the player's language. A sector this table
 * does not know yet, freshly authored, shows its file name split into words.
 */
const PLACE_NAMES: Record<string, () => string> = {
  AutumnWood: () => t('Autumn Wood'),
  EdariaArena: () => t('Arena'),
  EdariaFighterHall: () => t('Fighter Hall'),
  EdariaHealerHall: () => t('Healer Hall'),
  EdariaInn: () => t('Inn'),
  EdariaLibrary: () => t('Library'),
  EdariaMysticTower: () => t('Mystic Tower'),
  EdariaShop: () => t('Shop'),
  EdariaSquare: () => t('Edaria Square'),
  Graveyard: () => t('Graveyard'),
  GraveyardBurialChamber: () => t('Burial Chamber'),
  GraveyardCrypt: () => t('Crypt'),
  NorthMeadow: () => t('North Meadow'),
  NorthWood: () => t('North Wood'),
  SouthMeadow: () => t('South Meadow'),
  WestMeadow: () => t('West Meadow'),
};

export function placeName(sector: string): string {
  return Object.hasOwn(PLACE_NAMES, sector) ? PLACE_NAMES[sector]!() : sector.replace(/(?<=[a-z0-9])(?=[A-Z])/g, ' ');
}

/** The sectors the table names. */
export const NAMED_PLACES: readonly string[] = Object.keys(PLACE_NAMES);
