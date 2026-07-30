import { describe, expect, it } from 'vitest'
import registryJSON from '@registry'
import {
  ModelRegistryError,
  allModelEntries,
  floorMaterialStem,
  missingClips,
  modelForEntity,
  modelForObjectID,
  parseModelRegistry,
} from '@/core/modelRegistry'

/**
 * Reads the committed `Sources/SomnioCore/Resources/ModelRegistry.json` **through the Swift
 * tree**, not a copy under `Web/`. That is the point of the cross-tree alias: one file describes
 * the pack for the native client, the editor, the conversion validator, and the browser. If this
 * suite ever starts reading a local copy, the registry has been forked and will drift silently.
 */

describe('the committed registry parses', () => {
  const registry = parseModelRegistry(registryJSON)

  it('resolves the player band', () => {
    const model = modelForEntity(registry, 'player', 0)
    expect(model?.stem).toBe('WachenKaempfer')
    expect(model?.expectedClips).toContain('Walking_A')
    expect(model?.expectedClips).toContain('Running_Strafe_Left')
  })

  it('shares the player band between the local player and peers', () => {
    expect(modelForEntity(registry, 'peer', 0)?.stem).toBe(modelForEntity(registry, 'player', 0)?.stem)
  })

  it('resolves NPC and monster bands', () => {
    expect(modelForEntity(registry, 'npc', 16)?.stem).toBe('Libus')
    expect(modelForEntity(registry, 'npc', 17)?.stem).toBe('Kraemer')
    expect(modelForEntity(registry, 'monster', 0)?.stem).toBe('Gespenst')
  })

  it('returns undefined for an unmapped figure so the loader renders a placeholder', () => {
    expect(modelForEntity(registry, 'npc', 9999)).toBeUndefined()
    expect(modelForEntity(registry, 'player', 9999)).toBeUndefined()
  })

  it('resolves object ids and floor materials', () => {
    expect(modelForObjectID(registry, 'door')?.stem).toBe('Door')
    expect(modelForObjectID(registry, 'stone-wall-corner')?.stem).toBe('StoneWallCorner')
    expect(modelForObjectID(registry, 'not-a-prop')).toBeUndefined()
    expect(floorMaterialStem(registry, 'cobble-town')).toBe('CobbleTown')
    expect(floorMaterialStem(registry, 'not-a-floor')).toBeUndefined()
  })

  it('lists every model once, entity bands before object models', () => {
    const stems = allModelEntries(registry).map((entry) => entry.stem)
    expect(new Set(stems).size).toBe(stems.length)
    expect(stems[0]).toBe('WachenKaempfer')
    // Every character stem precedes every prop stem, which is the prewarm ordering the loader
    // depends on: characters are what the first frame needs.
    const characterStems = (['player', 'npc', 'monster'] as const).flatMap((band) =>
      registry.entityBands[band].map((rule) => rule.model.stem)
    )
    const lastCharacterIndex = Math.max(...characterStems.map((stem) => stems.indexOf(stem)))
    const firstPropIndex = Math.min(...registry.objectModels.map((rule) => stems.indexOf(rule.model.stem)))
    expect(lastCharacterIndex).toBeLessThan(firstPropIndex)
  })

  it('gives every prop an empty clip contract and every character a non-empty one', () => {
    for (const rule of registry.objectModels) {
      expect(rule.model.expectedClips).toEqual([])
    }
    for (const band of ['player', 'npc', 'monster'] as const) {
      for (const rule of registry.entityBands[band]) {
        expect(rule.model.expectedClips.length).toBeGreaterThan(0)
      }
    }
  })
})

describe('structural invariants the JSON shape cannot express', () => {
  const valid = {
    entityBands: {
      player: [{ figureRanges: [{ lower: 0, upper: 15 }], model: { stem: 'A', expectedClips: ['Idle'] } }],
      npc: [],
      monster: [],
    },
    objectModels: [{ id: 'door', model: { stem: 'Door', expectedClips: [] } }],
    floorMaterials: [{ id: 'grass', stem: 'Grass' }],
  }

  it('accepts the valid shape', () => {
    expect(() => parseModelRegistry(valid)).not.toThrow()
  })

  it('rejects an inverted figure range', () => {
    const broken = structuredClone(valid)
    broken.entityBands.player[0]!.figureRanges[0] = { lower: 15, upper: 0 }
    expect(() => parseModelRegistry(broken)).toThrow(/inverted range/)
  })

  it('rejects an empty stem', () => {
    const broken = structuredClone(valid)
    broken.objectModels[0]!.model.stem = ''
    expect(() => parseModelRegistry(broken)).toThrow(/non-empty string/)
  })

  it('rejects a duplicate object id', () => {
    const broken = structuredClone(valid)
    broken.objectModels.push({ id: 'door', model: { stem: 'Other', expectedClips: [] } })
    expect(() => parseModelRegistry(broken)).toThrow(/duplicate id "door"/)
  })

  it('rejects a duplicate floor id', () => {
    const broken = structuredClone(valid)
    broken.floorMaterials.push({ id: 'grass', stem: 'Other' })
    expect(() => parseModelRegistry(broken)).toThrow(/duplicate id "grass"/)
  })

  /**
   * A character model with no expected clips means the glb-to-USDZ conversion collapsed its clip
   * library — the exact failure the clip-presence contract exists to catch.
   */
  it('rejects a character model expecting no clips', () => {
    const broken = structuredClone(valid)
    broken.entityBands.player[0]!.model.expectedClips = []
    expect(() => parseModelRegistry(broken)).toThrow(/must expect a clip/)
  })

  it('rejects a non-object root', () => {
    expect(() => parseModelRegistry([])).toThrow(ModelRegistryError)
    expect(() => parseModelRegistry(null)).toThrow(ModelRegistryError)
  })
})

describe('missingClips', () => {
  it('reports only the absent clips', () => {
    expect(missingClips(['Idle', 'Walking_A'], ['Idle'])).toEqual(['Walking_A'])
    expect(missingClips(['Idle'], ['Idle', 'Extra'])).toEqual([])
    expect(missingClips([], ['Idle'])).toEqual([])
  })
})
