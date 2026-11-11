import { hash2 } from '@somnio/core';

/**
 * The lean of grass under bodies. Each tuft keeps a tilt, a 2-vector in radians toward the
 * ground direction it leans; a body's feet, toes, and lower legs, what its hands hold, and a drop
 * lying on the ground push the tufts they touch, which lean over quickly and spring back slowly
 * once let go.
 */

/**
 * Something that touches grass: a circle on the ground, or, with an `end`, a capsule from its
 * centre to `end`. It leans the tufts it touches at most `lean` radians, by default `MAX_TILT`,
 * at `pressRate` per second, by default `PRESS_RATE`.
 */
export interface GrassContact {
  x: number;
  z: number;
  end?: { x: number; z: number };
  radius: number;
  lean?: number;
  pressRate?: number;
}

/** One batch of tufts: their roots, their half-widths, and the tilts the shader reads, two floats a tuft. */
export interface GrassBatch {
  roots: Float32Array;
  halfWidths: Float32Array;
  tilts: Float32Array;
}

const MAX_TILT = 1;
/** The lean of grass pressed flat, short of the ground so no blade lies in it. */
export const FLAT_TILT = 1.5;
/** How fast a touched tuft leans to its target and a released one comes back, per second. */
const PRESS_RATE = 14;
const RELEASE_RATE = 2.2;
/** How fast a drop landing on grass presses it, per second: at once, as an impact does. */
export const IMPACT_PRESS_RATE = 80;
/** Contacts nearer the root than this lean the tuft its own way, since they have no direction of their own. */
const CENTRED = 0.001;
const BUCKET_METRES = 1;
/** A tilt this small is upright. */
const SETTLED = 1e-4;

export class GrassSpring {
  /** Tufts by 1 m bucket of their root, as batch and index. */
  private readonly buckets = new Map<string, [batch: GrassBatch, index: number][]>();
  /** Tufts not yet upright, by batch, which keep springing back with no contact near. */
  private recovering = new Map<GrassBatch, Set<number>>();

  add(batch: GrassBatch): void {
    for (let index = 0; index < batch.halfWidths.length; index += 1) {
      const key = bucketKey(batch.roots[index * 2]!, batch.roots[index * 2 + 1]!);
      let bucket = this.buckets.get(key);
      if (bucket === undefined) {
        bucket = [];
        this.buckets.set(key, bucket);
      }
      bucket.push([batch, index]);
    }
  }

  /** Forgets the batch's tufts; every other tuft keeps leaning or springing back as it was. */
  remove(batch: GrassBatch): void {
    for (const [key, bucket] of this.buckets) {
      const kept = bucket.filter(([candidate]) => candidate !== batch);
      if (kept.length === 0) this.buckets.delete(key);
      else this.buckets.set(key, kept);
    }
    this.recovering.delete(batch);
  }

  clear(): void {
    this.buckets.clear();
    this.recovering.clear();
  }

  /**
   * Advances every tuft near a contact, or still coming back, by `dt` seconds, and returns the
   * batches whose tilts changed.
   */
  step(contacts: readonly GrassContact[], dt: number): Set<GrassBatch> {
    const release = 1 - Math.exp(-RELEASE_RATE * dt);
    const visit = new Map([...this.recovering].map(([batch, indices]) => [batch, new Set(indices)]));
    for (const contact of contacts) {
      const reach = contact.radius + 0.5;
      const end = contact.end ?? contact;
      for (
        let bx = Math.floor((Math.min(contact.x, end.x) - reach) / BUCKET_METRES);
        bx <= Math.floor((Math.max(contact.x, end.x) + reach) / BUCKET_METRES);
        bx += 1
      ) {
        for (
          let bz = Math.floor((Math.min(contact.z, end.z) - reach) / BUCKET_METRES);
          bz <= Math.floor((Math.max(contact.z, end.z) + reach) / BUCKET_METRES);
          bz += 1
        ) {
          for (const [batch, index] of this.buckets.get(`${bx},${bz}`) ?? []) tuftsOf(visit, batch).add(index);
        }
      }
    }
    const changed = new Set<GrassBatch>();
    const recovering = new Map<GrassBatch, Set<number>>();
    for (const [batch, indices] of visit) {
      const tilts = batch.tilts;
      for (const index of indices) {
        const target = targetTilt(batch, index, contacts);
        const x = tilts[index * 2]!;
        const z = tilts[index * 2 + 1]!;
        const rate = Math.hypot(target.x, target.z) > Math.hypot(x, z) ? 1 - Math.exp(-target.pressRate * dt) : release;
        tilts[index * 2] = x + (target.x - x) * rate;
        tilts[index * 2 + 1] = z + (target.z - z) * rate;
        changed.add(batch);
        if (Math.hypot(tilts[index * 2]!, tilts[index * 2 + 1]!) > SETTLED || target.x !== 0 || target.z !== 0) tuftsOf(recovering, batch).add(index);
        else {
          tilts[index * 2] = 0;
          tilts[index * 2 + 1] = 0;
        }
      }
    }
    this.recovering = recovering;
    return changed;
  }
}

function tuftsOf(tufts: Map<GrassBatch, Set<number>>, batch: GrassBatch): Set<number> {
  let indices = tufts.get(batch);
  if (indices === undefined) {
    indices = new Set();
    tufts.set(batch, indices);
  }
  return indices;
}

/**
 * Where a tuft is pushed: away from the nearest point of every contact over it, deeper in pushing
 * further, at most the greatest `lean` among them, and how fast: the fastest `pressRate` among them.
 */
function targetTilt(batch: GrassBatch, index: number, contacts: readonly GrassContact[]): { x: number; z: number; pressRate: number } {
  const rootX = batch.roots[index * 2]!;
  const rootZ = batch.roots[index * 2 + 1]!;
  let x = 0;
  let z = 0;
  let most = 0;
  let pressRate = PRESS_RATE;
  for (const contact of contacts) {
    const nearest = nearestOn(contact, rootX, rootZ);
    const dx = rootX - nearest.x;
    const dz = rootZ - nearest.z;
    const reach = contact.radius + batch.halfWidths[index]!;
    if (Math.abs(dx) >= reach || Math.abs(dz) >= reach) continue;
    const distance = Math.hypot(dx, dz);
    if (distance >= reach) continue;
    const lean = contact.lean ?? MAX_TILT;
    const depth = (1 - distance / reach) * lean;
    most = Math.max(most, lean);
    pressRate = Math.max(pressRate, contact.pressRate ?? PRESS_RATE);
    if (distance < CENTRED) {
      const angle = hash2(Math.round(rootX * 1000), Math.round(rootZ * 1000), 0) * Math.PI * 2;
      x += Math.cos(angle) * depth;
      z += Math.sin(angle) * depth;
    } else {
      x += (dx / distance) * depth;
      z += (dz / distance) * depth;
    }
  }
  const length = Math.hypot(x, z);
  if (length === 0) return { x: 0, z: 0, pressRate };
  const scale = Math.min(most, length * 1.5) / length;
  return { x: x * scale, z: z * scale, pressRate };
}

/** The point of the contact nearest the root: its centre, or the nearest point of its capsule's segment. */
function nearestOn(contact: GrassContact, rootX: number, rootZ: number): { x: number; z: number } {
  if (contact.end === undefined) return contact;
  const alongX = contact.end.x - contact.x;
  const alongZ = contact.end.z - contact.z;
  const lengthSquared = alongX * alongX + alongZ * alongZ;
  const share = lengthSquared === 0 ? 0 : Math.min(1, Math.max(0, ((rootX - contact.x) * alongX + (rootZ - contact.z) * alongZ) / lengthSquared));
  return { x: contact.x + alongX * share, z: contact.z + alongZ * share };
}

function bucketKey(x: number, z: number): string {
  return `${Math.floor(x / BUCKET_METRES)},${Math.floor(z / BUCKET_METRES)}`;
}
