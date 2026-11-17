import { BOUNTY_LABEL_KEY } from '@somnio/core';

export type Lookup = (key: string, ...args: string[]) => string;

/**
 * The name each committed sector goes by, in the lookup's locale. A sector this table does not know
 * yet, freshly authored, goes by its file name split into words.
 */
const PLACE_NAMES: Record<string, (lookup: Lookup) => string> = {
  AutumnWood: (lookup) => lookup('Autumn Wood'),
  EdariaArena: (lookup) => lookup('Arena'),
  EdariaFighterHall: (lookup) => lookup('Fighter Hall'),
  EdariaHealerHall: (lookup) => lookup('Healer Hall'),
  EdariaInn: (lookup) => lookup('Inn'),
  EdariaLibrary: (lookup) => lookup('Library'),
  EdariaMysticTower: (lookup) => lookup('Mystic Tower'),
  EdariaShop: (lookup) => lookup('Shop'),
  EdariaSquare: (lookup) => lookup('Edaria Square'),
  Graveyard: (lookup) => lookup('Graveyard'),
  GraveyardBurialChamber: (lookup) => lookup('Burial Chamber'),
  GraveyardCrypt: (lookup) => lookup('Crypt'),
  NorthMeadow: (lookup) => lookup('North Meadow'),
  NorthWood: (lookup) => lookup('North Wood'),
  SouthMeadow: (lookup) => lookup('South Meadow'),
  WestMeadow: (lookup) => lookup('West Meadow'),
};

export function placeNameIn(sector: string, lookup: Lookup): string {
  return Object.hasOwn(PLACE_NAMES, sector) ? PLACE_NAMES[sector]!(lookup) : sector.replace(/(?<=[a-z0-9])(?=[A-Z])/g, ' ');
}

/** A bounty's title in the lookup's locale, naming the land it is set in. */
export function bountyTitleIn(land: string, lookup: Lookup): string {
  return lookup(BOUNTY_LABEL_KEY, placeNameIn(land, lookup));
}

/** The sectors the table names. */
export const NAMED_PLACES: readonly string[] = Object.keys(PLACE_NAMES);
