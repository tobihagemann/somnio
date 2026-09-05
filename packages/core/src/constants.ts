/**
 * The game's fixed numbers. The caps are not decoration: they are the shared disk/wire gate that
 * keeps a hostile or corrupt sector from driving an unbounded allocation or a quadratic anchor
 * scan.
 */
export const SOMNIO_CONSTANTS = {
  tileSize: 128,
  /** `tileSize` is exactly `4 x groundCellSize`, so a sector's pixel extent divides by 32. */
  groundCellSize: 32,

  maxSectorDimension: 1024,
  maxSectorArea: 65_536,
  maxSectorObjects: 4096,
  maxSectorCollisionMasks: 4096,
  maxSectorPortals: 4096,
  maxSectorNPCs: 4096,
  maxSectorMonsterSpawns: 4096,
  maxSectorFloorPatches: 4096,
  /**
   * Cap on the objects x collisionMasks product. The per-array caps alone still admit ~16.7M
   * pairings, and the bottom-edge anchor scan walks every pairing.
   */
  maxSectorAnchorScanPairings: 1_048_576,
  /**
   * Byte cap on a `.somnio-sector` file, checked before parsing — the count caps only fire
   * after the whole input is parsed.
   */
  maxSectorFileBytes: 16 * 1024 * 1024,

  /** Player sprite cell size; the feet collision box derives from it. */
  playerSpriteSize: { width: 32, height: 48 } as const,
  npcInteractionRadius: 64,
  monsterAggroRadius: 192,
  /** Live monsters per sector across all of its spawns combined. */
  perSectorMonsterCap: 3,
  /** Wall-clock gap between two dialog lines from one NPC. */
  npcDialogCooldownSeconds: 3.0,
  /** In-game minutes at which a `dateTick` goes out, besides the hour rollover. */
  dateTickMinutes: [12, 24, 36, 48] as const,

  speechBubbleWidthPixels: 150,
  speechBubbleFontSize: 10,
} as const;

/** The one content-count bound both untrusted sector seams (disk and wire) gate on. */
export function isWithinSectorContentBounds(counts: {
  objectCount: number;
  collisionMaskCount: number;
  portalCount: number;
  npcCount: number;
  monsterSpawnCount: number;
  floorPatchCount: number;
}): boolean {
  return (
    counts.objectCount <= SOMNIO_CONSTANTS.maxSectorObjects &&
    counts.collisionMaskCount <= SOMNIO_CONSTANTS.maxSectorCollisionMasks &&
    counts.objectCount * counts.collisionMaskCount <= SOMNIO_CONSTANTS.maxSectorAnchorScanPairings &&
    counts.portalCount <= SOMNIO_CONSTANTS.maxSectorPortals &&
    counts.npcCount <= SOMNIO_CONSTANTS.maxSectorNPCs &&
    counts.monsterSpawnCount <= SOMNIO_CONSTANTS.maxSectorMonsterSpawns &&
    counts.floorPatchCount <= SOMNIO_CONSTANTS.maxSectorFloorPatches
  );
}

/** Positive, within the per-axis cap, and within the area cap. */
export function isWithinSectorBounds(dimensions: { width: number; height: number }): boolean {
  return (
    dimensions.width > 0 &&
    dimensions.height > 0 &&
    dimensions.width <= SOMNIO_CONSTANTS.maxSectorDimension &&
    dimensions.height <= SOMNIO_CONSTANTS.maxSectorDimension &&
    dimensions.width * dimensions.height <= SOMNIO_CONSTANTS.maxSectorArea
  );
}
