import { WIRE_HAND, assertNever } from '@somnio/protocol';
import type {
  WireCollisionMask,
  WireFloorPatch,
  WireGridSize,
  WireHand,
  WireInventoryExtra,
  WireInventoryRow,
  WireLightSetting,
  WireMonsterSpawn,
  WireNPC,
  WireObject,
  WireSector,
  WireSectorPortal,
} from '@somnio/protocol';
import type { Hand, InventoryExtra, InventoryRow } from './domain/inventoryRow.ts';
import { HAND } from './domain/inventoryRow.ts';
import type { GridSize } from './geometry.ts';
import type { CollisionMask, FloorPatch, LightSetting, MonsterSpawn, Sector, SectorNPC, SectorObject, SectorPortal } from './sector.ts';
import { PORTAL_DIRECTIONS, requireSectorWithinBounds } from './sector.ts';

/**
 * Model → wire conversions, the outbound half of the sector and inventory seams. The inbound half
 * is `sectorFromWire` (`sector.ts`) and `inventoryRowFromWire`.
 *
 * The wire flattens what the model nests (`spawnOrigin` becomes `spawnX`/`spawnY`), always emits
 * `rotation` and `floorPatches` where the disk codec omits their defaults, and carries the NPC's
 * heading under `direction` as degrees.
 */

export function gridSizeToWire(size: GridSize): WireGridSize {
  return { width: size.width, height: size.height };
}

export function lightSettingToWire(light: LightSetting): WireLightSetting {
  return { indoor: light.indoor, brightness: light.brightness };
}

export function objectToWire(object: SectorObject): WireObject {
  return {
    x: object.x,
    y: object.y,
    modelID: object.modelID,
    sourceWidth: object.sourceWidth,
    sourceHeight: object.sourceHeight,
    priority: object.priority,
    rotation: object.rotation,
  };
}

export function collisionMaskToWire(mask: CollisionMask): WireCollisionMask {
  return { x: mask.x, y: mask.y, width: mask.width, height: mask.height };
}

export function floorPatchToWire(patch: FloorPatch): WireFloorPatch {
  return {
    floorMaterialID: patch.floorMaterialID,
    x: patch.x,
    y: patch.y,
    width: patch.width,
    height: patch.height,
  };
}

export function portalToWire(portal: SectorPortal): WireSectorPortal {
  return {
    x: portal.x,
    y: portal.y,
    width: portal.width,
    height: portal.height,
    targetSectorName: portal.targetSectorName,
    direction: PORTAL_DIRECTIONS[portal.direction],
  };
}

export function npcToWire(npc: SectorNPC): WireNPC {
  return {
    spawnX: npc.spawnOrigin.x,
    spawnY: npc.spawnOrigin.y,
    spawnBoxWidth: npc.spawnBoxSize.width,
    spawnBoxHeight: npc.spawnBoxSize.height,
    maskWidth: npc.maskSize.width,
    maskHeight: npc.maskSize.height,
    name: npc.name,
    figure: npc.figure,
    direction: npc.facing,
    behaviorTag: npc.behaviorTag,
    dialogScript: npc.dialogScript,
  };
}

export function monsterSpawnToWire(spawn: MonsterSpawn): WireMonsterSpawn {
  return {
    spawnX: spawn.spawnOrigin.x,
    spawnY: spawn.spawnOrigin.y,
    spawnBoxWidth: spawn.spawnBoxSize.width,
    spawnBoxHeight: spawn.spawnBoxSize.height,
    monsterWidth: spawn.spawnedMonsterSize.width,
    monsterHeight: spawn.spawnedMonsterSize.height,
    name: spawn.name,
    figure: spawn.figure,
    bounded: spawn.bounded,
    spawnHP: spawn.spawnHP,
    spawnBalance: spawn.spawnBalance,
    spawnMana: spawn.spawnMana,
    aiScriptIndex: spawn.aiScriptIndex,
  };
}

/**
 * Applies the same dimension and content-count guards as `sectorFromWire`, so a sector the
 * receiver would refuse is never put on the wire in the first place.
 */
export function sectorToWire(sector: Sector): WireSector {
  requireSectorWithinBounds(sector);
  return {
    name: sector.name,
    version: sector.version,
    dimensions: gridSizeToWire(sector.dimensions),
    floorMaterialID: sector.floorMaterialID,
    light: lightSettingToWire(sector.light),
    objects: sector.objects.map(objectToWire),
    collisionMasks: sector.collisionMasks.map(collisionMaskToWire),
    portals: sector.portals.map(portalToWire),
    npcs: sector.npcs.map(npcToWire),
    monsterSpawns: sector.monsterSpawns.map(monsterSpawnToWire),
    floorPatches: sector.floorPatches.map(floorPatchToWire),
  };
}

export function inventoryExtraToWire(extra: InventoryExtra): WireInventoryExtra {
  return { key: extra.key, value: extra.value };
}

export function inventoryRowToWire(row: InventoryRow): WireInventoryRow {
  return {
    slot: row.slot,
    category: row.category,
    itemId: row.itemId,
    extras: row.extras.map(inventoryExtraToWire),
    equippedHand: handToWire(row.equippedHand),
  };
}

export function inventoryRowFromWire(row: WireInventoryRow): InventoryRow {
  return {
    slot: row.slot,
    category: row.category,
    itemId: row.itemId,
    extras: row.extras.map((extra) => ({ key: extra.key, value: extra.value })),
    equippedHand: handFromWire(row.equippedHand),
  };
}

/**
 * Wire 0 means "no hand"; 1 and 2 shift down onto `HAND`'s left/right.
 *
 * A `switch` rather than a ternary chain, so the compiler refuses an unhandled wire value instead of
 * mapping it to `undefined` — which reads as "unequipped" and would silently hide a newly added
 * hand.
 */
export function handFromWire(wire: WireHand): Hand | undefined {
  switch (wire) {
    case WIRE_HAND.none:
      return undefined;
    case WIRE_HAND.left:
      return HAND.left;
    case WIRE_HAND.right:
      return HAND.right;
    default:
      return assertNever(wire, 'wire hand');
  }
}

export function handToWire(hand: Hand | undefined): WireHand {
  switch (hand) {
    case undefined:
      return WIRE_HAND.none;
    case HAND.left:
      return WIRE_HAND.left;
    case HAND.right:
      return WIRE_HAND.right;
    default:
      return assertNever(hand, 'hand');
  }
}
