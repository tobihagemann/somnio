import { ROLES } from '@somnio/protocol';
import type { Role } from '@somnio/protocol';
import registryJSON from '../data/ModelRegistry.json' with { type: 'json' };
import { rectsOverlap } from './geometry.ts';
import type { Rect, Size } from './geometry.ts';
import { BASE_ITEMS, SET_TIERS, TIERS, isBaseItemId, isBraceletSlot, isSetTier, isTier, isWardrobeBase, slotsFor } from './items.ts';
import type { BaseItemId, BraceletSlot, EquipSlot, Tier } from './items.ts';
import { isRole } from './lucidity.ts';
import { isMonsterKindId } from './monsterKinds.ts';
import type { MonsterKindId } from './monsterKinds.ts';
import { PEOPLES, isPeople } from './people.ts';
import type { People } from './people.ts';

/**
 * The model registry: character model ids to character model stems (each with its clip-presence
 * contract), each people to the body its dreamers are drawn in, the items a dreamer holds to the
 * stems drawn in their hands, the items that can drop and the trophies nightmares leave to the stems
 * drawn lying on the ground, armour and jewellery by tier and role line to the stems they lie and are worn as, and
 * semantic object ids to prop stems with their collision geometry. It references only filename
 * stems, so one file describes the pack for the browser, the editor, the server's collision, and
 * the asset pipeline's gates.
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

/** The kinds of flame a prop carries, which the client lights each by its own values. */
export const LIGHT_KINDS = ['candle', 'hearth', 'lamp', 'torch'] as const;
export type LightKind = (typeof LIGHT_KINDS)[number];

/** Where a prop's flame burns, in model space, `y` above the model's ground. */
export interface PropLight {
  x: number;
  y: number;
  z: number;
  kind: LightKind;
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
  /** The flame the model carries, which lights a room it stands in; every placement of the model carries it. */
  light?: PropLight;
}

/** The static model an item of the base `id` is drawn as. */
export interface ItemModelRule {
  id: BaseItemId;
  stem: string;
}

/** The static model the trophy of the nightmare kind `id` lies on the ground as. */
export interface TrophyModelRule {
  id: MonsterKindId;
  stem: string;
}

/** The regions of a dreamer's body, each a mesh of the body a worn piece hides while it covers it. */
export const BODY_REGIONS = ['BootL', 'BootR', 'Crown', 'Face', 'HandL', 'HandR', 'SleeveL', 'SleeveR', 'ThighL', 'ThighR', 'Torso'] as const;
export type BodyRegion = (typeof BODY_REGIONS)[number];

/** The body a people's dreamers are drawn in: a character model, at a scale per axis. */
export interface PeopleRule {
  people: People;
  model: string;
  scale: readonly [number, number, number];
}

/** The stems a piece is worn as: one for each wrist for a bracelet, else one fitted to a people, else one for every people. */
export interface WornStems {
  default?: string;
  peoples?: Partial<Record<People, string>>;
  wrists?: Readonly<Record<BraceletSlot, string>>;
}

/** What an armour or jewellery item of `base` rolled at `tier`, in `line` or the neutral design without one, draws: lying on the ground, and worn. */
export interface WardrobeRow {
  base: BaseItemId;
  tier: Tier;
  /** The role whose set the design is a piece of, absent for the neutral design. */
  line?: Role;
  ground: string;
  /** The body regions the piece hides while it is worn. */
  covers: BodyRegion[];
  /** The morph target of the body's hair the piece tucks, on a body that carries it. */
  hairFit?: string;
  wear: WornStems;
}

export interface ModelRegistry {
  characterModels: CharacterModelRule[];
  /** The body each people's dreamers are drawn in, one per people. */
  peoples: PeopleRule[];
  /** What a hand holding an item draws: a model in the frame of the hand's `handslot` bone, its grip at the origin, hung there at identity. */
  handModels: ItemModelRule[];
  /** What a drop of an item draws: a model lying on the ground, its ground bounds centred on the origin, at the size a dreamer holds or wears it. */
  groundModels: ItemModelRule[];
  /** What a trophy draws, lying on the ground as a drop of an item does. */
  trophyModels: TrophyModelRule[];
  /** What armour and jewellery draw, one neutral row per base and tier and one per base and role at each of `SET_TIERS`. Each base's neutral tier-1 ground stem is its `groundModels` stem too. */
  wardrobe: WardrobeRow[];
  objectModels: ObjectModelRule[];
}

/** Empty registry: every lookup resolves `undefined`, so the loader renders placeholders. */
export const PLACEHOLDER_REGISTRY: ModelRegistry = {
  characterModels: [],
  peoples: [],
  handModels: [],
  groundModels: [],
  trophyModels: [],
  wardrobe: [],
  objectModels: [],
};

/**
 * Validates the structural invariants the JSON shape cannot express: non-empty stems and ids, no
 * duplicate ids, characters expecting at least one clip, one body of a character model for every
 * people, at a positive scale on every axis, hand and ground models of known items, trophy models of
 * known nightmare kinds, a wardrobe that is absent, empty, or whole, whose every piece resolves and
 * whose tier-1 drops are the ground models, positive sizes, cardinal door facings, walk surfaces of
 * one model that do not overlap, and lights of a known kind not below the ground.
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

  const peoples = parsePeoples(root['peoples'], characterModels);
  const handModels = parseStemRules(root['handModels'], 'registry.handModels', isBaseItemId, 'item');
  const groundModels = parseStemRules(root['groundModels'], 'registry.groundModels', isBaseItemId, 'item');
  const trophyModels = parseStemRules(root['trophyModels'], 'registry.trophyModels', isMonsterKindId, 'nightmare kind');
  const wardrobe = parseWardrobe(root['wardrobe'], groundModels);

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
      ...(record['light'] === undefined ? {} : { light: parsePropLight(record['light'], `${path}.light`) }),
    };
  });
  requireUniqueIds(
    objectModels.map((rule) => rule.id),
    'registry.objectModels',
  );

  return { characterModels, peoples, handModels, groundModels, trophyModels, wardrobe, objectModels };
}

export function modelForCharacter(registry: ModelRegistry, id: string): ModelEntry | undefined {
  return registry.characterModels.find((rule) => rule.id === id)?.model;
}

/** The stem a hand holding an item of `baseId` draws, or `undefined` for an item no hand shows. */
export function handModelStem(registry: ModelRegistry, baseId: string): string | undefined {
  return registry.handModels.find((rule) => rule.id === baseId)?.stem;
}

/** The stem a drop of an item of `baseId` lies on the ground as, or `undefined` for an item with no ground model. */
export function groundModelStem(registry: ModelRegistry, baseId: string): string | undefined {
  return registry.groundModels.find((rule) => rule.id === baseId)?.stem;
}

/** The character model the dreamers of `people` are drawn in, or `undefined` for a people with no body. */
export function peopleBody(registry: ModelRegistry, people: string): string | undefined {
  return registry.peoples.find((rule) => rule.people === people)?.model;
}

/** The scale per axis the body of `people` is drawn at, or `undefined` for a people with no body. */
export function peopleScale(registry: ModelRegistry, people: string): readonly [number, number, number] | undefined {
  return registry.peoples.find((rule) => rule.people === people)?.scale;
}

/** What an item of `baseId` rolled at `tier` in `line`, or neutral without one, draws, or `undefined` for an item that is no armour or jewellery. */
export function wardrobeRow(registry: ModelRegistry, baseId: string, tier: number, line?: Role): WardrobeRow | undefined {
  return registry.wardrobe.find((row) => row.base === baseId && row.tier === tier && row.line === line);
}

/** The stem the piece is worn as by a dreamer of `people` in `slot`: the wrist's for a bracelet slot, else the people's fit, else the one for every people. */
export function wornStem(row: WardrobeRow, people: People, slot: EquipSlot): string | undefined {
  if (isBraceletSlot(slot)) return row.wear.wrists?.[slot];
  return row.wear.peoples?.[people] ?? row.wear.default;
}

/** The stem the trophy of `monsterKind` lies on the ground as, or `undefined` for a kind whose trophy has no model. */
export function trophyModelStem(registry: ModelRegistry, monsterKind: string): string | undefined {
  return registry.trophyModels.find((rule) => rule.id === monsterKind)?.stem;
}

export function objectModel(registry: ModelRegistry, id: string): ObjectModelRule | undefined {
  return registry.objectModels.find((rule) => rule.id === id);
}

export function modelForObjectId(registry: ModelRegistry, id: string): ModelEntry | undefined {
  return objectModel(registry, id)?.model;
}

/**
 * Every entry, character models first, then object models, then hand, ground, wardrobe ground, and
 * trophy models, dropping duplicate stems. A hand, ground, or trophy model expects no clip. A worn
 * piece is no entry: it loads when a dreamer first wears it.
 */
export function allModelEntries(registry: ModelRegistry): ModelEntry[] {
  const entries = [
    ...registry.characterModels.map((rule) => rule.model),
    ...registry.objectModels.map((rule) => rule.model),
    ...[
      ...registry.handModels.map((rule) => rule.stem),
      ...registry.groundModels.map((rule) => rule.stem),
      ...registry.wardrobe.map((row) => row.ground),
      ...registry.trophyModels.map((rule) => rule.stem),
    ].map((stem) => ({ stem, expectedClips: [] })),
  ];
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

/** A table of static models by known id. Absent, nothing shows there. */
function parseStemRules<Id extends string>(raw: unknown, path: string, isKnown: (id: string) => id is Id, noun: string): { id: Id; stem: string }[] {
  if (raw === undefined) return [];
  const rules = requireArray(raw, path).map((element, index) => {
    const rulePath = `${path}[${index}]`;
    const record = requireRecord(element, rulePath);
    const id = requireNonEmptyString(record['id'], `${rulePath}.id`);
    if (!isKnown(id)) throw new ModelRegistryError(`${rulePath}.id: no ${noun} "${id}"`);
    return { id, stem: requireNonEmptyString(record['stem'], `${rulePath}.stem`) };
  });
  requireUniqueIds(
    rules.map((rule) => rule.id),
    path,
  );
  return rules;
}

function parsePeoples(raw: unknown, characterModels: readonly CharacterModelRule[]): PeopleRule[] {
  const peoples = requireArray(raw, 'registry.peoples').map((element, index) => {
    const path = `registry.peoples[${index}]`;
    const record = requireRecord(element, path);
    const people = requireNonEmptyString(record['people'], `${path}.people`);
    if (!isPeople(people)) throw new ModelRegistryError(`${path}.people: no people "${people}"`);
    const model = requireNonEmptyString(record['model'], `${path}.model`);
    if (!characterModels.some((rule) => rule.id === model)) throw new ModelRegistryError(`${path}.model: no character model "${model}"`);
    return { people, model, scale: parseScale(record['scale'], `${path}.scale`) };
  });
  requireUniqueIds(
    peoples.map((rule) => rule.people),
    'registry.peoples',
  );
  const missing = PEOPLES.find((people) => !peoples.some((rule) => rule.people === people));
  if (missing !== undefined) throw new ModelRegistryError(`registry.peoples: no body for "${missing}"`);
  return peoples;
}

function parseScale(raw: unknown, path: string): [number, number, number] {
  const axes = requireArray(raw, path);
  if (axes.length !== 3) throw new ModelRegistryError(`${path}: expected three axes`);
  return [requirePositiveNumber(axes[0], `${path}[0]`), requirePositiveNumber(axes[1], `${path}[1]`), requirePositiveNumber(axes[2], `${path}[2]`)];
}

const WARDROBE_BASES = (Object.keys(BASE_ITEMS) as BaseItemId[]).filter(isWardrobeBase);

/**
 * The wardrobe: none when absent or empty, else a neutral row for every armour and jewellery base at
 * every tier and a row for every base in each role's line at each of `SET_TIERS`, each piece resolving
 * for every people in every slot its base fits, and each base's neutral tier-1 drop its ground model,
 * the stem the asset pipeline's gates read it by.
 */
function parseWardrobe(raw: unknown, groundModels: readonly ItemModelRule[]): WardrobeRow[] {
  if (raw === undefined) return [];
  const rows = requireArray(raw, 'registry.wardrobe').map((element, index) => parseWardrobeRow(element, `registry.wardrobe[${index}]`));
  if (rows.length === 0) return rows;
  for (const base of WARDROBE_BASES) {
    for (const tier of TIERS) requireOneWardrobeRow(rows, base, tier, undefined);
    for (const tier of SET_TIERS) {
      for (const role of ROLES) requireOneWardrobeRow(rows, base, tier, role);
    }
    const ground = rows.find((row) => row.base === base && row.tier === 1 && row.line === undefined)!.ground;
    const alias = groundModels.find((rule) => rule.id === base)?.stem;
    if (alias !== ground) throw new ModelRegistryError(`registry.groundModels: ${base} must lie as its tier-1 wardrobe row, "${ground}"`);
  }
  return rows;
}

function requireOneWardrobeRow(rows: readonly WardrobeRow[], base: BaseItemId, tier: Tier, line: Role | undefined): void {
  const count = rows.filter((row) => row.base === base && row.tier === tier && row.line === line).length;
  const design = line === undefined ? base : `${line} ${base}`;
  if (count === 0) throw new ModelRegistryError(`registry.wardrobe: no row for ${design} at tier ${tier}`);
  if (count > 1) throw new ModelRegistryError(`registry.wardrobe: duplicate row for ${design} at tier ${tier}`);
}

function parseWardrobeRow(raw: unknown, path: string): WardrobeRow {
  const record = requireRecord(raw, path);
  const base = requireNonEmptyString(record['base'], `${path}.base`);
  if (!isBaseItemId(base) || !isWardrobeBase(base)) throw new ModelRegistryError(`${path}.base: no armour or jewellery "${base}"`);
  const tier = requireNumber(record['tier'], `${path}.tier`);
  if (!isTier(tier)) throw new ModelRegistryError(`${path}.tier: expected a tier from 1 to 5`);
  const line = record['line'] === undefined ? undefined : requireNonEmptyString(record['line'], `${path}.line`);
  if (line !== undefined && !isRole(line)) throw new ModelRegistryError(`${path}.line: no role "${line}"`);
  if (line !== undefined && !isSetTier(tier)) throw new ModelRegistryError(`${path}.line: no set piece is made at tier ${tier}`);
  const covers = requireArray(record['covers'], `${path}.covers`).map((region, index) => {
    if (!BODY_REGIONS.includes(region as BodyRegion)) throw new ModelRegistryError(`${path}.covers[${index}]: no body region "${String(region)}"`);
    return region as BodyRegion;
  });
  const wear = parseWornStems(record['wear'], `${path}.wear`);
  const wornPerWrist = wear.wrists !== undefined;
  if (BASE_ITEMS[base].slot === 'bracelet') {
    if (!wornPerWrist || wear.default !== undefined || wear.peoples !== undefined) {
      throw new ModelRegistryError(`${path}.wear: a bracelet is worn as a piece for each wrist alone`);
    }
  } else if (wornPerWrist) {
    throw new ModelRegistryError(`${path}.wear: only a bracelet is worn per wrist`);
  }
  const row: WardrobeRow = {
    base,
    tier,
    ...(line === undefined ? {} : { line }),
    ground: requireNonEmptyString(record['ground'], `${path}.ground`),
    covers,
    ...(record['hairFit'] === undefined ? {} : { hairFit: requireNonEmptyString(record['hairFit'], `${path}.hairFit`) }),
    wear,
  };
  for (const slot of slotsFor(base)) {
    for (const people of PEOPLES) {
      if (wornStem(row, people, slot) === undefined) throw new ModelRegistryError(`${path}.wear: no piece for ${people} in ${slot}`);
    }
  }
  return row;
}

function parseWornStems(raw: unknown, path: string): WornStems {
  const record = requireRecord(raw, path);
  const wear: WornStems = {};
  if (record['default'] !== undefined) wear.default = requireNonEmptyString(record['default'], `${path}.default`);
  if (record['peoples'] !== undefined) {
    const fits = requireRecord(record['peoples'], `${path}.peoples`);
    wear.peoples = {};
    for (const [people, stem] of Object.entries(fits)) {
      if (!isPeople(people)) throw new ModelRegistryError(`${path}.peoples: no people "${people}"`);
      wear.peoples[people] = requireNonEmptyString(stem, `${path}.peoples.${people}`);
    }
  }
  if (record['wrists'] !== undefined) {
    const wrists = requireRecord(record['wrists'], `${path}.wrists`);
    wear.wrists = {
      bracelet1: requireNonEmptyString(wrists['bracelet1'], `${path}.wrists.bracelet1`),
      bracelet2: requireNonEmptyString(wrists['bracelet2'], `${path}.wrists.bracelet2`),
    };
  }
  return wear;
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

function parsePropLight(raw: unknown, path: string): PropLight {
  const record = requireRecord(raw, path);
  const kind = record['kind'];
  if (!LIGHT_KINDS.includes(kind as LightKind)) {
    throw new ModelRegistryError(`${path}.kind: expected one of ${LIGHT_KINDS.join(', ')}`);
  }
  const y = requireNumber(record['y'], `${path}.y`);
  if (y < 0) throw new ModelRegistryError(`${path}.y: expected a number not below the ground`);
  return { x: requireNumber(record['x'], `${path}.x`), y, z: requireNumber(record['z'], `${path}.z`), kind: kind as LightKind };
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
