/**
 * The marks over the carriers with a quest for the player, an NPC or a fixture, by its carrier id:
 * a gold ! over one who gives a quest they may take on, a gold ? over one a quest of theirs is ready
 * to be turned in at, and a grey ? over one a quest of theirs not finished yet is turned in at. A
 * mark hangs on an NPC's body node beside its model holder, never in it, so no portrait shows it,
 * or on a fixture's anchor, and faces the camera as a plaque does, a gap above the head or the
 * model's top. The marks come from a pool of fixed size, and a carrier past it shows none. They draw
 * with one of three materials, compiled in the scene's prewarm, and add no light.
 */
import * as THREE from 'three';
import type { QuestMarker } from '@somnio/core';
import { OVERLAY_METRES_PER_PIXEL, QUEST_MARK, cssColor, renderOutlinedText } from './overlayArt';

/** The name every mark's mesh carries. */
export const QUEST_MARKER_NAME = 'somnio-quest-marker';

/** How many carriers in view show a mark at once. */
export const QUEST_MARKER_POOL_SIZE = 8;

/** The gold a quest to take on or to turn in is marked in. */
export const QUEST_MARKER_GOLD = 0xffcf40;

/** The muted grey a quest not finished yet is marked in. */
export const QUEST_MARKER_GREY = 0xb8b8b8;

const MARKS: Readonly<Record<QuestMarker, { glyph: string; color: number }>> = {
  offer: { glyph: '!', color: QUEST_MARKER_GOLD },
  turnIn: { glyph: '?', color: QUEST_MARKER_GOLD },
  inProgress: { glyph: '?', color: QUEST_MARKER_GREY },
};

/** How far above the top of the head a mark's foot stands, in metres. */
const HEAD_GAP = 0.2;

interface Mark {
  /** Faces the camera and stands over the head; the mesh inside it rests its foot on its origin. */
  container: THREE.Object3D;
  mesh: THREE.Mesh;
}

/** What each mark is drawn with. */
type MarkArt = Record<QuestMarker, { material: THREE.MeshBasicMaterial; geometry: THREE.PlaneGeometry }>;

export class QuestMarkers {
  private readonly orientation: THREE.Quaternion;
  /** Drawn on first need, so a scene that never marks anyone rasterizes nothing. */
  private drawn: MarkArt | undefined;
  private readonly pool: Mark[] = [];
  /** The mark each carrier shows, and which, by its carrier id. */
  private readonly worn = new Map<string, { mark: Mark; marker: QuestMarker }>();
  private overlayScale = 1;

  constructor(orientation: THREE.Quaternion) {
    this.orientation = orientation;
  }

  /** Hangs the mark on `node`, an NPC's body node or a fixture's anchor, or takes the carrier's mark away for none. */
  show(carrierId: string, node: THREE.Object3D, marker: QuestMarker | undefined): void {
    if (marker === undefined) {
      this.forget(carrierId);
      return;
    }
    const mark = this.worn.get(carrierId)?.mark ?? this.free();
    if (mark === undefined) return;
    this.worn.set(carrierId, { mark, marker });
    mark.mesh.material = this.art[marker].material;
    mark.mesh.geometry = this.art[marker].geometry;
    if (mark.container.parent !== node) node.add(mark.container);
  }

  /** The mark the carrier shows, if any. */
  markerOf(carrierId: string): QuestMarker | undefined {
    return this.worn.get(carrierId)?.marker;
  }

  /** Takes the carrier's mark off and gives it back to the pool. */
  forget(carrierId: string): void {
    this.worn.get(carrierId)?.mark.container.removeFromParent();
    this.worn.delete(carrierId);
  }

  clear(): void {
    for (const carrierId of [...this.worn.keys()]) this.forget(carrierId);
  }

  /** Draws each mark at this many times its size, as the plaques are. */
  setOverlayScale(scale: number): void {
    this.overlayScale = scale;
    for (const { container } of this.pool) container.scale.setScalar(scale);
  }

  /** Stands each mark a gap above its carrier, as tall as `headHeight` says it stands. */
  place(headHeight: (carrierId: string) => number | undefined): void {
    for (const [carrierId, { mark }] of this.worn) mark.container.position.y = (headHeight(carrierId) ?? 0) + HEAD_GAP;
  }

  /** Compiles the marks' program, so the first giver in view compiles nothing. */
  async compile(renderer: Pick<THREE.WebGLRenderer, 'compileAsync'>, camera: THREE.Camera, scene: THREE.Scene): Promise<void> {
    const group = new THREE.Group();
    group.add(...Object.values(this.art).map(({ material, geometry }) => new THREE.Mesh(geometry, material)));
    await renderer.compileAsync(group, camera, scene);
  }

  private get art(): MarkArt {
    this.drawn ??= { offer: markArt(MARKS.offer), turnIn: markArt(MARKS.turnIn), inProgress: markArt(MARKS.inProgress) };
    return this.drawn;
  }

  /** A mark of the pool no carrier shows, made while the pool can grow. */
  private free(): Mark | undefined {
    const worn = new Set([...this.worn.values()].map(({ mark }) => mark));
    const spare = this.pool.find((mark) => !worn.has(mark));
    if (spare !== undefined || this.pool.length >= QUEST_MARKER_POOL_SIZE) return spare;
    const container = new THREE.Object3D();
    container.quaternion.copy(this.orientation);
    container.scale.setScalar(this.overlayScale);
    const mesh = new THREE.Mesh(this.art.offer.geometry, this.art.offer.material);
    mesh.name = QUEST_MARKER_NAME;
    container.add(mesh);
    const mark = { container, mesh };
    this.pool.push(mark);
    return mark;
  }
}

/** The glyph's material in its colour, and a plane as large as its art with its foot on the origin. */
function markArt({ glyph, color }: (typeof MARKS)[QuestMarker]): MarkArt[QuestMarker] {
  const { canvas, widthPixels, heightPixels } = renderOutlinedText(glyph, { ...QUEST_MARK, ink: cssColor(color) });
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const height = heightPixels * OVERLAY_METRES_PER_PIXEL;
  return {
    material: new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, toneMapped: false }),
    geometry: new THREE.PlaneGeometry(widthPixels * OVERLAY_METRES_PER_PIXEL, height).translate(0, height / 2, 0),
  };
}
