import type { WorldEntityKind } from './worldEntity'

/**
 * Mirror of `Sources/SomnioCore/Assets/ModelRegistry.swift`, reading the committed
 * `Sources/SomnioCore/Resources/ModelRegistry.json` **directly** through the `@registry` alias
 * rather than a copy under `Web/`. That is the whole point: the registry references only
 * filename stems, so one file describes the pack for the native client, the editor, the
 * conversion validator, and the browser — a forked copy would drift silently.
 */

export interface BandRange {
  lower: number
  upper: number
}

export interface ModelEntry {
  stem: string
  expectedClips: string[]
}

export interface FigureModelRule {
  figureRanges: BandRange[]
  model: ModelEntry
}

export interface ObjectModelRule {
  id: string
  model: ModelEntry
}

export interface FloorMaterialRule {
  id: string
  stem: string
}

export type CharacterBand = 'player' | 'npc' | 'monster'

export interface ModelRegistry {
  entityBands: Record<CharacterBand, FigureModelRule[]>
  objectModels: ObjectModelRule[]
  floorMaterials: FloorMaterialRule[]
}

/** Empty registry: every lookup resolves `undefined`, so the loader renders placeholders. */
export const PLACEHOLDER_REGISTRY: ModelRegistry = {
  entityBands: { player: [], npc: [], monster: [] },
  objectModels: [],
  floorMaterials: [],
}

/**
 * Validates the structural invariants the JSON shape cannot express, mirroring
 * `ModelRegistryCodec.read`: non-inverted figure ranges, non-empty stems and ids, no duplicate
 * object or floor ids, and characters expecting at least one clip.
 */
export function parseModelRegistry(raw: unknown): ModelRegistry {
  const root = requireRecord(raw, 'registry')
  const bands = requireRecord(root['entityBands'], 'registry.entityBands')

  const entityBands = {
    player: parseFigureRules(bands['player'], 'registry.entityBands.player'),
    npc: parseFigureRules(bands['npc'], 'registry.entityBands.npc'),
    monster: parseFigureRules(bands['monster'], 'registry.entityBands.monster'),
  }

  const objectModels = requireArray(root['objectModels'], 'registry.objectModels').map((element, index) => {
    const path = `registry.objectModels[${index}]`
    const record = requireRecord(element, path)
    return {
      id: requireNonEmptyString(record['id'], `${path}.id`),
      model: parseModelEntry(record['model'], `${path}.model`, false),
    }
  })
  requireUniqueIds(
    objectModels.map((rule) => rule.id),
    'registry.objectModels'
  )

  const floorMaterials = requireArray(root['floorMaterials'], 'registry.floorMaterials').map(
    (element, index) => {
      const path = `registry.floorMaterials[${index}]`
      const record = requireRecord(element, path)
      return {
        id: requireNonEmptyString(record['id'], `${path}.id`),
        stem: requireNonEmptyString(record['stem'], `${path}.stem`),
      }
    }
  )
  requireUniqueIds(
    floorMaterials.map((rule) => rule.id),
    'registry.floorMaterials'
  )

  return { entityBands, objectModels, floorMaterials }
}

/** Players and peers share the player band, mirroring the native loader's kind mapping. */
export function modelForEntity(
  registry: ModelRegistry,
  kind: WorldEntityKind,
  figure: number
): ModelEntry | undefined {
  const band: CharacterBand =
    kind === 'player' || kind === 'peer' ? 'player' : kind === 'npc' ? 'npc' : 'monster'
  return registry.entityBands[band].find((rule) =>
    rule.figureRanges.some((range) => figure >= range.lower && figure <= range.upper)
  )?.model
}

export function modelForObjectID(registry: ModelRegistry, id: string): ModelEntry | undefined {
  return registry.objectModels.find((rule) => rule.id === id)?.model
}

export function floorMaterialStem(registry: ModelRegistry, id: string): string | undefined {
  return registry.floorMaterials.find((rule) => rule.id === id)?.stem
}

/** Every entry, entity bands first, dropping duplicate stems — the prewarm work list. */
export function allModelEntries(registry: ModelRegistry): ModelEntry[] {
  const bands: CharacterBand[] = ['player', 'npc', 'monster']
  const entries = [
    ...bands.flatMap((band) => registry.entityBands[band].map((rule) => rule.model)),
    ...registry.objectModels.map((rule) => rule.model),
  ]
  const seen = new Set<string>()
  const unique: typeof entries = []
  for (const entry of entries) {
    if (seen.has(entry.stem)) continue
    seen.add(entry.stem)
    unique.push(entry)
  }
  return unique
}

/** The pure half of the clip-presence gate, shared with the conversion validator. */
export function missingClips(expected: readonly string[], actual: readonly string[]): string[] {
  const present = new Set(actual)
  return expected.filter((clip) => !present.has(clip))
}

function parseFigureRules(raw: unknown, path: string): FigureModelRule[] {
  return requireArray(raw, path).map((element, index) => {
    const rulePath = `${path}[${index}]`
    const record = requireRecord(element, rulePath)
    const figureRanges = requireArray(record['figureRanges'], `${rulePath}.figureRanges`).map(
      (rangeRaw, rangeIndex) => {
        const rangePath = `${rulePath}.figureRanges[${rangeIndex}]`
        const range = requireRecord(rangeRaw, rangePath)
        const lower = requireInteger(range['lower'], `${rangePath}.lower`)
        const upper = requireInteger(range['upper'], `${rangePath}.upper`)
        if (upper < lower) {
          throw new ModelRegistryError(`${rangePath}: inverted range ${lower}...${upper}`)
        }
        return { lower, upper }
      }
    )
    return {
      figureRanges,
      // Characters must expect at least one clip: a rigged model with an empty clip list means
      // the glb-to-USDZ conversion collapsed its library, which is the failure the
      // clip-presence contract exists to catch.
      model: parseModelEntry(record['model'], `${rulePath}.model`, true),
    }
  })
}

function parseModelEntry(raw: unknown, path: string, requireClips: boolean): ModelEntry {
  const record = requireRecord(raw, path)
  const stem = requireNonEmptyString(record['stem'], `${path}.stem`)
  const expectedClips = requireArray(record['expectedClips'], `${path}.expectedClips`).map((clip, index) =>
    requireNonEmptyString(clip, `${path}.expectedClips[${index}]`)
  )
  if (requireClips && expectedClips.length === 0) {
    throw new ModelRegistryError(`${path}.expectedClips: a character model must expect a clip`)
  }
  return { stem, expectedClips }
}

export class ModelRegistryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ModelRegistryError'
  }
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ModelRegistryError(`${path}: expected an object`)
  }
  return value as Record<string, unknown>
}

function requireArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new ModelRegistryError(`${path}: expected an array`)
  return value
}

function requireNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ModelRegistryError(`${path}: expected a non-empty string`)
  }
  return value
}

function requireInteger(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ModelRegistryError(`${path}: expected an integer`)
  }
  return value
}

function requireUniqueIds(ids: readonly string[], path: string): void {
  const seen = new Set<string>()
  for (const id of ids) {
    if (seen.has(id)) throw new ModelRegistryError(`${path}: duplicate id "${id}"`)
    seen.add(id)
  }
}

/**
 * The committed registry, read straight out of the Swift tree by the build alias.
 *
 * Degrades to `PLACEHOLDER_REGISTRY` on a corrupt file rather than throwing, mirroring
 * `BundleMainModelAssets`: an unresolvable model renders a placeholder, which is a visible but
 * playable degradation, whereas a throw here would take down the whole client over one bad id.
 */
export function bundledModelRegistry(raw: unknown): ModelRegistry {
  try {
    return parseModelRegistry(raw)
  } catch (error) {
    console.error('model registry is unreadable; falling back to placeholders', error)
    return PLACEHOLDER_REGISTRY
  }
}
