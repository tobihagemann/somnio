import type * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { allModelEntries, missingClips, modelForCharacter, modelForObjectId } from '@somnio/core';
import type { ModelRegistry } from '@somnio/core';

/**
 * Model-pack accessor.
 *
 * Loading is async but the render surface is driven synchronously, so everything is warmed in
 * `prewarm()`
 * and the per-request accessors are synchronous cache reads. A stem the prewarm has not cached
 * resolves `undefined` (a placeholder), never blocking and never throwing.
 *
 */
export interface ModelAssets {
  prewarm(): Promise<void>;
  character(id: string): THREE.Object3D | undefined;
  object(id: string): THREE.Object3D | undefined;
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

  object(id: string): THREE.Object3D | undefined {
    const entry = modelForObjectId(this.registry, id);
    return entry === undefined ? undefined : this.instantiate(entry.stem);
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
      this.prototypes.set(stem, { scene: gltf.scene, clips });
    } catch {
      this.misses.add(stem);
      console.warn(`model "${stem}" unavailable; rendering a placeholder`);
    }
  }
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
