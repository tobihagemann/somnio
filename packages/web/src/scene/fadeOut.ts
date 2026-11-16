/**
 * Fades a subtree out to clear without writing to what it finds, since a model's clones share their
 * prototype's materials. While the fade runs, each mesh under the root draws with a transparent
 * clone of each material it drew with, one clone per material however many meshes share it. The
 * clones share their originals' maps, which the prototype owns, so a fade disposes only its clones,
 * and the scene's disposal, which frees only what a mesh is marked as owning, leaves them alone. A
 * transparent material keys another program than an opaque one, so the scene's prewarm compiles each
 * model a fade can draw (`compileFadeOut`). Three draws a shadow whole whatever the opacity, so the
 * subtree stops casting one halfway out.
 */
import * as THREE from 'three';

/** How far out a fade is when its subtree stops casting a shadow. */
const SHADOW_GONE_AT = 0.5;

export interface FadeOut {
  /** Draws the subtree `k` of the way out: 0 as it was, 1 clear. */
  to(k: number): void;
  /** Disposes the clones, first putting back what each mesh drew with when `restore`, for a subtree drawn on after. */
  end(restore: boolean): void;
}

/** Starts a fade over `root`, drawing it as it was until told how far out it is. */
export function fadeOut(root: THREE.Object3D): FadeOut {
  const meshes: { mesh: THREE.Mesh; material: THREE.Material | THREE.Material[]; castShadow: boolean }[] = [];
  const clones = new Map<THREE.Material, { clone: THREE.Material; opacity: number }>();
  const cloneOf = (material: THREE.Material): THREE.Material => {
    let faded = clones.get(material);
    if (faded === undefined) {
      const clone = material.clone();
      clone.transparent = true;
      faded = { clone, opacity: material.opacity };
      clones.set(material, faded);
    }
    return faded.clone;
  };
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.isMesh !== true) return;
    meshes.push({ mesh, material: mesh.material, castShadow: mesh.castShadow });
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(cloneOf) : cloneOf(mesh.material);
  });
  return {
    to: (k) => {
      for (const { clone, opacity } of clones.values()) clone.opacity = opacity * (1 - k);
      for (const { mesh, castShadow } of meshes) mesh.castShadow = castShadow && k < SHADOW_GONE_AT;
    },
    end: (restore) => {
      if (restore) {
        for (const { mesh, material, castShadow } of meshes) {
          mesh.material = material;
          mesh.castShadow = castShadow;
        }
      }
      for (const { clone } of clones.values()) clone.dispose();
    },
  };
}

/**
 * Compiles the programs fades of `models` draw with, in `scene`'s light, so a first fade compiles
 * nothing mid-fight. Each model is faded on its own meshes, since three picks a skinned program from
 * the mesh. Those fades are never ended: a disposed clone would release the program it compiled.
 */
export async function compileFadeOut(
  renderer: Pick<THREE.WebGLRenderer, 'compileAsync'>,
  models: readonly THREE.Object3D[],
  camera: THREE.Camera,
  scene: THREE.Scene,
): Promise<void> {
  const group = new THREE.Group();
  for (const model of models) {
    fadeOut(model);
    group.add(model);
  }
  await renderer.compileAsync(group, camera, scene);
}
