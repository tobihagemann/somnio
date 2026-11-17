import { placeNameIn, t } from '@/i18n';

/** The name the clock shows for a sector, in the player's language. */
export function placeName(sector: string): string {
  return placeNameIn(sector, t);
}
