/**
 * Bakes a dressed dreamer into one skinned mesh that draws with one material shared by every
 * dreamer, so a dressed body costs a draw call and its shadow's however many pieces it wears. Each
 * of the body's region meshes and each worn piece is prepared on its own (`preparePiece`): moved into
 * the body's bind space, its joints mapped to the body's by name, its materials folded into a texture layer
 * and a vertex colour. The prepared parts are then joined (`bakeOutfit`). Every base-colour image
 * lives in one texture array (`WardrobeTextures`), which the shared `WardrobeMaterial` samples by
 * each vertex's layer. Copying an image into its layer, preparing a piece, and joining an outfit are
 * separate calls, so a caller can spread them over frames.
 */
import * as THREE from 'three';

/**
 * How many base-colour images the texture array holds: one per key (`keyOf`) across the four bodies
 * and every worn piece of the registry's wardrobe, neutral and role-line.
 * It is counted from the texture and image names in each of those models' glTF JSON, as three's
 * loader names a texture. Two images with identical bytes under two names take two layers.
 */
export const WARDROBE_LAYERS = 21;

/** The width and height of each layer, in pixels. */
const LAYER_SIZE = 512;

const LAYER_BYTES = LAYER_SIZE * LAYER_SIZE * 4;

const WARDROBE_MATERIAL_NAME = 'somnio-wardrobe';

/** The name of the mesh a dressed body is drawn as. */
export const BAKED_OUTFIT = 'somnio-baked-outfit';

/**
 * The longest each call has taken, in milliseconds of script, so a caller that spreads them over
 * frames can budget each. `copy` is one image copied into its layer (`WardrobeTextures.place`),
 * measured in headless Chrome on the reference over the pack's thirteen 1024 px images across four
 * page loads. `prepare` is one piece (`preparePiece`) and `join` one outfit (`bakeOutfit`), both
 * measured over 108 outfits of the published pack.
 */
export const WARDROBE_STEP_MS = { copy: 1.5, prepare: 1.84, join: 4.66 } as const;

/**
 * The texture array every dressed body samples, a layer per base-colour image. A texture is keyed by
 * its name, which names one image across every model of the pack, so a second piece using it shares
 * its layer. A nameless texture is keyed by itself. Layers are never freed. A worn piece is never
 * drawn itself, so the images of its maps are let go of once their layer holds them (`adopt`).
 */
export class WardrobeTextures {
  readonly array: THREE.DataArrayTexture;
  private readonly pixels = new Uint8Array(LAYER_BYTES * WARDROBE_LAYERS);
  private readonly layers = new Map<string | THREE.Texture, number>();
  private readonly missed = new Set<string | THREE.Texture>();
  /** The maps of worn pieces whose images go once their key has a layer or has missed one. */
  private readonly adopted = new Map<string | THREE.Texture, Set<THREE.Texture>>();
  private readonly canvas = document.createElement('canvas');
  private context: CanvasRenderingContext2D | null | undefined;

  constructor() {
    this.array = new THREE.DataArrayTexture(this.pixels, LAYER_SIZE, LAYER_SIZE, WARDROBE_LAYERS);
    this.array.colorSpace = THREE.SRGBColorSpace;
    this.array.magFilter = THREE.LinearFilter;
    this.array.minFilter = THREE.LinearMipmapLinearFilter;
    this.array.generateMipmaps = true;
    this.canvas.width = LAYER_SIZE;
    this.canvas.height = LAYER_SIZE;
  }

  /**
   * Takes the maps of a worn piece, which is never drawn itself, to let go of each one's image as soon
   * as its key has a layer or has missed one, at once where it already has. A body's maps are never
   * adopted, since the body is drawn with them until it is dressed.
   */
  adopt(piece: THREE.Object3D): void {
    piece.traverse((object) => {
      if (!(object as THREE.Mesh).isMesh) return;
      for (const material of materialsOf(object as THREE.Mesh)) {
        const map = material.map;
        if (!map) continue;
        const key = keyOf(map);
        if (this.layers.has(key) || this.missed.has(key)) letGo(map);
        else this.adopted.set(key, (this.adopted.get(key) ?? new Set()).add(map));
      }
    });
  }

  /** The base-colour maps of `mesh`'s materials that have no layer yet and have not missed one, each one `place` to copy. */
  unplaced(mesh: THREE.Mesh): THREE.Texture[] {
    const maps = materialsOf(mesh).flatMap((material) => (material.map ? [material.map] : []));
    return [...new Set(maps)].filter((texture) => !this.layers.has(keyOf(texture)) && !this.missed.has(keyOf(texture)));
  }

  /** The layer `texture` is drawn from, copying it into the next free layer first when it has none; `undefined` when no layer is free or the canvas has no 2D context. */
  place(texture: THREE.Texture): number | undefined {
    const key = keyOf(texture);
    const given = this.layers.get(key);
    if (given !== undefined) return given;
    if (this.missed.has(key)) return undefined;
    this.context ??= this.canvas.getContext('2d', { willReadFrequently: true });
    const layer = this.layers.size;
    if (layer >= WARDROBE_LAYERS || this.context === null) {
      this.missed.add(key);
      console.warn(`wardrobe texture "${texture.name}" has no free layer; its pieces keep the base clothes`);
      this.letGoOfAdopted(key);
      return undefined;
    }
    this.context.globalCompositeOperation = 'copy';
    this.context.drawImage(texture.image as CanvasImageSource, 0, 0, LAYER_SIZE, LAYER_SIZE);
    this.pixels.set(this.context.getImageData(0, 0, LAYER_SIZE, LAYER_SIZE).data, layer * LAYER_BYTES);
    this.array.addLayerUpdate(layer);
    this.array.needsUpdate = true;
    this.layers.set(key, layer);
    this.letGoOfAdopted(key);
    return layer;
  }

  private letGoOfAdopted(key: string | THREE.Texture): void {
    for (const map of this.adopted.get(key) ?? []) letGo(map);
    this.adopted.delete(key);
  }
}

/**
 * Frees a map's decoded image, which nothing reads once its layer holds it: an `ImageBitmap` is not
 * freed by the collector alone, so it is closed, and the map no longer refers to it.
 */
function letGo(map: THREE.Texture): void {
  const image = map.image as { close?: () => void } | null;
  image?.close?.();
  map.image = null;
}

/**
 * The one material every baked body draws with: its colour is the vertex colour times its layer of
 * the texture array at the vertex's uv, or the vertex colour alone where the layer is negative. Every
 * published wardrobe material is matte and double-sided, so this one is too.
 */
export class WardrobeMaterial extends THREE.MeshStandardMaterial {
  private readonly textures: WardrobeTextures;

  constructor(textures: WardrobeTextures) {
    super({ metalness: 0, roughness: 0.5, side: THREE.DoubleSide, vertexColors: true });
    this.textures = textures;
  }

  override onBeforeCompile(shader: THREE.WebGLProgramParametersWithUniforms): void {
    shader.uniforms['wardrobeMap'] = { value: this.textures.array };
    shader.vertexShader = `attribute float layer;\nflat varying float vWardrobeLayer;\nvarying vec2 vWardrobeUv;\n${shader.vertexShader.replace(
      '#include <uv_vertex>',
      '#include <uv_vertex>\nvWardrobeLayer = layer;\nvWardrobeUv = uv;',
    )}`;
    shader.fragmentShader = `uniform sampler2DArray wardrobeMap;\nflat varying float vWardrobeLayer;\nvarying vec2 vWardrobeUv;\n${shader.fragmentShader.replace(
      '#include <map_fragment>',
      'if (vWardrobeLayer >= 0.0) diffuseColor *= texture(wardrobeMap, vec3(vWardrobeUv, vWardrobeLayer));',
    )}`;
  }

  override customProgramCacheKey(): string {
    return WARDROBE_MATERIAL_NAME;
  }
}

/** A mesh ready to join a bake: indexed typed arrays in the body's bind space, joints by the body's skeleton, one entry per vertex. */
export interface PreparedPiece {
  position: Float32Array;
  normal: Float32Array;
  uv: Float32Array;
  color: Float32Array;
  layer: Float32Array;
  skinIndex: Uint16Array;
  skinWeight: Float32Array;
  index: Uint32Array;
}

/** Prepared pieces by textures, body geometry, piece geometry, and the hair fit applied ('' for none); `null` for a miss. */
const preparedPieces = new WeakMap<WardrobeTextures, WeakMap<THREE.BufferGeometry, WeakMap<THREE.BufferGeometry, Map<string, PreparedPiece | null>>>>();

/**
 * `mesh`, a region of the body or a worn piece, prepared to join a bake bound to `body`'s skeleton
 * and bind matrix: the morph target named `hairFit` added first where the mesh carries it, then its
 * vertices moved from its own bind space into the body's, its joints mapped to the body's by name,
 * each material group's layer and base colour (times any vertex colour) set on its vertices, and zero
 * uvs where it has none. `undefined` when one of its textures finds no layer or one of its joints is
 * not the body's. Cached per body model, geometry, and hair fit, so clones of a model share one.
 */
export function preparePiece(
  mesh: THREE.SkinnedMesh,
  body: THREE.SkinnedMesh,
  hairFit: string | undefined,
  textures: WardrobeTextures,
): PreparedPiece | undefined {
  const { byMorph, morph } = cached(mesh, body, hairFit, textures);
  if (!byMorph.has(morph)) byMorph.set(morph, prepare(mesh, body, morph, textures) ?? null);
  return byMorph.get(morph) ?? undefined;
}

/** Whether `preparePiece` with these arguments answers from its cache, at no cost. */
export function isPrepared(mesh: THREE.SkinnedMesh, body: THREE.SkinnedMesh, hairFit: string | undefined, textures: WardrobeTextures): boolean {
  const { byMorph, morph } = cached(mesh, body, hairFit, textures);
  return byMorph.has(morph);
}

function cached(
  mesh: THREE.SkinnedMesh,
  body: THREE.SkinnedMesh,
  hairFit: string | undefined,
  textures: WardrobeTextures,
): { byMorph: Map<string, PreparedPiece | null>; morph: string } {
  const morph = hairFit !== undefined && mesh.morphTargetDictionary?.[hairFit] !== undefined ? hairFit : '';
  const byBody = entry(preparedPieces, textures, () => new WeakMap());
  const byGeometry = entry(byBody, body.geometry, () => new WeakMap());
  return { byMorph: entry(byGeometry, mesh.geometry, () => new Map()), morph };
}

function prepare(mesh: THREE.SkinnedMesh, body: THREE.SkinnedMesh, morph: string, textures: WardrobeTextures): PreparedPiece | undefined {
  const materials = materialsOf(mesh);
  const layers: number[] = [];
  for (const material of materials) {
    const layer = material.map ? textures.place(material.map) : -1;
    if (layer === undefined) return undefined;
    layers.push(layer);
  }
  const joints = jointMap(mesh.skeleton, body.skeleton);
  if (joints === undefined) {
    console.warn(`wardrobe mesh "${mesh.name}" is skinned to joints the body does not have; it keeps the base clothes`);
    return undefined;
  }

  const geometry = mesh.geometry;
  const positions = geometry.getAttribute('position');
  const normals = geometry.getAttribute('normal');
  const uvs = geometry.getAttribute('uv') as THREE.BufferAttribute | undefined;
  const colors = geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
  const skinIndices = geometry.getAttribute('skinIndex');
  const skinWeights = geometry.getAttribute('skinWeight');
  const count = positions.count;
  const target = morph === '' ? undefined : mesh.morphTargetDictionary![morph]!;
  const positionDeltas = target === undefined ? undefined : geometry.morphAttributes['position']?.[target];
  const normalDeltas = target === undefined ? undefined : geometry.morphAttributes['normal']?.[target];
  const toBody = body.bindMatrix.clone().invert().multiply(mesh.bindMatrix);
  const normalToBody = new THREE.Matrix3().getNormalMatrix(toBody);

  const piece: PreparedPiece = {
    position: new Float32Array(count * 3),
    normal: new Float32Array(count * 3),
    uv: new Float32Array(count * 2),
    color: new Float32Array(count * 3),
    layer: new Float32Array(count),
    skinIndex: new Uint16Array(count * 4),
    skinWeight: new Float32Array(count * 4),
    index: geometry.index === null ? Uint32Array.from({ length: count }, (_, vertex) => vertex) : Uint32Array.from(geometry.index.array),
  };
  const vector = new THREE.Vector3();
  const delta = new THREE.Vector3();
  for (let vertex = 0; vertex < count; vertex++) {
    vector.fromBufferAttribute(positions, vertex);
    if (positionDeltas !== undefined) vector.add(delta.fromBufferAttribute(positionDeltas, vertex));
    vector.applyMatrix4(toBody).toArray(piece.position, vertex * 3);
    vector.fromBufferAttribute(normals, vertex);
    if (normalDeltas !== undefined) vector.add(delta.fromBufferAttribute(normalDeltas, vertex));
    vector
      .applyMatrix3(normalToBody)
      .normalize()
      .toArray(piece.normal, vertex * 3);
    if (uvs !== undefined) {
      piece.uv[vertex * 2] = uvs.getX(vertex);
      piece.uv[vertex * 2 + 1] = uvs.getY(vertex);
    }
    for (let component = 0; component < 4; component++) {
      piece.skinIndex[vertex * 4 + component] = joints[skinIndices.getComponent(vertex, component)] ?? 0;
      piece.skinWeight[vertex * 4 + component] = skinWeights.getComponent(vertex, component);
    }
  }

  const color = new THREE.Color();
  const vertexColor = new THREE.Color();
  for (const { start, count: indices, materialIndex = 0 } of materialGroups(mesh, piece.index.length)) {
    const material = materials[materialIndex]!;
    for (let at = start; at < start + indices; at++) {
      const vertex = piece.index[at]!;
      color.copy(material.color ?? WHITE);
      if (colors !== undefined) color.multiply(vertexColor.fromBufferAttribute(colors, vertex));
      color.toArray(piece.color, vertex * 3);
      piece.layer[vertex] = layers[materialIndex]!;
    }
  }
  return piece;
}

/** The prepared parts joined into one indexed geometry, with no groups, which the shared `WardrobeMaterial` draws. */
export function bakeOutfit(parts: readonly PreparedPiece[]): THREE.BufferGeometry {
  const vertices = parts.reduce((sum, part) => sum + part.layer.length, 0);
  const indices = parts.reduce((sum, part) => sum + part.index.length, 0);
  const baked = {
    position: new Float32Array(vertices * 3),
    normal: new Float32Array(vertices * 3),
    uv: new Float32Array(vertices * 2),
    color: new Float32Array(vertices * 3),
    layer: new Float32Array(vertices),
    skinIndex: new Uint16Array(vertices * 4),
    skinWeight: new Float32Array(vertices * 4),
  };
  const index = vertices > 0xffff ? new Uint32Array(indices) : new Uint16Array(indices);
  let vertexOffset = 0;
  let indexOffset = 0;
  for (const part of parts) {
    baked.position.set(part.position, vertexOffset * 3);
    baked.normal.set(part.normal, vertexOffset * 3);
    baked.uv.set(part.uv, vertexOffset * 2);
    baked.color.set(part.color, vertexOffset * 3);
    baked.layer.set(part.layer, vertexOffset);
    baked.skinIndex.set(part.skinIndex, vertexOffset * 4);
    baked.skinWeight.set(part.skinWeight, vertexOffset * 4);
    for (let at = 0; at < part.index.length; at++) index[indexOffset + at] = part.index[at]! + vertexOffset;
    vertexOffset += part.layer.length;
    indexOffset += part.index.length;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(baked.position, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(baked.normal, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(baked.uv, 2));
  geometry.setAttribute('color', new THREE.BufferAttribute(baked.color, 3));
  geometry.setAttribute('layer', new THREE.BufferAttribute(baked.layer, 1));
  geometry.setAttribute('skinIndex', new THREE.BufferAttribute(baked.skinIndex, 4));
  geometry.setAttribute('skinWeight', new THREE.BufferAttribute(baked.skinWeight, 4));
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  return geometry;
}

const WHITE = new THREE.Color(1, 1, 1);

type BaseColourMaterial = THREE.Material & { map?: THREE.Texture | null; color?: THREE.Color };

function materialsOf(mesh: THREE.Mesh): BaseColourMaterial[] {
  return [mesh.material].flat();
}

function materialGroups(mesh: THREE.Mesh, indices: number): THREE.GeometryGroup[] {
  return Array.isArray(mesh.material) ? mesh.geometry.groups : [{ start: 0, count: indices }];
}

function keyOf(texture: THREE.Texture): string | THREE.Texture {
  return texture.name !== '' ? texture.name : texture;
}

/** The body's index of each of the skeleton's joints, matched by the glTF node name; `undefined` when one is not the body's. */
function jointMap(skeleton: THREE.Skeleton, body: THREE.Skeleton): number[] | undefined {
  const bodyIndex = new Map(body.bones.map((bone, index) => [jointName(bone), index]));
  const joints = skeleton.bones.map((bone) => bodyIndex.get(jointName(bone)));
  return joints.every((joint) => joint !== undefined) ? joints : undefined;
}

/** The joint's name in the glTF file, which the loader keeps beside the sanitized, de-duplicated node name. */
function jointName(bone: THREE.Bone): string {
  return (bone.userData['name'] as string | undefined) ?? bone.name;
}

function entry<K extends object, V>(map: WeakMap<K, V>, key: K, make: () => NoInfer<V>): V {
  let value = map.get(key);
  if (value === undefined) {
    value = make();
    map.set(key, value);
  }
  return value;
}
