import type { Building, Corner, Id, Vec2, Wall } from './types';

export const EPS = 1e-6;
/** Positions closer than this (m) are treated as the same point. */
export const MERGE_DIST = 0.01;

let counter = 0;
export function uid(prefix: string): Id {
  counter = (counter + 1) % 1e6;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

export const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);
export const snap = (v: number, step: number) => Math.round(v / step) * step;
/** Round to 1 mm to avoid float drift in stored numbers. */
export const mm = (v: number) => Math.round(v * 1000) / 1000;

export function signedArea(poly: Vec2[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    s += p.x * q.y - q.x * p.y;
  }
  return s / 2;
}

export function centroid(poly: Vec2[]): Vec2 {
  const a = signedArea(poly);
  if (Math.abs(a) < EPS) {
    const n = poly.length || 1;
    return { x: poly.reduce((s, p) => s + p.x, 0) / n, y: poly.reduce((s, p) => s + p.y, 0) / n };
  }
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const f = p.x * q.y - q.x * p.y;
    cx += (p.x + q.x) * f;
    cy += (p.y + q.y) * f;
  }
  return { x: cx / (6 * a), y: cy / (6 * a) };
}

export function pointInPolygon(p: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Projection of p onto segment ab: parameter t (0..1) and distance. */
export function projectOnSegment(p: Vec2, a: Vec2, b: Vec2) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 < EPS ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  const q = { x: a.x + t * dx, y: a.y + t * dy };
  return { t, point: q, d: dist(p, q) };
}

/** Intersection of segments p1p2 and p3p4 (proper or touching). Returns params along each. */
export function segmentIntersection(p1: Vec2, p2: Vec2, p3: Vec2, p4: Vec2) {
  const d = (p2.x - p1.x) * (p4.y - p3.y) - (p2.y - p1.y) * (p4.x - p3.x);
  if (Math.abs(d) < EPS) return null; // parallel / collinear
  const t = ((p3.x - p1.x) * (p4.y - p3.y) - (p3.y - p1.y) * (p4.x - p3.x)) / d;
  const u = ((p3.x - p1.x) * (p2.y - p1.y) - (p3.y - p1.y) * (p2.x - p1.x)) / d;
  if (t < -EPS || t > 1 + EPS || u < -EPS || u > 1 + EPS) return null;
  return { t, u, point: { x: p1.x + t * (p2.x - p1.x), y: p1.y + t * (p2.y - p1.y) } };
}

/** Offset a counter-clockwise polygon inward by d (each edge may have its own offset). */
export function insetPolygon(poly: Vec2[], d: number | number[]): Vec2[] {
  const n = poly.length;
  if (n < 3) return poly;
  const off = (i: number) => (Array.isArray(d) ? d[i] : d);
  const lines = poly.map((p, i) => {
    const q = poly[(i + 1) % n];
    const len = dist(p, q) || 1;
    // inward normal of a CCW polygon is the left normal
    const nx = -(q.y - p.y) / len;
    const ny = (q.x - p.x) / len;
    return { p: { x: p.x + nx * off(i), y: p.y + ny * off(i) }, dir: { x: q.x - p.x, y: q.y - p.y } };
  });
  return lines.map((l, i) => {
    const prev = lines[(i - 1 + n) % n];
    const cross = prev.dir.x * l.dir.y - prev.dir.y * l.dir.x;
    if (Math.abs(cross) < EPS) return l.p; // collinear edges
    const t = ((l.p.x - prev.p.x) * l.dir.y - (l.p.y - prev.p.y) * l.dir.x) / cross;
    return { x: prev.p.x + t * prev.dir.x, y: prev.p.y + t * prev.dir.y };
  });
}

export function wallsOnFloor(b: Building, floorId: Id): Wall[] {
  return Object.values(b.walls).filter((w) => w.floorId === floorId);
}

export function wallLength(b: Building, w: Wall): number {
  return dist(b.corners[w.a], b.corners[w.b]);
}

export interface Face {
  cornerIds: Id[];
  wallIds: Id[];
  polygon: Vec2[]; // CCW, wall centrelines
}

/**
 * Find the enclosed regions (rooms) formed by walls on one floor, using a planar
 * half-edge walk. Dangling walls are ignored. Returns bounded faces only (CCW).
 */
export function findFaces(b: Building, floorId: Id): Face[] {
  const walls = wallsOnFloor(b, floorId);
  // adjacency, then prune dangling vertices
  const adj = new Map<Id, Map<Id, Id>>(); // corner -> (neighbour -> wallId)
  for (const w of walls) {
    if (w.a === w.b) continue;
    if (!adj.has(w.a)) adj.set(w.a, new Map());
    if (!adj.has(w.b)) adj.set(w.b, new Map());
    adj.get(w.a)!.set(w.b, w.id);
    adj.get(w.b)!.set(w.a, w.id);
  }
  let pruned = true;
  while (pruned) {
    pruned = false;
    for (const [v, nb] of adj) {
      if (nb.size <= 1) {
        for (const u of nb.keys()) adj.get(u)?.delete(v);
        adj.delete(v);
        pruned = true;
      }
    }
  }
  // sort neighbours CCW by angle
  const sorted = new Map<Id, Id[]>();
  for (const [v, nb] of adj) {
    const c = b.corners[v];
    sorted.set(
      v,
      [...nb.keys()].sort((p, q) => {
        const cp = b.corners[p];
        const cq = b.corners[q];
        return Math.atan2(cp.y - c.y, cp.x - c.x) - Math.atan2(cq.y - c.y, cq.x - c.x);
      }),
    );
  }
  const visited = new Set<string>();
  const faces: Face[] = [];
  for (const [u, nbs] of sorted) {
    for (const v of nbs) {
      const startKey = `${u}>${v}`;
      if (visited.has(startKey)) continue;
      const cornerIds: Id[] = [];
      const wallIds: Id[] = [];
      let a = u;
      let c = v;
      let guard = 0;
      while (guard++ < 10000) {
        const key = `${a}>${c}`;
        if (visited.has(key)) break;
        visited.add(key);
        cornerIds.push(a);
        wallIds.push(adj.get(a)!.get(c)!);
        // at c, next edge = the neighbour just clockwise of a
        const list = sorted.get(c)!;
        const i = list.indexOf(a);
        const next = list[(i - 1 + list.length) % list.length];
        a = c;
        c = next;
      }
      const polygon = cornerIds.map((id) => ({ x: b.corners[id].x, y: b.corners[id].y }));
      if (cornerIds.length >= 3 && signedArea(polygon) > 1e-4) faces.push({ cornerIds, wallIds, polygon });
    }
  }
  return faces;
}

export function faceKey(cornerIds: Id[]): string {
  return [...cornerIds].sort().join('|');
}

/** Clear interior polygon of a room: centreline polygon inset by half of each wall's thickness. */
export function roomInterior(b: Building, face: Face): Vec2[] {
  return insetPolygon(
    face.polygon,
    face.wallIds.map((id) => b.walls[id].thickness / 2),
  );
}

export function bbox(poly: Vec2[]) {
  const xs = poly.map((p) => p.x);
  const ys = poly.map((p) => p.y);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

export function cornerAt(b: Building, floorId: Id, p: Vec2, tol = MERGE_DIST): Corner | undefined {
  let best: Corner | undefined;
  let bestD = tol;
  for (const c of Object.values(b.corners)) {
    if (c.floorId !== floorId) continue;
    const d = dist(c, p);
    if (d <= bestD) {
      best = c;
      bestD = d;
    }
  }
  return best;
}

/** Corners (CCW) of a rectangle given by min corner + size, turned `angle` degrees around its centre. */
export function rotRect(r: { x: number; y: number; w: number; d: number; angle?: number }, grow = 0): Vec2[] {
  const cx = r.x + r.w / 2;
  const cy = r.y + r.d / 2;
  const a = ((r.angle ?? 0) * Math.PI) / 180;
  const hw = r.w / 2 + grow;
  const hd = r.d / 2 + grow;
  return [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map(([u, v]) => ({ x: cx + u * Math.cos(a) - v * Math.sin(a), y: cy + u * Math.sin(a) + v * Math.cos(a) }));
}

/** Is a polygon convex (either winding)? */
export function isConvex(poly: Vec2[]): boolean {
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const c = poly[(i + 2) % poly.length];
    const z = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(z) < 1e-9) continue;
    if (sign && Math.sign(z) !== sign) return false;
    sign = Math.sign(z);
  }
  return true;
}

/** Part of `subject` inside the convex polygon `clipper` (Sutherland–Hodgman). */
export function clipToConvex(subject: Vec2[], clipper: Vec2[]): Vec2[] {
  const ccwClip = signedArea(clipper) >= 0 ? clipper : [...clipper].reverse();
  let out = subject;
  for (let i = 0; i < ccwClip.length && out.length; i++) {
    const a = ccwClip[i];
    const b = ccwClip[(i + 1) % ccwClip.length];
    const side = (p: Vec2) => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    const input = out;
    out = [];
    for (let j = 0; j < input.length; j++) {
      const p = input[j];
      const q = input[(j + 1) % input.length];
      const sp = side(p);
      const sq = side(q);
      if (sp >= 0) out.push(p);
      if ((sp >= 0) !== (sq >= 0)) {
        const t = sp / (sp - sq);
        out.push({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
      }
    }
  }
  return out;
}
