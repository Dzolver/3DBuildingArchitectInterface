import { wallLength } from './geometry';
import { footprint, isHidden } from './ops';
import { chimneyPieces, roofParts } from './solids';
import { stairParts } from './stairs';
import type { Building, Id, Vec2 } from './types';

export type ElevationSide = 'front' | 'back' | 'left' | 'right';

export const SIDE_LABEL: Record<ElevationSide, string> = {
  front: 'Front (looking north, +y)',
  back: 'Back (looking south, −y)',
  left: 'Left (looking east, +x)',
  right: 'Right (looking west, −x)',
};

/** Screen-horizontal coordinate u and depth (bigger = farther from the viewer). */
export function project(side: ElevationSide, p: Vec2): { u: number; depth: number } {
  switch (side) {
    case 'front':
      return { u: p.x, depth: p.y };
    case 'back':
      return { u: -p.x, depth: -p.y };
    case 'left':
      return { u: -p.y, depth: p.x };
    default:
      return { u: p.y, depth: -p.x };
  }
}

export type Pt = [number, number]; // [u, z]

export interface Drawable {
  kind: 'wall' | 'roof' | 'stair' | 'slab' | 'opening' | 'chimney';
  refId: Id;
  pieceKey?: string;
  floorId: Id;
  outline: Pt[];
  holes: Pt[][];
  /** For openings: door / window / arch styling. */
  openingType?: string;
  depth: number;
  meanDepth: number;
}

function rectPts(u0: number, u1: number, z0: number, z1: number): Pt[] {
  return [[u0, z0], [u1, z0], [u1, z1], [u0, z1]];
}

export function buildElevation(b: Building, side: ElevationSide) {
  const items: Drawable[] = [];
  const P = (p: Vec2) => project(side, p);

  for (const f of b.floors) {
    // floor slab under the floor's footprint
    const fp = footprint(b, f.id);
    if (fp && f.slab > 0) {
      const cs = [{ x: fp.minX, y: fp.minY }, { x: fp.maxX, y: fp.minY }, { x: fp.maxX, y: fp.maxY }, { x: fp.minX, y: fp.maxY }].map(P);
      const us = cs.map((c) => c.u);
      const ds = cs.map((c) => c.depth);
      items.push({ kind: 'slab', refId: f.id, floorId: f.id, outline: rectPts(Math.min(...us), Math.max(...us), f.elevation - f.slab, f.elevation), holes: [], depth: Math.min(...ds), meanDepth: ds.reduce((a, c) => a + c, 0) / 4 });
    }

    for (const w of Object.values(b.walls)) {
      if (w.floorId !== f.id || isHidden(b, w.id)) continue;
      const A = b.corners[w.a];
      const B = b.corners[w.b];
      const len = wallLength(b, w);
      if (len < 1e-6) continue;
      const ux = (B.x - A.x) / len;
      const uy = (B.y - A.y) / len;
      const nx = -uy * (w.thickness / 2);
      const ny = ux * (w.thickness / 2);
      const ex = ux * (w.thickness / 2);
      const ey = uy * (w.thickness / 2);
      const foot = [
        { x: A.x - ex + nx, y: A.y - ey + ny },
        { x: B.x + ex + nx, y: B.y + ey + ny },
        { x: B.x + ex - nx, y: B.y + ey - ny },
        { x: A.x - ex - nx, y: A.y - ey - ny },
      ].map(P);
      const us = foot.map((c) => c.u);
      const ds = foot.map((c) => c.depth);
      const h = w.height ?? f.height;
      const z0 = f.elevation;
      const depth = Math.min(...ds);
      const meanDepth = ds.reduce((a, c) => a + c, 0) / 4;
      const holes: Pt[][] = [];
      const ops = Object.values(b.openings).filter((o) => o.wallId === w.id && !isHidden(b, o.id));
      // skip holes when the wall is seen edge-on
      const pa = P(A);
      const pb = P(B);
      const facing = Math.abs(pb.u - pa.u) / len > 0.2;
      const frames: Drawable[] = [];
      if (facing) {
        for (const o of ops) {
          const s0 = o.offset - o.width / 2;
          const s1 = o.offset + o.width / 2;
          const q0 = P({ x: A.x + ux * s0, y: A.y + uy * s0 });
          const q1 = P({ x: A.x + ux * s1, y: A.y + uy * s1 });
          const u0 = Math.min(q0.u, q1.u);
          const u1 = Math.max(q0.u, q1.u);
          const hole = rectPts(u0, u1, z0 + o.sill, z0 + o.sill + o.height);
          holes.push(hole);
          frames.push({ kind: 'opening', refId: o.id, floorId: f.id, outline: hole, holes: [], openingType: o.type, depth: depth - 1e-4, meanDepth });
        }
      }
      items.push({ kind: 'wall', refId: w.id, floorId: f.id, outline: rectPts(Math.min(...us), Math.max(...us), z0, z0 + h), holes, depth, meanDepth });
      items.push(...frames);
    }

    for (const s of Object.values(b.stairs)) {
      if (s.floorId !== f.id || isHidden(b, s.id)) continue;
      for (const st of stairParts(b, s)) {
        const cs = st.poly.map(P);
        const us = cs.map((c) => c.u);
        const ds = cs.map((c) => c.depth);
        items.push({ kind: 'stair', refId: s.id, floorId: f.id, outline: rectPts(Math.min(...us), Math.max(...us), f.elevation, f.elevation + st.top), holes: [], depth: Math.min(...ds), meanDepth: ds.reduce((a, c) => a + c, 0) / 4 });
      }
    }

    for (const r of Object.values(b.roofs)) {
      if (r.floorId !== f.id || isHidden(b, r.id)) continue;
      for (const piece of roofParts(b, r)) {
        if (r.hiddenPieces.includes(piece.key)) continue;
        for (const part of piece.parts ?? [piece.polygon]) {
          const cs = part.map((v) => ({ ...P(v), z: v.z }));
          const ds = cs.map((c) => c.depth);
          items.push({ kind: 'roof', refId: r.id, pieceKey: piece.key, floorId: f.id, outline: cs.map((c) => [c.u, c.z] as Pt), holes: [], depth: Math.min(...ds), meanDepth: ds.reduce((a, c) => a + c, 0) / ds.length });
        }
      }
    }

    for (const c of Object.values(b.chimneys)) {
      if (c.floorId !== f.id || isHidden(b, c.id)) continue;
      for (const piece of chimneyPieces(b, c)) {
        const o = piece.outline;
        for (let i = 0; i < o.length; i++) {
          const a = P(o[i]);
          const q = P(o[(i + 1) % o.length]);
          if (Math.abs(a.u - q.u) < 1e-6) continue; // face seen edge-on
          items.push({ kind: 'chimney', refId: c.id, pieceKey: piece.key, floorId: f.id, outline: rectPts(Math.min(a.u, q.u), Math.max(a.u, q.u), piece.z0, piece.z1), holes: [], depth: Math.min(a.depth, q.depth), meanDepth: (a.depth + q.depth) / 2 });
        }
      }
    }
  }

  // painter's order: farthest first
  items.sort((p, q) => q.depth - p.depth || q.meanDepth - p.meanDepth);
  const all = items.flatMap((d) => d.outline);
  const bounds = all.length
    ? { minU: Math.min(...all.map((p) => p[0])), maxU: Math.max(...all.map((p) => p[0])), minZ: Math.min(...all.map((p) => p[1])), maxZ: Math.max(...all.map((p) => p[1])) }
    : null;
  return { items, bounds };
}
