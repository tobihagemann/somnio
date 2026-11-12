/**
 * The auras round the elites in view: a soft column of light round each body in its trait's colour,
 * brightest at the feet and gone above the head. It hangs beside the body's model holder, under its
 * jolt, so it moves and staggers with the body, and no portrait shows it, since a portrait draws the
 * model holder's layer alone. The auras come from a pool of fixed size, and an elite past it draws
 * none. Every aura draws with one of two materials that differ only in colour, compiled in the
 * scene's prewarm, and none adds a light. They breathe slowly together, held steady under reduced
 * motion.
 */
import * as THREE from 'three';
import type { EliteTraitId } from '@somnio/core';
import { lightMaterial, whiteTexture } from './lightMaterials';

/** The name every aura mesh carries. */
export const ELITE_AURA_NAME = 'somnio-elite-aura';

/** How many elites in view draw an aura at once. */
export const ELITE_AURA_POOL_SIZE = 8;

/** Each trait's colour: Stony a warm sandstone, Shielded a cold glint of ice. */
export const ELITE_TRAIT_COLORS: Readonly<Record<EliteTraitId, number>> = { stony: 0xd9aa6a, shielded: 0x86d4ff };

/** How far past the body's radius the column stands, and how tall it rises. */
const AURA_PADDING = 0.14;
const AURA_HEIGHT = 1.6;
const AURA_OPACITY = 0.42;
/** How long the auras take to brighten and dim again, and how far they dim. */
const AURA_PULSE_SECONDS = 3.2;
const AURA_PULSE_DEPTH = 0.3;

export class EliteAuras {
  private readonly reducedMotion: boolean;
  /** An open column of radius 1 and height 1, standing on its foot. */
  private readonly geometry = new THREE.CylinderGeometry(1, 1, 1, 24, 1, true).translate(0, 0.5, 0);
  private readonly materials: Record<EliteTraitId, THREE.MeshBasicMaterial>;
  private readonly pool: THREE.Mesh[] = [];
  /** The aura each elite wears, by its entity id. */
  private readonly worn = new Map<string, THREE.Mesh>();

  constructor(reducedMotion: boolean) {
    this.reducedMotion = reducedMotion;
    const rising = whiteTexture(4, 64, (_, v) => (1 - v) ** 1.6);
    const material = (color: number): THREE.MeshBasicMaterial => Object.assign(lightMaterial(rising, color, AURA_OPACITY), { side: THREE.DoubleSide });
    this.materials = { stony: material(ELITE_TRAIT_COLORS.stony), shielded: material(ELITE_TRAIT_COLORS.shielded) };
  }

  /** Hangs an aura in the colour of the elite's trait under `jolt`, as wide as its body; an entity with no trait wears none. */
  show(entityId: string, jolt: THREE.Object3D, radius: number, trait: EliteTraitId | undefined): void {
    if (trait === undefined) {
      this.forget(entityId);
      return;
    }
    const aura = this.worn.get(entityId) ?? this.free();
    if (aura === undefined) return;
    this.worn.set(entityId, aura);
    aura.material = this.materials[trait];
    aura.scale.set(radius + AURA_PADDING, AURA_HEIGHT, radius + AURA_PADDING);
    jolt.add(aura);
  }

  /** Takes the entity's aura off and gives it back to the pool. */
  forget(entityId: string): void {
    this.worn.get(entityId)?.removeFromParent();
    this.worn.delete(entityId);
  }

  clear(): void {
    for (const entityId of [...this.worn.keys()]) this.forget(entityId);
  }

  /** Breathes every aura on the scene's clock. */
  tick(clock: number): void {
    const dim = this.reducedMotion ? 0 : (AURA_PULSE_DEPTH * (1 - Math.cos((clock / AURA_PULSE_SECONDS) * Math.PI * 2))) / 2;
    for (const material of Object.values(this.materials)) material.opacity = AURA_OPACITY * (1 - dim);
  }

  /** Compiles the auras' program, so the first elite compiles nothing. */
  async compile(renderer: Pick<THREE.WebGLRenderer, 'compileAsync'>, camera: THREE.Camera, scene: THREE.Scene): Promise<void> {
    const group = new THREE.Group();
    group.add(...Object.values(this.materials).map((material) => new THREE.Mesh(this.geometry, material)));
    await renderer.compileAsync(group, camera, scene);
  }

  /** A mesh of the pool no elite wears, made while the pool can grow. */
  private free(): THREE.Mesh | undefined {
    const worn = new Set(this.worn.values());
    const spare = this.pool.find((aura) => !worn.has(aura));
    if (spare !== undefined || this.pool.length >= ELITE_AURA_POOL_SIZE) return spare;
    const aura = new THREE.Mesh(this.geometry, this.materials.stony);
    aura.name = ELITE_AURA_NAME;
    this.pool.push(aura);
    return aura;
  }
}
