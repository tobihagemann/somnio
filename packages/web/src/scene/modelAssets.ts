import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { allModelEntries, groundModelStem, handModelStem, missingClips, modelForCharacter, modelForObjectId, trophyModelStem, wardrobeRow } from '@somnio/core';
import type { ModelRegistry } from '@somnio/core';

/**
 * Model-pack accessor.
 *
 * Loading is async but the render surface is driven synchronously, so everything is warmed in
 * `prewarm()`
 * and the per-request accessors are synchronous cache reads. A stem the prewarm has not cached
 * resolves `undefined` (a placeholder), never blocking and never throwing. Worn pieces are the
 * exception: each loads when a dreamer first wears it (`wear`).
 *
 */
export interface ModelAssets {
  prewarm(): Promise<void>;
  character(id: string): THREE.Object3D | undefined;
  /** What a hand holding an item of `baseId` draws, to hang at identity under its `handslot` bone. */
  hand(baseId: string): THREE.Object3D | undefined;
  /** What a drop of an item of `baseId` rolled at `tier` draws: a model lying on the ground, its ground bounds centred on its origin. */
  ground(baseId: string, tier: number): THREE.Object3D | undefined;
  /** What the trophy of `monsterKind` draws, lying on the ground as a drop of an item does. */
  trophy(monsterKind: string): THREE.Object3D | undefined;
  object(id: string): THREE.Object3D | undefined;
  /**
   * The worn piece of `stem`, loaded on its first call and cached: the cache's own model, read to
   * dress a body and never drawn itself. `undefined` for a piece that failed to load, which leaves
   * the body's base clothes showing.
   */
  wear(stem: string): Promise<THREE.Object3D | undefined>;
  /**
   * Loads each of `stems` again, under a URL of its own, for a load that stalls. Every call to `wear`
   * for a piece still loading, earlier ones included, answers with what the newest attempt brings,
   * and an older attempt that comes back once a newer one has started is ignored. A piece whose load
   * has come back keeps its answer.
   */
  retryWear(stems: readonly string[]): void;
  clipsFor(root: THREE.Object3D): THREE.AnimationClip[];
  /**
   * The single-material meshes of an object model's cached prototype, each with its transform
   * relative to the model's root, for drawing the model instanced. `undefined` for an unmapped id or
   * until the prototype is cached. The geometry and material are the cache's own, so a caller
   * clones what it changes.
   */
  prototypeMeshes(id: string): PrototypeMesh[] | undefined;
}

export interface PrototypeMesh {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  matrix: THREE.Matrix4;
}

interface Prototype {
  scene: THREE.Object3D;
  clips: THREE.AnimationClip[];
}

export class HttpModelAssets implements ModelAssets {
  private readonly registry: ModelRegistry;
  private readonly baseURL: string;
  private readonly loader = new GLTFLoader();
  private readonly prototypes = new Map<string, Prototype>();
  /** Negative cache: a stem whose fetch already failed is not retried on the next prewarm. */
  private readonly misses = new Set<string>();
  private readonly clipsByRoot = new WeakMap<THREE.Object3D, THREE.AnimationClip[]>();
  /** Each worn piece asked for: what every `wear` for it answers, the newest attempt at loading it counted from 0, and how that attempt settles the answer. */
  private readonly worn = new Map<
    string,
    { load: Promise<THREE.Object3D | undefined>; attempt: number; settle: (model: THREE.Object3D | undefined) => void }
  >();

  constructor(registry: ModelRegistry, baseURL = '/assets') {
    this.registry = registry;
    this.baseURL = baseURL.replace(/\/$/, '');
  }

  async prewarm(): Promise<void> {
    await Promise.all(
      allModelEntries(this.registry)
        .filter((entry) => !this.prototypes.has(entry.stem) && !this.misses.has(entry.stem))
        .map((entry) => this.loadPrototype(entry.stem, entry.expectedClips)),
    );
  }

  character(id: string): THREE.Object3D | undefined {
    const entry = modelForCharacter(this.registry, id);
    return entry === undefined ? undefined : this.instantiate(entry.stem);
  }

  hand(baseId: string): THREE.Object3D | undefined {
    const stem = handModelStem(this.registry, baseId);
    return stem === undefined ? undefined : this.instantiate(stem);
  }

  ground(baseId: string, tier: number): THREE.Object3D | undefined {
    const stem = wardrobeRow(this.registry, baseId, tier)?.ground ?? groundModelStem(this.registry, baseId);
    return stem === undefined ? undefined : this.instantiate(stem);
  }

  trophy(monsterKind: string): THREE.Object3D | undefined {
    const stem = trophyModelStem(this.registry, monsterKind);
    return stem === undefined ? undefined : this.instantiate(stem);
  }

  object(id: string): THREE.Object3D | undefined {
    const entry = modelForObjectId(this.registry, id);
    return entry === undefined ? undefined : this.instantiate(entry.stem);
  }

  wear(stem: string): Promise<THREE.Object3D | undefined> {
    const asked = this.worn.get(stem);
    if (asked !== undefined) return asked.load;
    let settle!: (model: THREE.Object3D | undefined) => void;
    const load = new Promise<THREE.Object3D | undefined>((resolve) => (settle = resolve));
    this.worn.set(stem, { load, attempt: 0, settle });
    this.loadWear(stem, 0);
    return load;
  }

  retryWear(stems: readonly string[]): void {
    for (const stem of stems) {
      const asked = this.worn.get(stem);
      if (asked === undefined) continue;
      asked.attempt += 1;
      this.loadWear(stem, asked.attempt);
    }
  }

  /**
   * Starts attempt `attempt` at loading a worn piece, which answers every `wear` for it unless a
   * newer attempt has started by the time it comes back. A retry asks under a URL of its own, since
   * three's loader joins a request for a URL already in flight.
   */
  private loadWear(stem: string, attempt: number): void {
    const url = `${this.baseURL}/Models/${stem}.glb${attempt === 0 ? '' : `?retry=${attempt}`}`;
    void this.loader.loadAsync(url).then(
      (gltf) => this.settleWear(stem, attempt, gltf.scene),
      () => {
        console.warn(`worn piece "${stem}" unavailable; its wearer keeps the base clothes`);
        this.settleWear(stem, attempt, undefined);
      },
    );
  }

  private settleWear(stem: string, attempt: number, model: THREE.Object3D | undefined): void {
    const asked = this.worn.get(stem)!;
    if (asked.attempt === attempt) asked.settle(model);
  }

  clipsFor(root: THREE.Object3D): THREE.AnimationClip[] {
    return this.clipsByRoot.get(root) ?? [];
  }

  prototypeMeshes(id: string): PrototypeMesh[] | undefined {
    const entry = modelForObjectId(this.registry, id);
    const prototype = entry === undefined ? undefined : this.prototypes.get(entry.stem);
    return prototype === undefined ? undefined : prototypeMeshesOf(prototype.scene);
  }

  /**
   * `SkeletonUtils.clone`, **not** `Object3D.clone`.
   *
   * A plain clone copies the mesh nodes but leaves every copy pointing at the prototype's
   * `Skeleton` and its bone objects. Two entities sharing one skeleton means the second one's
   * animation drives the first, so a room of peers all pose identically to whoever moved last.
   */
  private instantiate(stem: string): THREE.Object3D | undefined {
    const prototype = this.prototypes.get(stem);
    if (prototype === undefined) return undefined;
    const copy = cloneSkinned(prototype.scene);
    // A clone does not copy a mesh's depth material.
    copy.traverse((object) => {
      if ((object as THREE.SkinnedMesh).isSkinnedMesh && usesSharedDepth(object as THREE.SkinnedMesh)) object.customDepthMaterial = SKINNED_DEPTH_MATERIAL;
    });
    this.clipsByRoot.set(copy, prototype.clips);
    return copy;
  }

  private async loadPrototype(stem: string, expectedClips: readonly string[]): Promise<void> {
    try {
      const gltf = await this.loader.loadAsync(`${this.baseURL}/Models/${stem}.glb`);
      const clips = gltf.animations;
      // Same clip-presence contract the asset pipeline's gate (`glb_clip_presence.py`) enforces:
      // the glTF exporter can drop an action without an error, and the symptom is a character
      // that loads but never plays the dropped clip.
      const missing = missingClips(
        expectedClips,
        clips.map((clip) => clip.name),
      );
      if (missing.length > 0) {
        console.error(`model "${stem}" is missing expected animation clips: ${missing.join(', ')} — the export likely dropped them`);
      }
      unshareSkinnedMaterials(gltf.scene);
      this.prototypes.set(stem, { scene: gltf.scene, clips });
    } catch {
      this.misses.add(stem);
      console.warn(`model "${stem}" unavailable; rendering a placeholder`);
    }
  }
}

/**
 * The shadow pass draws every caster with three's one depth material, and each switch between a
 * skinned and a rigid caster makes three rebuild that material's program parameters, as many times
 * a frame as the casters alternate. So skinned casters share this one instead. A material that needs
 * a depth variant of its own (an alpha test, alpha to coverage, an alpha map, or a displacement map)
 * is left to three, which makes one for it.
 */
export const SKINNED_DEPTH_MATERIAL = new THREE.MeshDepthMaterial();

function usesSharedDepth(mesh: THREE.SkinnedMesh): boolean {
  const material = mesh.material as THREE.Material & { alphaMap?: unknown; displacementMap?: unknown };
  return !Array.isArray(mesh.material) && material.alphaTest === 0 && !material.alphaToCoverage && !material.alphaMap && !material.displacementMap;
}

/**
 * Gives the rigid meshes of a model their own copy of a material its skinned meshes draw with, as a
 * helmet on a bone shares the body's texture. three keeps one program per material and checks it
 * against each mesh drawn, so a material drawn on both rebuilds its program parameters at every
 * switch, in the world's pass and each portrait, and for a cut-out in the shadow pass too.
 */
function unshareSkinnedMaterials(root: THREE.Object3D): void {
  const skinned = new Set<THREE.Material>();
  root.traverse((object) => {
    const mesh = object as THREE.SkinnedMesh;
    if (mesh.isSkinnedMesh) for (const material of [mesh.material].flat()) skinned.add(material);
  });
  const copies = new Map<THREE.Material, THREE.Material>();
  const copyOf = (material: THREE.Material): THREE.Material => {
    if (!skinned.has(material)) return material;
    if (!copies.has(material)) copies.set(material, material.clone());
    return copies.get(material)!;
  };
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || (mesh as THREE.SkinnedMesh).isSkinnedMesh) return;
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(copyOf) : copyOf(mesh.material);
  });
}

/** A model's meshes with their transforms relative to its root, the pipeline's normalizing parent included. */
export function prototypeMeshesOf(root: THREE.Object3D): PrototypeMesh[] {
  root.updateMatrixWorld(true);
  const toRoot = root.matrixWorld.clone().invert();
  const meshes: PrototypeMesh[] = [];
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || Array.isArray(mesh.material)) return;
    meshes.push({ geometry: mesh.geometry, material: mesh.material, matrix: toRoot.clone().multiply(mesh.matrixWorld) });
  });
  return meshes;
}
