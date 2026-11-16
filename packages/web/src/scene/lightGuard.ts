import * as THREE from 'three';

/** three's direct-light call, run once per light in `lights_fragment_begin`. */
const DIRECT_LIGHT_CALL = 'RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );';
const GUARDED_CALL = `if ( directLight.visible ) ${DIRECT_LIGHT_CALL}`;

/**
 * Skips a light's shading in a fragment it does not reach. The scene keeps a fixed pool of point
 * lights and a spot light so its programs never change (see `propLights.ts`), and outdoors every one
 * of them is dark. three runs its whole shading model for each of them in every lit fragment, though
 * `getPointLightInfo` and `getSpotLightInfo` have already marked a dark or out-of-range light not
 * `visible`, with its colour exactly zero, so skipping it changes no pixel. Outdoors that shading is
 * about a third of the frame's GPU time.
 *
 * A program's cache key does not hold the chunk's text, so this runs before any program compiles:
 * as each renderer is made.
 */
export function guardDirectLights(): void {
  const bare = THREE.ShaderChunk.lights_fragment_begin.replaceAll(GUARDED_CALL, DIRECT_LIGHT_CALL);
  THREE.ShaderChunk.lights_fragment_begin = bare.replaceAll(DIRECT_LIGHT_CALL, GUARDED_CALL);
}
