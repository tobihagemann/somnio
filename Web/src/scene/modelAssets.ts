import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js'
import {
  allModelEntries,
  floorMaterialStem,
  missingClips,
  modelForEntity,
  modelForObjectID,
} from '@/core/modelRegistry'
import type { ModelRegistry } from '@/core/modelRegistry'
import type { WorldEntityKind } from '@/core/worldEntity'

/**
 * Model-pack accessor, mirroring `BundleMainModelAssets`.
 *
 * The same structural constraint as the native loader applies for the same reason: loading is
 * async but the render surface is driven synchronously, so everything is warmed in `prewarm()`
 * and the per-request accessors are synchronous cache reads. A stem the prewarm has not cached
 * resolves `undefined` (a placeholder), never blocking and never throwing.
 *
 * Assets are `.glb` here rather than `.usdz`: the pipeline emits GLB *upstream* of the USDZ
 * conversion, so the browser consumes an earlier artifact of the same run rather than a new one.
 */
export interface ModelAssets {
  prewarm(): Promise<void>
  entity(kind: WorldEntityKind, figure: number): THREE.Object3D | undefined
  object(id: string): THREE.Object3D | undefined
  floorTexture(id: string): THREE.Texture | undefined
  clipsFor(root: THREE.Object3D): THREE.AnimationClip[]
}

interface Prototype {
  scene: THREE.Object3D
  clips: THREE.AnimationClip[]
}

export class HttpModelAssets implements ModelAssets {
  private readonly registry: ModelRegistry
  private readonly baseURL: string
  private readonly loader = new GLTFLoader()
  private readonly textureLoader = new THREE.TextureLoader()
  private readonly prototypes = new Map<string, Prototype>()
  private readonly textures = new Map<string, THREE.Texture>()
  /** Negative cache: a stem whose fetch already failed is not retried on the next prewarm. */
  private readonly misses = new Set<string>()
  private readonly clipsByRoot = new WeakMap<THREE.Object3D, THREE.AnimationClip[]>()

  constructor(registry: ModelRegistry, baseURL = '/assets') {
    this.registry = registry
    this.baseURL = baseURL.replace(/\/$/, '')
  }

  async prewarm(): Promise<void> {
    await Promise.all([
      ...allModelEntries(this.registry)
        .filter((entry) => !this.prototypes.has(entry.stem) && !this.misses.has(entry.stem))
        .map((entry) => this.loadPrototype(entry.stem, entry.expectedClips)),
      ...this.registry.floorMaterials
        .filter((rule) => !this.textures.has(rule.stem) && !this.misses.has(rule.stem))
        .map((rule) => this.loadFloorTexture(rule.stem)),
    ])
  }

  entity(kind: WorldEntityKind, figure: number): THREE.Object3D | undefined {
    const entry = modelForEntity(this.registry, kind, figure)
    return entry === undefined ? undefined : this.instantiate(entry.stem)
  }

  object(id: string): THREE.Object3D | undefined {
    const entry = modelForObjectID(this.registry, id)
    return entry === undefined ? undefined : this.instantiate(entry.stem)
  }

  floorTexture(id: string): THREE.Texture | undefined {
    const stem = floorMaterialStem(this.registry, id)
    return stem === undefined ? undefined : this.textures.get(stem)
  }

  clipsFor(root: THREE.Object3D): THREE.AnimationClip[] {
    return this.clipsByRoot.get(root) ?? []
  }

  /**
   * `SkeletonUtils.clone`, **not** `Object3D.clone`.
   *
   * A plain clone copies the mesh nodes but leaves every copy pointing at the prototype's
   * `Skeleton` and its bone objects. Two entities sharing one skeleton means the second one's
   * animation drives the first, so a room of peers all pose identically to whoever moved last.
   */
  private instantiate(stem: string): THREE.Object3D | undefined {
    const prototype = this.prototypes.get(stem)
    if (prototype === undefined) return undefined
    const copy = cloneSkinned(prototype.scene)
    this.clipsByRoot.set(copy, prototype.clips)
    return copy
  }

  private async loadPrototype(stem: string, expectedClips: readonly string[]): Promise<void> {
    try {
      const gltf = await this.loader.loadAsync(`${this.baseURL}/Models/${stem}.glb`)
      const clips = gltf.animations
      // Same clip-presence contract the conversion validator enforces: a naive export collapses
      // the clip library into one timeline, and the symptom downstream is a character that only
      // ever plays its first animation.
      const missing = missingClips(
        expectedClips,
        clips.map((clip) => clip.name)
      )
      if (missing.length > 0) {
        console.error(
          `model "${stem}" is missing expected animation clips: ${missing.join(', ')} — the export likely collapsed its clip library`
        )
      }
      this.prototypes.set(stem, { scene: gltf.scene, clips })
    } catch {
      this.misses.add(stem)
      console.warn(`model "${stem}" unavailable; rendering a placeholder`)
    }
  }

  private async loadFloorTexture(stem: string): Promise<void> {
    try {
      const texture = await this.textureLoader.loadAsync(`${this.baseURL}/FloorMaterials/${stem}.png`)
      texture.wrapS = THREE.RepeatWrapping
      texture.wrapT = THREE.RepeatWrapping
      texture.colorSpace = THREE.SRGBColorSpace
      // The material tiles across a whole sector floor; un-mipped minification shimmers badly
      // under the tilted camera, and anisotropy is what keeps it from sparkling at grazing angles.
      texture.generateMipmaps = true
      texture.minFilter = THREE.LinearMipmapLinearFilter
      texture.magFilter = THREE.LinearFilter
      texture.anisotropy = 8
      this.textures.set(stem, texture)
    } catch {
      this.misses.add(stem)
      console.warn(`floor material "${stem}" unavailable; rendering the untextured floor`)
    }
  }
}
