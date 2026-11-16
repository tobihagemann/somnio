import type * as THREE from 'three';
import { vi } from 'vitest';

/**
 * The program variant a mesh draws with a material, keyed by the parts of three.js's key that differ
 * between the scene's draws: what the material is, how its shaders read, and what of the mesh's
 * geometry, skeleton, and instances they read.
 */
function variantOf(object: THREE.Object3D, material: THREE.Material): string {
  const { geometry } = object as THREE.Mesh;
  return [
    material.type,
    material.side,
    material.transparent,
    material.customProgramCacheKey(),
    (material as THREE.ShaderMaterial).vertexShader,
    (material as THREE.ShaderMaterial).fragmentShader,
    ((material as THREE.MeshBasicMaterial).map ?? null) !== null,
    (object as THREE.SkinnedMesh).isSkinnedMesh === true,
    (object as THREE.InstancedMesh).isInstancedMesh === true,
    ((object as THREE.InstancedMesh).instanceColor ?? null) !== null,
    geometry.hasAttribute('position'),
    geometry.hasAttribute('normal'),
  ].join('|');
}

/** Each mesh drawn under `root` with each of its materials. */
function drawsUnder(root: THREE.Object3D): [THREE.Object3D, THREE.Material][] {
  const draws: [THREE.Object3D, THREE.Material][] = [];
  root.traverse((object) => {
    const { material } = object as THREE.Mesh;
    if (material === undefined) return;
    for (const each of Array.isArray(material) ? material : [material]) draws.push([object, each]);
  });
  return draws;
}

/** The program variant of each mesh drawn under `root`. */
export function programVariants(root: THREE.Object3D): Set<string> {
  return new Set(drawsUnder(root).map(([object, material]) => variantOf(object, material)));
}

/**
 * A stand-in for the renderer's `compileAsync` in `WorldScene.prewarm`. It keeps, for each program
 * variant it was handed, the materials it was handed with that are not yet disposed. three keeps a
 * program while a material that drew with it lives, so a variant with none left would compile again.
 */
export function recordingCompiler(): {
  compileAsync: ReturnType<typeof vi.fn<(root: THREE.Object3D) => Promise<THREE.Object3D>>>;
  /** What is drawn under the roots in a variant never compiled. */
  uncompiled: (...roots: THREE.Object3D[]) => string[];
  /** What is drawn under the roots in a variant whose every compiled material is disposed. */
  released: (...roots: THREE.Object3D[]) => string[];
} {
  const holders = new Map<string, Set<THREE.Material>>();
  const compileAsync = vi.fn((root: THREE.Object3D) => {
    for (const [object, material] of drawsUnder(root)) {
      const variant = variantOf(object, material);
      const held = holders.get(variant) ?? new Set<THREE.Material>();
      holders.set(variant, held);
      if (held.has(material)) continue;
      held.add(material);
      material.addEventListener('dispose', () => held.delete(material));
    }
    return Promise.resolve(root);
  });
  const drawn = (roots: THREE.Object3D[]): string[] => [...new Set(roots.flatMap((root) => [...programVariants(root)]))];
  return {
    compileAsync,
    uncompiled: (...roots) => drawn(roots).filter((variant) => !holders.has(variant)),
    released: (...roots) => drawn(roots).filter((variant) => holders.get(variant)?.size === 0),
  };
}
