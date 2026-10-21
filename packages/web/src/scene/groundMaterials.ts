/**
 * The floor materials: one painterly recipe per id, drawn by the ground's shader from the world
 * position alone, so no floor is ever a texture fetched from the pack. This is the one list of
 * floor-material ids, which every picker reads.
 */

type GroundPattern = 'meadow' | 'forest' | 'dirt' | 'cobble' | 'flagstone' | 'planks';

/** The floor-material ids, in the order the ground's weight channels carry them. */
export const GROUND_MATERIAL_IDS = ['grass-meadow', 'forest-floor', 'dirt-path', 'cobble-town', 'stone-arena', 'wood-warm'] as const;
export type GroundMaterialId = (typeof GROUND_MATERIAL_IDS)[number];

/** The most floor materials a ground carries: the weights ride two RGBA textures. */
export const MAX_GROUND_MATERIALS = 8;

interface GroundRecipe {
  pattern: GroundPattern;
  /** Base, dark, and light (the seam, for planks), as sRGB hex. */
  palette: readonly [number, number, number];
}

export const GROUND_RECIPES: Readonly<Record<GroundMaterialId, GroundRecipe>> = {
  'grass-meadow': { pattern: 'meadow', palette: [0x8db552, 0x6e9840, 0xb2cf72] },
  'forest-floor': { pattern: 'forest', palette: [0x6f7c3b, 0x56622d, 0x8f8d4c] },
  'dirt-path': { pattern: 'dirt', palette: [0xc8a46c, 0xa88456, 0xdcc391] },
  'cobble-town': { pattern: 'cobble', palette: [0xaaa398, 0x6f6a63, 0xc8c2b6] },
  'stone-arena': { pattern: 'flagstone', palette: [0x9c958a, 0x5f5b55, 0xbab3a6] },
  'wood-warm': { pattern: 'planks', palette: [0xb07d4c, 0x8c5d37, 0x4a3020] },
};

/** The channel a floor material is drawn in, or `undefined` for an id with no recipe. */
export function groundMaterialChannel(id: string): number | undefined {
  const channel = (GROUND_MATERIAL_IDS as readonly string[]).indexOf(id);
  return channel === -1 ? undefined : channel;
}

/** Noise and cell patterns every recipe shares, as GLSL. Hashes are of world position, so two sectors' grounds meet without a seam. */
const GROUND_GLSL_FUNCTIONS = /* glsl */ `
float groundHash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
vec2 groundHash2(vec2 p) { return vec2(groundHash(p), groundHash(p + 19.19)); }
float groundNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(groundHash(i), groundHash(i + vec2(1.0, 0.0)), u.x), mix(groundHash(i + vec2(0.0, 1.0)), groundHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float groundFbm(vec2 p) { return 0.5 * groundNoise(p) + 0.3 * groundNoise(p * 2.03 + 17.0) + 0.2 * groundNoise(p * 4.1 + 3.0); }
// A soft round fleck in a fraction of the cells of a jittered grid.
float groundFleck(vec2 p, float cells, float chance, float seed) {
  vec2 c = floor(p * cells), f = fract(p * cells);
  vec2 centre = 0.25 + 0.5 * groundHash2(c + seed);
  float r = 0.18 + 0.14 * groundHash(c + seed + 4.0);
  return step(1.0 - chance, groundHash(c + seed + 9.0)) * (1.0 - smoothstep(r * 0.55, r, length(f - centre)));
}
// Stones of a Voronoi cell pattern, mortar between them.
vec3 groundStones(vec2 p, float cells, vec3 a, vec3 b, vec3 mortar) {
  vec2 cp = p * cells, ci = floor(cp), cf = fract(cp);
  float f1 = 8.0, f2 = 8.0, id = 0.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 n = vec2(float(x), float(y));
    float d = length(n + 0.15 + 0.7 * groundHash2(ci + n) - cf);
    if (d < f1) { f2 = f1; f1 = d; id = groundHash(ci + n + 3.7); } else if (d < f2) { f2 = d; }
  }
  return mix(mortar, mix(a, b, id * 0.6 + 0.2), smoothstep(0.02, 0.07, f2 - f1));
}
vec3 groundMeadow(vec2 p, vec3 base, vec3 dark, vec3 light, float lo, float mid) {
  vec3 c = mix(base, dark, smoothstep(0.3, 0.7, lo));
  c = mix(c, light, smoothstep(0.55, 0.85, mid) * 0.45);
  c = mix(c, light, groundFleck(p, 7.0, 0.12, 1.0) * 0.35);
  return mix(c, dark * 0.85, groundFleck(p, 9.0, 0.06, 2.0) * 0.3);
}
vec3 groundForest(vec2 p, vec3 base, vec3 dark, vec3 light, float lo, float mid) {
  vec3 c = mix(base, dark, smoothstep(0.3, 0.7, lo));
  c = mix(c, light, smoothstep(0.6, 0.85, mid) * 0.35);
  c = mix(c, dark * 0.8, groundFleck(p, 8.0, 0.18, 5.0) * 0.45);
  return mix(c, light, groundFleck(p, 5.0, 0.05, 6.0) * 0.4);
}
vec3 groundDirt(vec2 p, vec3 base, vec3 dark, vec3 light, float lo, float mid) {
  vec3 c = mix(base, dark, smoothstep(0.3, 0.75, groundFbm(p * 0.6 + 9.0)));
  c = mix(c, light, groundFleck(p, 9.0, 0.1, 7.0) * 0.5);
  return mix(c, dark * 0.85, groundFleck(p, 12.0, 0.06, 8.0) * 0.4);
}
vec3 groundCobble(vec2 p, vec3 base, vec3 dark, vec3 light, float lo, float mid) {
  return groundStones(p, 2.4, base, light, dark) * (0.92 + 0.16 * lo);
}
vec3 groundFlagstone(vec2 p, vec3 base, vec3 dark, vec3 light, float lo, float mid) {
  return groundStones(p, 1.1, base, light, dark) * (0.9 + 0.2 * mid);
}
vec3 groundPlanks(vec2 p, vec3 base, vec3 dark, vec3 seam, float lo, float mid) {
  float row = floor(p.y / 0.24);
  float offset = groundHash(vec2(row, 3.0)) * 2.0;
  float segment = floor((p.x + offset) / 1.5);
  vec2 f = vec2(fract((p.x + offset) / 1.5), fract(p.y / 0.24));
  float edge = max(1.0 - smoothstep(0.0, 0.05, f.y), 1.0 - smoothstep(0.0, 0.01, f.x));
  vec3 wood = mix(base, dark, groundHash(vec2(row, segment) + 0.5)) * (0.9 + 0.2 * groundFbm(vec2(p.x * 0.7, row * 3.1)));
  wood *= 0.94 + 0.06 * sin(p.x * 38.0 + groundFbm(p * 3.0) * 6.0);
  return mix(wood, seam, edge * 0.6);
}
`;

/**
 * How far the shader moves a weight lookup off the true position, so a mark's edge reads painted
 * rather than rasterized. Each axis moves at most half this, so the raster's gutter clears it.
 */
const GROUND_LOOKUP_WOBBLE_METRES = 0.18;

const PATTERN_FUNCTIONS: Record<GroundPattern, string> = {
  meadow: 'groundMeadow',
  forest: 'groundForest',
  dirt: 'groundDirt',
  cobble: 'groundCobble',
  flagstone: 'groundFlagstone',
  planks: 'groundPlanks',
};

/**
 * The ground's fragment colour: the two weight textures read at a wobbled lookup, each material
 * drawn where it has weight, and the weights renormalized. `vGroundPosition` is the world position.
 */
export function groundFragmentChunks(): { declarations: string; colour: string } {
  const terms = GROUND_MATERIAL_IDS.map((id, index) => {
    const recipe = GROUND_RECIPES[id];
    const weight = `${index < 4 ? 'groundWeights0' : 'groundWeights1'}.${'rgba'[index % 4]}`;
    const palette = `uGroundPalette[${index * 3}], uGroundPalette[${index * 3 + 1}], uGroundPalette[${index * 3 + 2}]`;
    return `  if (${weight} > 0.002) groundColour += ${weight} * ${PATTERN_FUNCTIONS[recipe.pattern]}(p, ${palette}, lo, mid);`;
  });
  return {
    declarations: `varying vec3 vGroundPosition;
uniform sampler2D uGroundWeights0;
uniform sampler2D uGroundWeights1;
uniform vec2 uGroundOrigin;
uniform vec2 uGroundSize;
uniform vec3 uGroundPalette[${GROUND_MATERIAL_IDS.length * 3}];
${GROUND_GLSL_FUNCTIONS}`,
    colour: `vec2 p = vGroundPosition.xz;
vec2 wobble = vec2(groundFbm(p * 1.7), groundFbm(p * 1.7 + 7.1)) - 0.5;
vec2 lookup = (p + wobble * ${GROUND_LOOKUP_WOBBLE_METRES.toFixed(2)} - uGroundOrigin) / uGroundSize;
vec4 groundWeights0 = texture2D(uGroundWeights0, lookup);
vec4 groundWeights1 = texture2D(uGroundWeights1, lookup);
float groundTotal = dot(groundWeights0, vec4(1.0)) + dot(groundWeights1, vec4(1.0));
if (groundTotal > 0.001) { groundWeights0 /= groundTotal; groundWeights1 /= groundTotal; } else { groundWeights0 = vec4(1.0, 0.0, 0.0, 0.0); }
float lo = groundFbm(p * 0.22);
float mid = groundFbm(p * 0.9 + 3.0);
vec3 groundColour = vec3(0.0);
${terms.join('\n')}
vec4 diffuseColor = vec4(groundColour, opacity);`,
  };
}
