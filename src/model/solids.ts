// Convex solids and polygon clipping, used to trim roofs where they run into each other
// (forming valleys) and around chimneys.
import { roofBaseZ, roofPieces, type RoofPiece } from './roof';
import { isHidden } from './ops';
import type { Building, Chimney, Id, Roof, Vec2, Vec3 } from './types';

/** Half-space n·p <= d (inside). */
export interface Plane {
  n: Vec3;
  d: number;
}
export type Solid = Plane[];

const EPS = 1e-4;
const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;

function newellNormal(poly: Vec3[]): Vec3 {
  const n = { x: 0, y: 0, z: 0 };
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    n.x += (p.y - q.y) * (p.z + q.z);
    n.y += (p.z - q.z) * (p.x + q.x);
    n.z += (p.x - q.x) * (p.y + q.y);
  }
  const l = Math.hypot(n.x, n.y, n.z) || 1;
  return { x: n.x / l, y: n.y / l, z: n.z / l };
}

export function polygonArea3(poly: Vec3[]): number {
  const n = { x: 0, y: 0, z: 0 };
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    n.x += p.y * q.z - p.z * q.y;
    n.y += p.z * q.x - p.x * q.z;
    n.z += p.x * q.y - p.y * q.x;
  }
  return Math.hypot(n.x, n.y, n.z) / 2;
}

/** Keep the part of a convex polygon where n·p - d <= 0 (or >= 0 when `keepOutside`). */
function clip(poly: Vec3[], pl: Plane, keepOutside: boolean): Vec3[] {
  const out: Vec3[] = [];
  // coplanar-ish points count as outside, so touching surfaces never eat each other
  const s = (p: Vec3) => {
    const v = dot(pl.n, p) - pl.d;
    return keepOutside ? -v - EPS : v + EPS; // <= 0 means keep
  };
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const sa = s(a);
    const sb = s(b);
    if (sa <= 0) out.push(a);
    if ((sa < 0 && sb > 0) || (sa > 0 && sb < 0)) {
      const t = sa / (sa - sb);
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t });
    }
  }
  return out.length >= 3 && polygonArea3(out) > 1e-6 ? out : [];
}

/** Parts of a convex polygon that lie outside a convex solid (each part convex). */
export function subtract(poly: Vec3[], solid: Solid): Vec3[][] {
  const parts: Vec3[][] = [];
  let cur = poly;
  for (const pl of solid) {
    const outside = clip(cur, pl, true);
    if (outside.length) parts.push(outside);
    cur = clip(cur, pl, false);
    if (!cur.length) return parts;
  }
  return parts; // whatever is left in `cur` is inside the solid and is dropped
}

/** Vertical prism over a convex plan polygon (CCW), between z0 and z1. */
function prism(poly: Vec2[], z0: number, z1: number): Solid {
  const planes: Solid = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const ex = q.x - p.x;
    const ey = q.y - p.y;
    const l = Math.hypot(ex, ey) || 1;
    const n = { x: ey / l, y: -ex / l, z: 0 }; // outward for CCW
    planes.push({ n, d: n.x * p.x + n.y * p.y });
  }
  planes.push({ n: { x: 0, y: 0, z: 1 }, d: z1 });
  planes.push({ n: { x: 0, y: 0, z: -1 }, d: -z0 });
  return planes;
}

function ccw(poly: Vec2[]): Vec2[] {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a >= 0 ? poly : [...poly].reverse();
}

/** Plan rectangle of a roof (rotated), optionally grown by its overhang. */
export function roofRect(r: Roof, grow = 0): Vec2[] {
  const cx = r.x + r.w / 2;
  const cy = r.y + r.d / 2;
  const a = ((r.angle ?? 0) * Math.PI) / 180;
  const hw = r.w / 2 + grow;
  const hd = r.d / 2 + grow;
  return [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map(([u, v]) => ({ x: cx + u * Math.cos(a) - v * Math.sin(a), y: cy + u * Math.sin(a) + v * Math.cos(a) }));
}

/**
 * The volume a roof occupies: under its slopes, inside its eaves outline, plus the house
 * volume under it (inside its walls, below the eaves). Two convex solids.
 */
export function roofSolids(b: Building, r: Roof, pieces = roofPieces(b, r)): Solid[] {
  const base = roofBaseZ(b, r);
  const rect = ccw(roofRect(r, r.overhang));
  const zs = pieces.flatMap((p) => p.polygon.map((v) => v.z));
  const zMin = Math.min(...zs);
  const above: Solid = prism(rect, zMin, Math.max(...zs) + 1).slice(0, -2);
  above.push({ n: { x: 0, y: 0, z: -1 }, d: -zMin });
  for (const p of pieces) {
    if (p.kind !== 'slope' && p.kind !== 'slab') continue;
    let n = newellNormal(p.polygon);
    if (n.z < 0) n = { x: -n.x, y: -n.y, z: -n.z };
    if (n.z < 1e-6) continue;
    above.push({ n, d: dot(n, p.polygon[0]) });
  }
  const f = b.floors.find((x) => x.id === r.floorId);
  const below = prism(ccw(roofRect(r, 0)), f ? f.elevation : 0, base);
  return [above, below];
}

export interface ChimneyPiece {
  key: 'stack' | 'crown';
  /** Plan outline (CCW) and vertical extent. */
  outline: Vec2[];
  z0: number;
  z1: number;
}

export function chimneyRect(c: Chimney, grow = 0): Vec2[] {
  const a = (c.angle * Math.PI) / 180;
  const hw = c.w / 2 + grow;
  const hd = c.d / 2 + grow;
  return [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map(([u, v]) => ({ x: c.x + u * Math.cos(a) - v * Math.sin(a), y: c.y + u * Math.sin(a) + v * Math.cos(a) }));
}

/** Highest roof surface under a plan point (over the given roof solids), or null. */
function roofHeightAt(p: Vec2, aboves: Solid[]): number | null {
  let best: number | null = null;
  for (const above of aboves) {
    let z = Infinity;
    let inside = true;
    for (const pl of above) {
      if (Math.abs(pl.n.z) < 1e-9) {
        if (pl.n.x * p.x + pl.n.y * p.y > pl.d + 1e-9) inside = false;
      } else if (pl.n.z > 0) z = Math.min(z, (pl.d - pl.n.x * p.x - pl.n.y * p.y) / pl.n.z);
    }
    if (inside && Number.isFinite(z)) best = best === null ? z : Math.max(best, z);
  }
  return best;
}

/** Horizontal reach and extra height of the "3-2-10" chimney rule, in metres. */
export const CHIMNEY_REACH = 3;
export const CHIMNEY_ABOVE_NEARBY = 0.6;

/**
 * Auto top follows the usual 3-2-10 rule: `clearance` above the highest point where the stack
 * leaves the roof, and 0.6 m above any roof surface within 3 m of the stack.
 */
const topCache = new WeakMap<Building, Map<Id, number>>();

export function chimneyTop(b: Building, c: Chimney): number {
  if (c.top !== null) return c.top;
  let m = topCache.get(b);
  if (!m) topCache.set(b, (m = new Map()));
  // the cache is per building snapshot; key on the chimney's own fields too, since tests mutate
  const key = `${c.id}|${c.x}|${c.y}|${c.w}|${c.d}|${c.angle}|${c.clearance}|${c.floorId}`;
  const hit = m.get(key as Id);
  if (hit !== undefined) return hit;
  const v = autoTop(b, c);
  m.set(key as Id, v);
  return v;
}

function autoTop(b: Building, c: Chimney): number {
  const aboves = Object.values(b.roofs).filter((r) => !isHidden(b, r.id)).map((r) => roofSolids(b, r)[0]);
  const corners = chimneyRect(c);
  const at = corners.map((p) => roofHeightAt(p, aboves)).filter((h): h is number => h !== null);
  const a = (c.angle * Math.PI) / 180;
  // highest roof within reach: coarse grid, then refine around the best sample
  const sample = (u: number, v: number) => {
    const du = Math.max(0, Math.abs(u) - c.w / 2);
    const dv = Math.max(0, Math.abs(v) - c.d / 2);
    if (Math.hypot(du, dv) > CHIMNEY_REACH + 1e-9) return null;
    return roofHeightAt({ x: c.x + u * Math.cos(a) - v * Math.sin(a), y: c.y + u * Math.sin(a) + v * Math.cos(a) }, aboves);
  };
  let near: number | null = null;
  let bu = 0;
  let bv = 0;
  const hw = c.w / 2 + CHIMNEY_REACH;
  const hd = c.d / 2 + CHIMNEY_REACH;
  for (let u = -hw; u <= hw + 1e-9; u += 0.25) {
    for (let v = -hd; v <= hd + 1e-9; v += 0.25) {
      const h = sample(u, v);
      if (h !== null && (near === null || h > near)) [near, bu, bv] = [h, u, v];
    }
  }
  for (const st of [0.05, 0.01, 0.002]) {
    const [cu, cv] = [bu, bv];
    for (let i = -6; i <= 6; i++) {
      for (let j = -6; j <= 6; j++) {
        const h = sample(cu + i * st, cv + j * st);
        if (h !== null && near !== null && h > near) [near, bu, bv] = [h, cu + i * st, cv + j * st];
      }
    }
  }
  const tops = [...(at.length ? [Math.max(...at) + c.clearance] : []), ...(near !== null ? [near + CHIMNEY_ABOVE_NEARBY] : [])];
  if (tops.length) return Math.round(Math.max(...tops) * 1000) / 1000;
  // no roof over or near it: clear the top of the highest floor
  const f = b.floors.find((x) => x.id === c.floorId);
  const top = b.floors[b.floors.length - 1];
  return (top ? top.elevation + top.height : f ? f.elevation + f.height : 3) + c.clearance;
}

export function chimneyPieces(b: Building, c: Chimney): ChimneyPiece[] {
  const f = b.floors.find((x) => x.id === c.floorId);
  const z0 = f ? f.elevation : 0;
  const top = chimneyTop(b, c);
  const crownH = c.crown ? 0.15 : 0;
  const pieces: ChimneyPiece[] = [{ key: 'stack', outline: ccw(chimneyRect(c)), z0, z1: top - crownH }];
  if (c.crown) pieces.push({ key: 'crown', outline: ccw(chimneyRect(c, 0.06)), z0: top - crownH, z1: top });
  return pieces;
}

export function chimneySolid(b: Building, c: Chimney): Solid {
  const p = chimneyPieces(b, c);
  return prism(ccw(chimneyRect(c)), p[0].z0, p[p.length - 1].z1);
}

export interface ResolvedRoof {
  roof: Roof;
  pieces: RoofPiece[];
  /** Roofs and chimneys that cut into this roof. */
  trimmedBy: Id[];
}

/**
 * Every roof's pieces with `parts` set: each piece minus the volume of every other roof and
 * every chimney (when the roof's `trim` is on). This is what makes overlapping roofs meet in
 * valleys instead of passing through each other.
 */
const cache = new WeakMap<Building, Map<Id, ResolvedRoof>>();

/** resolveRoofs, cached per building snapshot (each edit makes a new snapshot). */
export function resolvedRoofs(b: Building): Map<Id, ResolvedRoof> {
  let m = cache.get(b);
  if (!m) cache.set(b, (m = resolveRoofs(b)));
  return m;
}

/** Visible, trimmed parts of every piece of a roof (hidden pieces left out unless asked). */
export function roofParts(b: Building, r: Roof): RoofPiece[] {
  return resolvedRoofs(b).get(r.id)?.pieces ?? roofPieces(b, r).map((p) => ({ ...p, parts: [p.polygon] }));
}

export function resolveRoofs(b: Building): Map<Id, ResolvedRoof> {
  const roofs = Object.values(b.roofs).filter((r) => !isHidden(b, r.id));
  const raw = new Map(roofs.map((r) => [r.id, roofPieces(b, r)]));
  const solids = new Map(roofs.map((r) => [r.id, roofSolids(b, r, raw.get(r.id))]));
  const chim = Object.values(b.chimneys).filter((c) => !isHidden(b, c.id)).map((c) => ({ id: c.id, solid: chimneySolid(b, c) }));
  const out = new Map<Id, ResolvedRoof>();
  for (const r of Object.values(b.roofs)) {
    const pieces = (raw.get(r.id) ?? roofPieces(b, r)).map((p) => ({ ...p, parts: [p.polygon] }));
    const trimmedBy = new Set<Id>();
    if (r.trim !== false && raw.has(r.id)) {
      const cutters: { id: Id; solid: Solid }[] = [
        ...roofs.filter((o) => o.id !== r.id).flatMap((o) => solids.get(o.id)!.map((solid) => ({ id: o.id, solid }))),
        ...chim,
      ];
      for (const p of pieces) {
        for (const cut of cutters) {
          const next = p.parts!.flatMap((part) => subtract(part, cut.solid));
          const before = p.parts!.reduce((s, q) => s + polygonArea3(q), 0);
          const after = next.reduce((s, q) => s + polygonArea3(q), 0);
          if (before - after > 1e-4) trimmedBy.add(cut.id);
          p.parts = next;
        }
      }
    }
    out.set(r.id, { roof: r, pieces, trimmedBy: [...trimmedBy] });
  }
  return out;
}

/**
 * Outline edges of a trimmed piece: the edges of its parts, minus the seams where one part
 * meets another part of the same piece (those are only a by-product of the cut).
 */
export function planOutline(parts: Vec3[][]): [Vec3, Vec3][] {
  if (!parts.length) return [];
  // work in the 2D plane the piece faces most (drop the normal's largest axis)
  const n = newellNormal(parts[0]);
  const ax = Math.abs(n.x);
  const ay = Math.abs(n.y);
  const az = Math.abs(n.z);
  const flat = (p: Vec3): Vec2 => (az >= ax && az >= ay ? { x: p.x, y: p.y } : ax >= ay ? { x: p.y, y: p.z } : { x: p.x, y: p.z });
  const polys = parts.map((q) => q.map(flat));
  const inside = (p: Vec2) =>
    polys.some((poly) => {
      let c = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const a = poly[i];
        const q = poly[j];
        if (a.y > p.y !== q.y > p.y && p.x < ((q.x - a.x) * (p.y - a.y)) / (q.y - a.y) + a.x) c = !c;
      }
      return c;
    });
  const out: [Vec3, Vec3][] = [];
  parts.forEach((poly, k) => {
    const fp = polys[k];
    for (let i = 0; i < poly.length; i++) {
      const a = fp[i];
      const q = fp[(i + 1) % fp.length];
      const l = Math.hypot(q.x - a.x, q.y - a.y);
      if (l < 1e-6) continue;
      const m = { x: (a.x + q.x) / 2, y: (a.y + q.y) / 2 };
      const e = 0.01;
      const off = { x: (-(q.y - a.y) / l) * e, y: ((q.x - a.x) / l) * e };
      if (inside({ x: m.x + off.x, y: m.y + off.y }) && inside({ x: m.x - off.x, y: m.y - off.y })) continue;
      out.push([poly[i], poly[(i + 1) % poly.length]]);
    }
  });
  return out;
}
