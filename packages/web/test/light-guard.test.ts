import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { guardDirectLights } from '@/scene/lightGuard';

const CALL = /RE_Direct\( directLight,/g;
const GUARDED = /if \( directLight\.visible \) RE_Direct\( directLight,/g;

/** The world's programs shade a light only where it reaches, through three's own light loop. */
describe('the direct-light guard', () => {
  it('guards every light kind three shades directly', () => {
    guardDirectLights();
    const chunk = THREE.ShaderChunk.lights_fragment_begin;
    // Point, spot, sun, and directional lights. A three upgrade that reshapes the loop leaves fewer.
    expect(chunk.match(GUARDED)).toHaveLength(4);
    expect(chunk.match(CALL)).toHaveLength(4);
  });

  it('guards each call once however often it runs', () => {
    guardDirectLights();
    const before = THREE.ShaderChunk.lights_fragment_begin;
    guardDirectLights();
    expect(THREE.ShaderChunk.lights_fragment_begin).toBe(before);
  });
});
