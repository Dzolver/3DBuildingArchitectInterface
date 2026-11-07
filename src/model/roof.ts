import type { Building, Roof, Vec3 } from './types';

export interface RoofPiece {
  /** Visible parts after trimming against other roofs and chimneys (filled in by resolveRoofs). */
  parts?: Vec3[][];
  /** Stable key within the roof, used for hiding (e.g. "slope-front"). */
  key: string;
  label: string;
  kind: 'slope' | 'gable' | 'slab' | 'parapet' | 'fascia';
  /** Planar convex polygon in world metres (x, y plan; z up). */
  polygon: Vec3[];
}

export function roofBaseZ(b: Building, r: Roof): number {
  const f = b.floors.find((x) => x.id === r.floorId);
  if (!f) return 0;
  return f.elevation + (r.base ?? f.height);
}

/**
 * Build roof pieces in a local frame where the ridge runs along local X (length L) and the
 * span is along local Y (width S), then rotate into the world. All pieces are convex.
 */
export function roofPieces(b: Building, r: Roof): RoofPiece[] {
  const z0 = roofBaseZ(b, r);
  const t = Math.tan((r.pitch * Math.PI) / 180);
  const o = r.overhang;
  const along = r.dir === 0 || r.dir === 180; // ridge along world x
  const L = along ? r.w : r.d;
  const S = along ? r.d : r.w;
  const cx = r.x + r.w / 2;
  const cy = r.y + r.d / 2;
  // local (u along ridge, v across, z) -> footprint frame -> rotated world
  const ang = ((r.angle ?? 0) * Math.PI) / 180;
  const ca = Math.cos(ang);
  const sa = Math.sin(ang);
  const toWorld = (u: number, v: number, z: number): Vec3 => {
    let dx: number;
    let dy: number;
    switch (r.dir) {
      case 0:
        [dx, dy] = [u, v];
        break;
      case 90:
        [dx, dy] = [-v, u];
        break;
      case 180:
        [dx, dy] = [-u, -v];
        break;
      default:
        [dx, dy] = [v, -u];
    }
    return { x: cx + dx * ca - dy * sa, y: cy + dx * sa + dy * ca, z };
  };
  const P = (pts: [number, number, number][]) => pts.map(([u, v, z]) => toWorld(u, v, z));
  const hl = L / 2;
  const hs = S / 2;
  const pieces: RoofPiece[] = [];
  // local side names: v = -hs is "front" side of the ridge, v = +hs "back"; u = -hl "left" end, +hl "right" end
  const sideName = (local: 'front' | 'back' | 'left' | 'right') => local;

  if (r.type === 'gable') {
    const zr = z0 + hs * t;
    const ze = z0 - o * t;
    pieces.push({ key: 'slope-front', label: 'Slope (front)', kind: 'slope', polygon: P([[-hl - o, -hs - o, ze], [hl + o, -hs - o, ze], [hl + o, 0, zr], [-hl - o, 0, zr]]) });
    pieces.push({ key: 'slope-back', label: 'Slope (back)', kind: 'slope', polygon: P([[hl + o, hs + o, ze], [-hl - o, hs + o, ze], [-hl - o, 0, zr], [hl + o, 0, zr]]) });
    pieces.push({ key: 'gable-left', label: 'Gable end (left)', kind: 'gable', polygon: P([[-hl, -hs, z0], [-hl, hs, z0], [-hl, 0, zr]]) });
    pieces.push({ key: 'gable-right', label: 'Gable end (right)', kind: 'gable', polygon: P([[hl, hs, z0], [hl, -hs, z0], [hl, 0, zr]]) });
  } else if (r.type === 'hip') {
    // ridge along the longer side; in the local frame L is the ridge direction
    const half = Math.min(hl, hs);
    const zr = z0 + half * t;
    const ze = z0 - o * t;
    const ridge = Math.max(0, hl - hs);
    const Lo = hl + o;
    const So = hs + o;
    if (hl >= hs) {
      pieces.push({ key: 'slope-front', label: 'Slope (front)', kind: 'slope', polygon: P([[-Lo, -So, ze], [Lo, -So, ze], [ridge, 0, zr], [-ridge, 0, zr]]) });
      pieces.push({ key: 'slope-back', label: 'Slope (back)', kind: 'slope', polygon: P([[Lo, So, ze], [-Lo, So, ze], [-ridge, 0, zr], [ridge, 0, zr]]) });
      pieces.push({ key: 'hip-left', label: 'Hip (left)', kind: 'slope', polygon: P([[-Lo, So, ze], [-Lo, -So, ze], [-ridge, 0, zr]]) });
      pieces.push({ key: 'hip-right', label: 'Hip (right)', kind: 'slope', polygon: P([[Lo, -So, ze], [Lo, So, ze], [ridge, 0, zr]]) });
    } else {
      const rv = hs - hl;
      pieces.push({ key: 'slope-front', label: 'Slope (front)', kind: 'slope', polygon: P([[-Lo, -So, ze], [Lo, -So, ze], [0, -rv, zr]]) });
      pieces.push({ key: 'slope-back', label: 'Slope (back)', kind: 'slope', polygon: P([[Lo, So, ze], [-Lo, So, ze], [0, rv, zr]]) });
      pieces.push({ key: 'hip-left', label: 'Hip (left)', kind: 'slope', polygon: P([[-Lo, So, ze], [-Lo, -So, ze], [0, -rv, zr], [0, rv, zr]]) });
      pieces.push({ key: 'hip-right', label: 'Hip (right)', kind: 'slope', polygon: P([[Lo, -So, ze], [Lo, So, ze], [0, rv, zr], [0, -rv, zr]]) });
    }
  } else if (r.type === 'shed') {
    // high side at local +v
    const zLow = z0 - o * t;
    const zHigh = z0 + (S + o) * t;
    const zWall = z0 + S * t;
    pieces.push({ key: 'slope', label: 'Slope', kind: 'slope', polygon: P([[-hl - o, -hs - o, zLow], [hl + o, -hs - o, zLow], [hl + o, hs + o, zHigh], [-hl - o, hs + o, zHigh]]) });
    pieces.push({ key: 'side-left', label: 'Side infill (left)', kind: 'gable', polygon: P([[-hl, -hs, z0], [-hl, hs, z0], [-hl, hs, zWall]]) });
    pieces.push({ key: 'side-right', label: 'Side infill (right)', kind: 'gable', polygon: P([[hl, hs, z0], [hl, -hs, z0], [hl, hs, zWall]]) });
    pieces.push({ key: 'high-wall', label: 'High wall infill', kind: 'gable', polygon: P([[-hl, hs, z0], [hl, hs, z0], [hl, hs, zWall], [-hl, hs, zWall]]) });
  } else if (r.type === 'gambrel') {
    // barn roof: steep lower slopes to a knee, shallow upper slopes to the ridge
    const lowT = Math.tan((60 * Math.PI) / 180); // lower slopes at 60 degrees, upper slopes at the roof pitch
    const kneeV = hs * 0.45; // knee sits 55% of the way in from the eaves
    const zk = z0 + (hs - kneeV) * lowT;
    const zr = zk + kneeV * t;
    const ze = z0 - o * lowT;
    pieces.push({ key: 'lower-front', label: 'Lower slope (front)', kind: 'slope', polygon: P([[-hl - o, -hs - o, ze], [hl + o, -hs - o, ze], [hl + o, -kneeV, zk], [-hl - o, -kneeV, zk]]) });
    pieces.push({ key: 'upper-front', label: 'Upper slope (front)', kind: 'slope', polygon: P([[-hl - o, -kneeV, zk], [hl + o, -kneeV, zk], [hl + o, 0, zr], [-hl - o, 0, zr]]) });
    pieces.push({ key: 'upper-back', label: 'Upper slope (back)', kind: 'slope', polygon: P([[hl + o, kneeV, zk], [-hl - o, kneeV, zk], [-hl - o, 0, zr], [hl + o, 0, zr]]) });
    pieces.push({ key: 'lower-back', label: 'Lower slope (back)', kind: 'slope', polygon: P([[hl + o, hs + o, ze], [-hl - o, hs + o, ze], [-hl - o, kneeV, zk], [hl + o, kneeV, zk]]) });
    for (const [key, label, u] of [['gable-left', 'Gable end (left)', -hl], ['gable-right', 'Gable end (right)', hl]] as const) {
      const pts: [number, number, number][] = [[u, -hs, z0], [u, -kneeV, zk], [u, 0, zr], [u, kneeV, zk], [u, hs, z0]];
      pieces.push({ key, label, kind: 'gable', polygon: P(u < 0 ? pts : [...pts].reverse()) });
    }
  } else {
    // flat: slab plus four parapets
    const zt = z0 + r.thickness;
    pieces.push({ key: 'slab', label: 'Roof slab', kind: 'slab', polygon: P([[-hl - o, -hs - o, zt], [hl + o, -hs - o, zt], [hl + o, hs + o, zt], [-hl - o, hs + o, zt]]) });
    if (r.parapet > 0) {
      const zp = zt + r.parapet;
      const e = [hl + o, hs + o];
      const sides: [string, [number, number], [number, number]][] = [
        ['front', [-e[0], -e[1]], [e[0], -e[1]]],
        ['right', [e[0], -e[1]], [e[0], e[1]]],
        ['back', [e[0], e[1]], [-e[0], e[1]]],
        ['left', [-e[0], e[1]], [-e[0], -e[1]]],
      ];
      for (const [name, a, c] of sides) {
        pieces.push({ key: `parapet-${name}`, label: `Parapet (${sideName(name as 'front')})`, kind: 'parapet', polygon: P([[a[0], a[1], zt], [c[0], c[1], zt], [c[0], c[1], zp], [a[0], a[1], zp]]) });
      }
    }
  }
  return pieces;
}

export function roofRidgeZ(b: Building, r: Roof): number {
  const pieces = roofPieces(b, r);
  return Math.max(...pieces.flatMap((p) => p.polygon.map((v) => v.z)));
}
