import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { fadeOut } from '@/scene/fadeOut';

/** Two meshes drawing with one material at half opacity, as two parts of a model share one, both casting a shadow. */
function sharing() {
  const material = new THREE.MeshStandardMaterial({ opacity: 0.5 });
  const root = new THREE.Group();
  const meshes = [new THREE.Mesh(new THREE.BoxGeometry(), material), new THREE.Mesh(new THREE.BoxGeometry(), material)];
  for (const mesh of meshes) mesh.castShadow = true;
  root.add(meshes[0]!);
  meshes[0]!.add(meshes[1]!);
  return { material, root, meshes };
}

describe('fadeOut', () => {
  it('draws the meshes sharing a material with one transparent clone of it, at its opacity times what is left', () => {
    const { material, root, meshes } = sharing();
    fadeOut(root).to(0.5);
    const [first, second] = meshes.map((mesh) => mesh.material);
    expect(first).not.toBe(material);
    expect(second).toBe(first);
    expect([first!.transparent, first!.opacity]).toEqual([true, 0.25]);
    expect([material.transparent, material.opacity]).toEqual([false, 0.5]);
  });

  it('casts a shadow until halfway out, and none from there', () => {
    const { root, meshes } = sharing();
    const fade = fadeOut(root);
    fade.to(0.49);
    expect(meshes.map((mesh) => mesh.castShadow)).toEqual([true, true]);
    fade.to(0.5);
    expect(meshes.map((mesh) => mesh.castShadow)).toEqual([false, false]);
  });

  it('puts back what each mesh drew with and its shadow when ended to restore, and disposes the clone', () => {
    const { material, root, meshes } = sharing();
    const fade = fadeOut(root);
    fade.to(0.8);
    const clone = meshes[0]!.material as THREE.Material;
    const cloneDispose = vi.spyOn(clone, 'dispose');
    const materialDispose = vi.spyOn(material, 'dispose');
    fade.end(true);
    expect(meshes.map((mesh) => [mesh.material === material, mesh.castShadow])).toEqual([
      [true, true],
      [true, true],
    ]);
    expect(cloneDispose).toHaveBeenCalledTimes(1);
    expect(materialDispose).not.toHaveBeenCalled();
  });

  it('disposes the clone and leaves the meshes as they are when ended without restoring', () => {
    const { material, root, meshes } = sharing();
    const fade = fadeOut(root);
    fade.to(0.8);
    const clone = meshes[0]!.material as THREE.Material;
    const cloneDispose = vi.spyOn(clone, 'dispose');
    const materialDispose = vi.spyOn(material, 'dispose');
    fade.end(false);
    expect(meshes.map((mesh) => [mesh.material === clone, mesh.castShadow])).toEqual([
      [true, false],
      [true, false],
    ]);
    expect(cloneDispose).toHaveBeenCalledTimes(1);
    expect(materialDispose).not.toHaveBeenCalled();
  });
});
