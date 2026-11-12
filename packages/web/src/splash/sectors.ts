import { npcEntityId, readSectorFile } from '@somnio/core';
import type { Sector } from '@somnio/core';
import autumnWood from '@somnio/core/fixtures/sectors/AutumnWood.somnio-sector?raw';
import edariaArena from '@somnio/core/fixtures/sectors/EdariaArena.somnio-sector?raw';
import edariaFighterHall from '@somnio/core/fixtures/sectors/EdariaFighterHall.somnio-sector?raw';
import edariaHealerHall from '@somnio/core/fixtures/sectors/EdariaHealerHall.somnio-sector?raw';
import edariaInn from '@somnio/core/fixtures/sectors/EdariaInn.somnio-sector?raw';
import edariaLibrary from '@somnio/core/fixtures/sectors/EdariaLibrary.somnio-sector?raw';
import edariaMysticTower from '@somnio/core/fixtures/sectors/EdariaMysticTower.somnio-sector?raw';
import edariaShop from '@somnio/core/fixtures/sectors/EdariaShop.somnio-sector?raw';
import edariaSquare from '@somnio/core/fixtures/sectors/EdariaSquare.somnio-sector?raw';
import graveyard from '@somnio/core/fixtures/sectors/Graveyard.somnio-sector?raw';
import graveyardBurialChamber from '@somnio/core/fixtures/sectors/GraveyardBurialChamber.somnio-sector?raw';
import graveyardCrypt from '@somnio/core/fixtures/sectors/GraveyardCrypt.somnio-sector?raw';
import northMeadow from '@somnio/core/fixtures/sectors/NorthMeadow.somnio-sector?raw';
import northWood from '@somnio/core/fixtures/sectors/NorthWood.somnio-sector?raw';
import southMeadow from '@somnio/core/fixtures/sectors/SouthMeadow.somnio-sector?raw';
import westMeadow from '@somnio/core/fixtures/sectors/WestMeadow.somnio-sector?raw';

/** The committed world the server ships, compiled into the bundle so the splash can stage it with no server. */
const SECTOR_FILES: Record<string, string> = {
  AutumnWood: autumnWood,
  EdariaArena: edariaArena,
  EdariaFighterHall: edariaFighterHall,
  EdariaHealerHall: edariaHealerHall,
  EdariaInn: edariaInn,
  EdariaLibrary: edariaLibrary,
  EdariaMysticTower: edariaMysticTower,
  EdariaShop: edariaShop,
  EdariaSquare: edariaSquare,
  Graveyard: graveyard,
  GraveyardBurialChamber: graveyardBurialChamber,
  GraveyardCrypt: graveyardCrypt,
  NorthMeadow: northMeadow,
  NorthWood: northWood,
  SouthMeadow: southMeadow,
  WestMeadow: westMeadow,
};

export function splashSectors(): Sector[] {
  return Object.entries(SECTOR_FILES).map(([name, text]) => readSectorFile(text, name));
}

let npcNames: ReadonlyMap<string, string> | undefined;

/** The name of each NPC of the committed world, by its entity id, for one the player has not seen. */
export function committedNPCNames(): ReadonlyMap<string, string> {
  npcNames ??= new Map(splashSectors().flatMap((sector) => sector.npcs.map((npc) => [npcEntityId(sector.name, npc.id), npc.name] as const)));
  return npcNames;
}
