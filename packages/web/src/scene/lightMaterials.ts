/** Light drawn without lights: additive materials over white textures whose alpha shapes them. */
import * as THREE from 'three';

/** Light that adds to what lies behind it and blocks nothing, as a flame's halo does. */
export function lightMaterial(map: THREE.Texture, color: number, opacity: number): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    map,
    color,
    opacity,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
}

/** White, as opaque at each texel as `alpha` says at its middle, `u` across from 0 to 1 and `v` up. */
export function whiteTexture(width: number, height: number, alpha: (u: number, v: number) => number): THREE.Texture {
  const bytes = new Uint8Array(width * height * 4).fill(255);
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      bytes[(row * width + column) * 4 + 3] = Math.round(255 * alpha((column + 0.5) / width, (row + 0.5) / height));
    }
  }
  const texture = new THREE.DataTexture(bytes, width, height, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}
