import registryJSON from '../data/ModelRegistry.json' with { type: 'json' };
import { rectsOverlap } from './geometry.ts';
import type { Rect, Size } from './geometry.ts';

/**
 * The model registry: character model ids to character model stems (each with its clip-presence
 * contract), semantic object ids to prop stems with their collision geometry, and semantic floor
 * ids to floor-texture stems. It references only filename stems, so one file describes the pack
 * for the browser, the editor, the server's collision, and the asset pipeline's gates.
 *
 * Object geometry is in model space: metres, the model's origin at its ground-footprint centre,
 * +X east and +Z south at yaw 0.
 */

export interface ModelEntry {
  stem: string;
  expectedClips: string[];
}

export interface CharacterModelRule {
  id: string;
  model: ModelEntry;
}

/** Ground a body can stand on, `height` above the floor. A stair run is one surface per tread. */
export interface WalkSurface extends Rect {
  height: number;
}

/** Where a door sits on a model's wall: the point at the middle of the opening, the heading it opens toward, and the opening's width. */
export interface DoorAnchor {
  id: string;
  x: number;
  z: number;
  /** 0, 90, 180, or 270, so the trigger in front of the door is an axis-aligned model-space rect. */
  facing: number;
  width: number;
}

export interface ObjectModelRule {
  id: string;
  model: ModelEntry;
  /** The measured ground bounds, centred on the model origin. */
  footprint: Size;
  /** The rects that block movement. The registry file may leave them out, which reads as the footprint; an empty list never blocks. */
  colliders: Rect[];
  walkSurfaces: WalkSurface[];
  doors: DoorAnchor[];
}

export interface FloorMaterialRule {
  id: string;
  stem: string;
}

export interface ModelRegistry {
  characterModels: CharacterModelRule[];
  /** The character model every player uses. */
  playerModel: string;
  objectModels: ObjectModelRule[];
  floorMaterials: FloorMaterialRule[];
}

/** Empty registry: every lookup resolves `undefined`, so the loader renders placeholders. */
export const PLACEHOLDER_REGISTRY: ModelRegistry = {
  characterModels: [],
  playerModel: '',
  objectModels: [],
  floorMaterials: [],
};

/**
 * Validates the structural invariants the JSON shape cannot express: non-empty stems and ids, no
 * duplicate ids, characters expecting at least one clip, a player model that is a character
 * model, positive sizes, cardinal door facings, and walk surfaces of one model that do not
 * overlap.
 */
export function parseModelRegistry(raw: unknown): ModelRegistry {
  const root = requireRecord(raw, 'registry');

  const characterModels = requireArray(root['characterModels'], 'registry.characterModels').map((element, index) => {
    const path = `registry.characterModels[${index}]`;
    const record = requireRecord(element, path);
    return {
      id: requireNonEmptyString(record['id'], `${path}.id`),
      // Characters must expect at least one clip: a rigged model with an empty clip list would
      // pass the pipeline's clip-presence gate vacuously, which is the failure that gate exists
      // to catch.
      model: parseModelEntry(record['model'], `${path}.model`, true),
    };
  });
  requireUniqueIds(
    characterModels.map((rule) => rule.id),
    'registry.characterModels',
  );

  const playerModel = requireNonEmptyString(root['playerModel'], 'registry.playerModel');
  if (!characterModels.some((rule) => rule.id === playerModel)) {
    throw new ModelRegistryError(`registry.playerModel: no character model "${playerModel}"`);
  }

  const objectModels = requireArray(root['objectModels'], 'registry.objectModels').map((element, index) => {
    const path = `registry.objectModels[${index}]`;
    const record = requireRecord(element, path);
    const footprint = parseSize(record['footprint'], `${path}.footprint`);
    return {
      id: requireNonEmptyString(record['id'], `${path}.id`),
      model: parseModelEntry(record['model'], `${path}.model`, false),
      footprint,
      colliders:
        record['colliders'] === undefined
          ? [{ x: -footprint.width / 2, z: -footprint.depth / 2, width: footprint.width, depth: footprint.depth }]
          : requireArray(record['colliders'], `${path}.colliders`).map((rect, rectIndex) => parseRect(rect, `${path}.colliders[${rectIndex}]`)),
      walkSurfaces: parseWalkSurfaces(record['walkSurfaces'], `${path}.walkSurfaces`),
      doors: parseDoorAnchors(record['doors'], `${path}.doors`),
    };
  });
  requireUniqueIds(
    objectModels.map((rule) => rule.id),
    'registry.objectModels',
  );

  const floorMaterials = requireArray(root['floorMaterials'], 'registry.floorMaterials').map((element, index) => {
    const path = `registry.floorMaterials[${index}]`;
    const record = requireRecord(element, path);
    return {
      id: requireNonEmptyString(record['id'], `${path}.id`),
      stem: requireNonEmptyString(record['stem'], `${path}.stem`),
    };
  });
  requireUniqueIds(
    floorMaterials.map((rule) => rule.id),
    'registry.floorMaterials',
  );

  return { characterModels, playerModel, objectModels, floorMaterials };
}

export function modelForCharacter(registry: ModelRegistry, id: string): ModelEntry | undefined {
  return registry.characterModels.find((rule) => rule.id === id)?.model;
}

export function objectModel(registry: ModelRegistry, id: string): ObjectModelRule | undefined {
  return registry.objectModels.find((rule) => rule.id === id);
}

export function modelForObjectId(registry: ModelRegistry, id: string): ModelEntry | undefined {
  return objectModel(registry, id)?.model;
}

export function floorMaterialStem(registry: ModelRegistry, id: string): string | undefined {
  return registry.floorMaterials.find((rule) => rule.id === id)?.stem;
}

/** Every entry, character models first, dropping duplicate stems. */
export function allModelEntries(registry: ModelRegistry): ModelEntry[] {
  const entries = [...registry.characterModels.map((rule) => rule.model), ...registry.objectModels.map((rule) => rule.model)];
  const seen = new Set<string>();
  const unique: typeof entries = [];
  for (const entry of entries) {
    if (seen.has(entry.stem)) continue;
    seen.add(entry.stem);
    unique.push(entry);
  }
  return unique;
}

/** The clips `expected` names that `actual` lacks. */
export function missingClips(expected: readonly string[], actual: readonly string[]): string[] {
  const present = new Set(actual);
  return expected.filter((clip) => !present.has(clip));
}

function parseSize(raw: unknown, path: string): Size {
  const record = requireRecord(raw, path);
  return {
    width: requirePositiveNumber(record['width'], `${path}.width`),
    depth: requirePositiveNumber(record['depth'], `${path}.depth`),
  };
}

function parseRect(raw: unknown, path: string): Rect {
  const record = requireRecord(raw, path);
  return {
    x: requireNumber(record['x'], `${path}.x`),
    z: requireNumber(record['z'], `${path}.z`),
    ...parseSize(raw, path),
  };
}

/**
 * Overlapping surfaces of one model are rejected: steps cut into a plinth would otherwise resolve
 * to the plinth's height.
 */
function parseWalkSurfaces(raw: unknown, path: string): WalkSurface[] {
  if (raw === undefined) return [];
  const surfaces = requireArray(raw, path).map((element, index) => {
    const surfacePath = `${path}[${index}]`;
    return {
      ...parseRect(element, surfacePath),
      height: requirePositiveNumber(requireRecord(element, surfacePath)['height'], `${surfacePath}.height`),
    };
  });
  surfaces.forEach((surface, index) => {
    const other = surfaces.findIndex((candidate, candidateIndex) => candidateIndex < index && rectsOverlap(candidate, surface));
    if (other !== -1) throw new ModelRegistryError(`${path}[${index}]: overlaps ${path}[${other}]`);
  });
  return surfaces;
}

function parseDoorAnchors(raw: unknown, path: string): DoorAnchor[] {
  if (raw === undefined) return [];
  const doors = requireArray(raw, path).map((element, index) => {
    const doorPath = `${path}[${index}]`;
    const record = requireRecord(element, doorPath);
    const facing = requireNumber(record['facing'], `${doorPath}.facing`);
    if (![0, 90, 180, 270].includes(facing)) {
      throw new ModelRegistryError(`${doorPath}.facing: expected 0, 90, 180, or 270`);
    }
    return {
      id: requireNonEmptyString(record['id'], `${doorPath}.id`),
      x: requireNumber(record['x'], `${doorPath}.x`),
      z: requireNumber(record['z'], `${doorPath}.z`),
      facing,
      width: requirePositiveNumber(record['width'], `${doorPath}.width`),
    };
  });
  requireUniqueIds(
    doors.map((door) => door.id),
    path,
  );
  return doors;
}

function parseModelEntry(raw: unknown, path: string, requireClips: boolean): ModelEntry {
  const record = requireRecord(raw, path);
  const stem = requireNonEmptyString(record['stem'], `${path}.stem`);
  const expectedClips = requireArray(record['expectedClips'], `${path}.expectedClips`).map((clip, index) =>
    requireNonEmptyString(clip, `${path}.expectedClips[${index}]`),
  );
  if (requireClips && expectedClips.length === 0) {
    throw new ModelRegistryError(`${path}.expectedClips: a character model must expect a clip`);
  }
  return { stem, expectedClips };
}

export class ModelRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelRegistryError';
  }
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ModelRegistryError(`${path}: expected an object`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new ModelRegistryError(`${path}: expected an array`);
  return value;
}

function requireNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ModelRegistryError(`${path}: expected a non-empty string`);
  }
  return value;
}

function requireNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ModelRegistryError(`${path}: expected a number`);
  }
  return value;
}

function requirePositiveNumber(value: unknown, path: string): number {
  const number = requireNumber(value, path);
  if (number <= 0) throw new ModelRegistryError(`${path}: expected a positive number`);
  return number;
}

function requireUniqueIds(ids: readonly string[], path: string): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) throw new ModelRegistryError(`${path}: duplicate id "${id}"`);
    seen.add(id);
  }
}

/**
 * The committed registry.
 *
 * Degrades to `PLACEHOLDER_REGISTRY` on a corrupt file rather than throwing: an unresolvable model
 * renders a placeholder, which is a visible but playable degradation, whereas a throw here would
 * take down the whole client over one bad id.
 */
export function bundledModelRegistry(): ModelRegistry {
  try {
    return parseModelRegistry(registryJSON);
  } catch (error) {
    console.error('model registry is unreadable; falling back to placeholders', error);
    return PLACEHOLDER_REGISTRY;
  }
}
