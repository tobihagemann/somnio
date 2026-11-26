import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { WARDROBE_LAYERS, WardrobeMaterial, WardrobeTextures, bakeOutfit, preparePiece } from '@/scene/wardrobe';

afterEach(() => vi.restoreAllMocks());

const HAIR_FIT = 'Hayfield courier';

/** A two-joint rig, the head a metre above the hips, under a root scaled per axis as a people's body is. */
function rig(): { root: THREE.Group; hips: THREE.Bone; head: THREE.Bone } {
  const root = new THREE.Group();
  root.scale.set(1.2, 0.9, 1.1);
  const hips = new THREE.Bone();
  hips.name = 'hips';
  const head = new THREE.Bone();
  head.name = 'head';
  head.position.y = 1;
  hips.add(head);
  root.add(hips);
  return { root, hips, head };
}

/**
 * A box from the hips to the head skinned to `bones`, each vertex weighted between the hips and the
 * head by its height, bound where it stands under `parent` with `bones` at rest.
 */
function skinned(
  parent: THREE.Object3D,
  bones: THREE.Bone[],
  material: THREE.Material = new THREE.MeshStandardMaterial(),
  geometry: THREE.BufferGeometry = new THREE.BoxGeometry(0.4, 1, 0.3, 1, 4, 1).translate(0, 0.5, 0),
  place: (mesh: THREE.SkinnedMesh) => void = () => {},
): THREE.SkinnedMesh {
  const hips = bones.findIndex((bone) => bone.name === 'hips');
  const head = bones.findIndex((bone) => bone.name === 'head');
  const positions = geometry.getAttribute('position');
  const indices: number[] = [];
  const weights: number[] = [];
  for (let vertex = 0; vertex < positions.count; vertex++) {
    const up = THREE.MathUtils.clamp(positions.getY(vertex), 0, 1);
    indices.push(hips, head, 0, 0);
    weights.push(1 - up, up, 0, 0);
  }
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(indices, 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights, 4));
  const mesh = new THREE.SkinnedMesh(geometry, material);
  place(mesh);
  parent.add(mesh);
  parent.updateMatrixWorld(true);
  mesh.bind(new THREE.Skeleton(bones));
  return mesh;
}

/** A 2D context that copies a grey image, recording what it was asked to draw. */
function stubCanvas(): unknown[] {
  const drawn: unknown[] = [];
  const context = {
    globalCompositeOperation: 'source-over',
    drawImage: (image: unknown) => drawn.push(image),
    getImageData: (_x: number, _y: number, width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4).fill(200) }),
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
  return drawn;
}

function namedTexture(name: string): THREE.Texture {
  const texture = new THREE.Texture({ width: 4, height: 4 });
  texture.name = name;
  return texture;
}

function worldPositions(mesh: THREE.SkinnedMesh): THREE.Vector3[] {
  return Array.from({ length: mesh.geometry.getAttribute('position').count }, (_, vertex) =>
    mesh.getVertexPosition(vertex, new THREE.Vector3()).applyMatrix4(mesh.matrixWorld),
  );
}

describe('wardrobe bake', () => {
  it('joins prepared parts into one indexed geometry with no groups and one entry per vertex in every attribute', () => {
    const { root, hips, head } = rig();
    const body = skinned(root, [hips, head]);
    const piece = skinned(root, [hips, head], new THREE.MeshStandardMaterial(), new THREE.SphereGeometry(0.3, 6, 4).translate(0, 1, 0));
    const textures = new WardrobeTextures();
    const parts = [preparePiece(body, body, undefined, textures)!, preparePiece(piece, body, undefined, textures)!];

    const baked = bakeOutfit(parts);

    const vertices = body.geometry.getAttribute('position').count + piece.geometry.getAttribute('position').count;
    expect(baked.groups).toEqual([]);
    expect(Object.keys(baked.attributes).sort()).toEqual(['color', 'layer', 'normal', 'position', 'skinIndex', 'skinWeight', 'uv']);
    for (const attribute of Object.values(baked.attributes)) expect(attribute.count).toBe(vertices);
    const index = Array.from(baked.index!.array);
    expect(index).toHaveLength(body.geometry.index!.count + piece.geometry.index!.count);
    expect(Math.max(...index)).toBe(vertices - 1);
    expect(index.slice(body.geometry.index!.count)).toEqual(
      Array.from(piece.geometry.index!.array, (vertex) => vertex + body.geometry.getAttribute('position').count),
    );
  });

  it("maps a piece's joints to the body's by name, whatever order its skeleton lists them in", () => {
    const { root, hips, head } = rig();
    const body = skinned(root, [hips, head]);
    const piece = skinned(root, [head, hips]);

    const prepared = preparePiece(piece, body, undefined, new WardrobeTextures())!;

    const top = Array.from({ length: prepared.layer.length }, (_, vertex) => vertex).find((vertex) => prepared.skinWeight[vertex * 4 + 1] === 1)!;
    expect(Array.from(prepared.skinIndex.slice(top * 4, top * 4 + 2))).toEqual([0, 1]);
    expect(Array.from(piece.geometry.getAttribute('skinIndex').array.slice(top * 4, top * 4 + 2))).toEqual([1, 0]);
  });

  it('poses a piece bound in a frame of its own like the separate piece, once baked onto the body mid-animation', () => {
    const { root, hips, head } = rig();
    const body = skinned(root, [hips, head], undefined, undefined, (mesh) => mesh.position.set(0, 0.05, 0));
    const piece = skinned(root, [head, hips], undefined, undefined, (mesh) => {
      mesh.position.set(0.1, -0.2, 0.05);
      mesh.rotation.y = 0.3;
      mesh.scale.setScalar(0.8);
    });
    hips.rotation.y = 0.4;
    hips.position.x = 0.3;
    head.rotation.z = 0.7;
    root.updateMatrixWorld(true);

    const baked = new THREE.SkinnedMesh(bakeOutfit([preparePiece(piece, body, undefined, new WardrobeTextures())!]), new THREE.MeshStandardMaterial());
    root.add(baked);
    baked.bind(body.skeleton, body.bindMatrix);
    root.updateMatrixWorld(true);

    const expected = worldPositions(piece);
    const actual = worldPositions(baked);
    expect(actual).toHaveLength(expected.length);
    for (const [vertex, position] of actual.entries()) expect(position.distanceTo(expected[vertex]!)).toBeLessThan(1e-6);
    expect(
      Math.max(
        ...expected.map((position, vertex) => position.distanceTo(new THREE.Vector3().fromBufferAttribute(piece.geometry.getAttribute('position'), vertex))),
      ),
    ).toBeGreaterThan(0.1);
  });

  it('adds the hair fit to a mesh that carries it and leaves one without it as it is', () => {
    const { root, hips, head } = rig();
    const geometry = new THREE.BoxGeometry(0.4, 0.3, 0.3).translate(0, 1, 0);
    const vertices = geometry.getAttribute('position').count;
    const tuck = new THREE.Float32BufferAttribute(Array.from({ length: vertices }, () => [0, -0.1, 0]).flat(), 3);
    tuck.name = HAIR_FIT;
    geometry.morphAttributes['position'] = [tuck];
    geometry.morphTargetsRelative = true;
    const crown = skinned(root, [hips, head], undefined, geometry);
    const torso = skinned(root, [hips, head]);
    const textures = new WardrobeTextures();

    const tucked = preparePiece(crown, torso, HAIR_FIT, textures)!;
    const loose = preparePiece(crown, torso, undefined, textures)!;
    const untouched = preparePiece(torso, torso, HAIR_FIT, textures)!;

    const original = Array.from(geometry.getAttribute('position').array);
    expect(Array.from(loose.position)).toEqual(original.map(Math.fround));
    for (const [at, value] of original.entries()) expect(tucked.position[at]).toBeCloseTo(at % 3 === 1 ? value - 0.1 : value, 6);
    expect(Array.from(untouched.position)).toEqual(Array.from(torso.geometry.getAttribute('position').array));
  });

  it('draws an untextured material from no layer in its base colour, and a primitive without uvs at zero', () => {
    const { root, hips, head } = rig();
    const brass = new THREE.MeshStandardMaterial({ color: 0x84491a });
    const geometry = new THREE.BoxGeometry(0.1, 0.1, 0.1).translate(0, 1, 0);
    geometry.deleteAttribute('uv');
    const bracelet = skinned(root, [hips, head], brass, geometry);

    const prepared = preparePiece(bracelet, bracelet, undefined, new WardrobeTextures())!;

    expect(new Set(prepared.layer)).toEqual(new Set([-1]));
    for (let vertex = 0; vertex < prepared.layer.length; vertex++) {
      expect(Array.from(prepared.color.slice(vertex * 3, vertex * 3 + 3))).toEqual([brass.color.r, brass.color.g, brass.color.b].map(Math.fround));
    }
    expect(prepared.uv).toHaveLength(prepared.layer.length * 2);
    expect(prepared.uv.every((value) => value === 0)).toBe(true);
  });

  it('gives a texture one layer that a second piece of the same texture name shares, and a texture past the last layer is a miss', () => {
    const drawn = stubCanvas();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { root, hips, head } = rig();
    const textures = new WardrobeTextures();
    const rogue = namedTexture('rogue_texture');
    const tunic = skinned(root, [hips, head], new THREE.MeshStandardMaterial({ map: rogue }));
    const cape = skinned(root, [hips, head], new THREE.MeshStandardMaterial({ map: namedTexture('rogue_texture') }));

    expect(textures.unplaced(tunic)).toEqual([rogue]);
    const first = preparePiece(tunic, tunic, undefined, textures)!;
    expect(textures.unplaced(cape)).toEqual([]);
    const second = preparePiece(cape, tunic, undefined, textures)!;

    expect(new Set(first.layer)).toEqual(new Set([0]));
    expect(new Set(second.layer)).toEqual(new Set([0]));
    expect(drawn).toHaveLength(1);
    expect(Array.from(first.color.slice(0, 3))).toEqual([1, 1, 1]);
    expect(Array.from(first.uv)).toEqual(Array.from(tunic.geometry.getAttribute('uv').array));
    expect(textures.array.layerUpdates).toEqual(new Set([0]));

    for (let layer = 1; layer < WARDROBE_LAYERS; layer++) expect(textures.place(namedTexture(`study-atlas-${layer}`))).toBe(layer);
    const boots = skinned(root, [hips, head], new THREE.MeshStandardMaterial({ map: namedTexture('one-too-many') }));
    expect(preparePiece(boots, tunic, undefined, textures)).toBeUndefined();
    expect(textures.unplaced(boots)).toEqual([]);
    expect(drawn).toHaveLength(WARDROBE_LAYERS);
  });

  it("lets go of a worn piece's images once their layer holds them or misses, and never of a body's", () => {
    const drawn = stubCanvas();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { root, hips, head } = rig();
    const textures = new WardrobeTextures();
    const image = () => ({ width: 4, height: 4, close: vi.fn() });
    const map = (name: string, source: ReturnType<typeof image>) => Object.assign(new THREE.Texture(source), { name });
    const piece = (name: string, source: ReturnType<typeof image>) => {
      const model = new THREE.Group();
      skinned(model, [hips, head], new THREE.MeshStandardMaterial({ map: map(name, source) }));
      return model;
    };
    const [bodyImage, wornImage, laterImage, missedImage] = [image(), image(), image(), image()];
    const body = skinned(root, [hips, head], new THREE.MeshStandardMaterial({ map: map('atlas', bodyImage) }));

    const worn = piece('atlas', wornImage);
    textures.adopt(worn);
    expect(wornImage.close).not.toHaveBeenCalled();
    preparePiece(body, body, undefined, textures);
    // Copied from the body's own map, which the body still draws with until it is dressed.
    expect(drawn).toEqual([bodyImage]);
    expect([bodyImage.close.mock.calls.length, wornImage.close.mock.calls.length]).toEqual([0, 1]);
    expect((worn.children[0] as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>).material.map!.image).toBeNull();

    textures.adopt(piece('atlas', laterImage));
    expect(laterImage.close).toHaveBeenCalledOnce();

    for (let layer = 1; layer < WARDROBE_LAYERS; layer++) textures.place(namedTexture(`study-atlas-${layer}`));
    const unplaced = piece('one-too-many', missedImage);
    textures.adopt(unplaced);
    expect(textures.place(textures.unplaced(unplaced.children[0] as THREE.Mesh)[0]!)).toBeUndefined();
    expect(missedImage.close).toHaveBeenCalledOnce();

    const afterMiss = image();
    textures.adopt(piece('one-too-many', afterMiss));
    expect(afterMiss.close).toHaveBeenCalledOnce();
  });

  it("patches three's standard shader to read each vertex's layer and sample the texture array", () => {
    const textures = new WardrobeTextures();
    const material = new WardrobeMaterial(textures);
    const shader = {
      uniforms: {},
      vertexShader: THREE.ShaderLib.standard.vertexShader,
      fragmentShader: THREE.ShaderLib.standard.fragmentShader,
    } as unknown as THREE.WebGLProgramParametersWithUniforms;

    material.onBeforeCompile(shader);

    expect(shader.uniforms['wardrobeMap']!.value).toBe(textures.array);
    expect(shader.vertexShader).toContain('vWardrobeLayer = layer;');
    expect(shader.fragmentShader).toContain('texture(wardrobeMap, vec3(vWardrobeUv, vWardrobeLayer))');
    expect(shader.fragmentShader).not.toContain('#include <map_fragment>');
  });
});
