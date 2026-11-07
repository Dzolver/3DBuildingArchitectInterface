import type { Building, Stair, Vec2 } from './types';

/** One tread block or landing, as a plan rectangle (world, CCW) rising from the floor to `top`. */
export interface StairPart {
  kind: 'step' | 'landing';
  /** 0 = first flight (or the only one), 1 = second flight. Landings carry 0. */
  flight: 0 | 1;
  poly: Vec2[];
  /** Centre, size along its own axes and the world angle of its first axis (radians), for boxes. */
  centre: Vec2;
  size: [number, number];
  rot: number;
  /** Top of the block above the stair's floor. */
  top: number;
}

export interface FlightInfo {
  risers: number;
  treads: number;
  tread: number;
  width: number;
  run: number;
}

/** Local frame: u along the first flight (0..L), v across it (0..W), +v on the climber's left. */
function frame(s: Stair) {
  const along = s.dir === 0 || s.dir === 180;
  const L = along ? s.w : s.d;
  const W = along ? s.d : s.w;
  const cx = s.x + s.w / 2;
  const cy = s.y + s.d / 2;
  const a = ((s.angle ?? 0) * Math.PI) / 180;
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  const toWorld = (u: number, v: number): Vec2 => {
    let rx: number;
    let ry: number;
    switch (s.dir) {
      case 0: [rx, ry] = [u, v]; break;
      case 90: [rx, ry] = [s.w - v, u]; break;
      case 180: [rx, ry] = [s.w - u, s.d - v]; break;
      default: [rx, ry] = [v, s.d - u];
    }
    const dx = rx - s.w / 2;
    const dy = ry - s.d / 2;
    return { x: cx + dx * ca - dy * sa, y: cy + dx * sa + dy * ca };
  };
  const dirRad = ({ 0: 0, 90: Math.PI / 2, 180: Math.PI, 270: -Math.PI / 2 } as const)[s.dir] + a;
  return { L, W, toWorld, dirRad };
}

/** Rotated outline of the stair rectangle (world, CCW). */
export function stairRect(s: Stair, grow = 0): Vec2[] {
  const cx = s.x + s.w / 2;
  const cy = s.y + s.d / 2;
  const a = ((s.angle ?? 0) * Math.PI) / 180;
  const hw = s.w / 2 + grow;
  const hd = s.d / 2 + grow;
  return [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map(([u, v]) => ({ x: cx + u * Math.cos(a) - v * Math.sin(a), y: cy + u * Math.sin(a) + v * Math.cos(a) }));
}

/** Everything about a stair's layout: risers, flights, landing, parts and the walking line. */
export function stairLayout(b: Building, s: Stair) {
  const f = b.floors.find((x) => x.id === s.floorId);
  const rise = f?.height ?? 3;
  const steps = Math.max(2, Math.round(rise / s.riser));
  const riser = rise / steps;
  const { L, W, toWorld, dirRad } = frame(s);
  const shape = s.shape ?? 'straight';
  const mirror = (s.turn ?? 'left') === 'right';
  const V = (v: number) => (mirror ? W - v : v);
  const parts: StairPart[] = [];
  const add = (kind: StairPart['kind'], flight: 0 | 1, u0: number, u1: number, v0: number, v1: number, top: number, axis: 'u' | 'v') => {
    const [a0, a1] = [Math.min(u0, u1), Math.max(u0, u1)];
    const [b0, b1] = [Math.min(V(v0), V(v1)), Math.max(V(v0), V(v1))];
    const poly = [toWorld(a0, b0), toWorld(a1, b0), toWorld(a1, b1), toWorld(a0, b1)];
    // keep CCW whatever the mapping did
    const area = poly.reduce((acc, p, i) => { const q = poly[(i + 1) % 4]; return acc + p.x * q.y - q.x * p.y; }, 0);
    if (area < 0) poly.reverse();
    const centre = toWorld((a0 + a1) / 2, (b0 + b1) / 2);
    const size: [number, number] = axis === 'u' ? [a1 - a0, b1 - b0] : [b1 - b0, a1 - a0];
    const rot = axis === 'u' ? dirRad : dirRad + Math.PI / 2;
    parts.push({ kind, flight, poly, centre, size, rot, top });
  };
  // risers in the first flight (it ends on the landing), the rest go in the second
  const n1 = shape === 'straight' ? steps : Math.max(1, Math.min(steps - 1, Math.round(steps * (s.split ?? 0.5))));
  const n2 = steps - n1;
  const flights: FlightInfo[] = [];
  let landing: { w: number; d: number; height: number } | null = null;
  let path: [number, number][] = [];

  if (shape === 'straight') {
    const t = L / steps;
    for (let i = 0; i < steps; i++) add('step', 0, i * t, (i + 1) * t, 0, W, (i + 1) * riser, 'u');
    flights.push({ risers: steps, treads: steps - 1, tread: t, width: W, run: L });
    path = [[0, W / 2], [L, W / 2]];
  } else if (shape === 'landing') {
    const ld = Math.min(s.landing, L * 0.6);
    const t = (L - ld) / (n1 - 1 + n2);
    for (let i = 0; i < n1 - 1; i++) add('step', 0, i * t, (i + 1) * t, 0, W, (i + 1) * riser, 'u');
    const l0 = (n1 - 1) * t;
    add('landing', 0, l0, l0 + ld, 0, W, n1 * riser, 'u');
    for (let i = 0; i < n2; i++) add('step', 1, l0 + ld + i * t, l0 + ld + (i + 1) * t, 0, W, (n1 + i + 1) * riser, 'u');
    flights.push({ risers: n1, treads: n1 - 1, tread: t, width: W, run: l0 }, { risers: n2, treads: n2 - 1, tread: t, width: W, run: n2 * t });
    landing = { w: W, d: ld, height: n1 * riser };
    path = [[0, W / 2], [L, W / 2]];
  } else if (shape === 'l') {
    const fw = Math.min(s.flightWidth, W * 0.9, L * 0.9);
    const t1 = n1 > 1 ? (L - fw) / (n1 - 1) : 0;
    const t2 = (W - fw) / n2;
    for (let i = 0; i < n1 - 1; i++) add('step', 0, i * t1, (i + 1) * t1, 0, fw, (i + 1) * riser, 'u');
    add('landing', 0, L - fw, L, 0, fw, n1 * riser, 'u');
    for (let i = 0; i < n2; i++) add('step', 1, L - fw, L, fw + i * t2, fw + (i + 1) * t2, (n1 + i + 1) * riser, 'v');
    flights.push({ risers: n1, treads: n1 - 1, tread: t1, width: fw, run: L - fw }, { risers: n2, treads: n2 - 1, tread: t2, width: fw, run: W - fw });
    landing = { w: fw, d: fw, height: n1 * riser };
    path = [[0, fw / 2], [L - fw / 2, fw / 2], [L - fw / 2, W]];
  } else {
    const fw = Math.min(s.flightWidth, W / 2);
    const ld = Math.min(s.landing, L * 0.6);
    const t1 = n1 > 1 ? (L - ld) / (n1 - 1) : 0;
    const t2 = (L - ld) / n2;
    for (let i = 0; i < n1 - 1; i++) add('step', 0, i * t1, (i + 1) * t1, 0, fw, (i + 1) * riser, 'u');
    add('landing', 0, L - ld, L, 0, W, n1 * riser, 'u');
    for (let i = 0; i < n2; i++) add('step', 1, L - ld - (i + 1) * t2, L - ld - i * t2, W - fw, W, (n1 + i + 1) * riser, 'u');
    flights.push({ risers: n1, treads: n1 - 1, tread: t1, width: fw, run: L - ld }, { risers: n2, treads: n2 - 1, tread: t2, width: fw, run: L - ld });
    landing = { w: W, d: ld, height: n1 * riser };
    path = [[0, fw / 2], [L - ld / 2, fw / 2], [L - ld / 2, W - fw / 2], [0, W - fw / 2]];
  }

  const walk = path.map(([u, v]) => toWorld(u, V(v)));
  const tread = Math.min(...flights.map((x) => x.tread).filter((x) => x > 0));
  const run = flights.reduce((a, x) => a + x.run, 0);
  const idx = b.floors.findIndex((x) => x.id === s.floorId);
  return {
    rise,
    steps,
    riser,
    shape,
    flights,
    landing,
    parts,
    walk,
    tread: Number.isFinite(tread) ? tread : L / steps,
    run,
    width: Math.min(...flights.map((x) => x.width)),
    pitchDeg: (Math.atan2(riser, Number.isFinite(tread) ? tread : L / steps) * 180) / Math.PI,
    toFloor: b.floors[idx + 1] ?? null,
    elevation: f?.elevation ?? 0,
  };
}

/** Rise, step count and tread depth (the tightest flight), kept for older callers. */
export function stairInfo(b: Building, s: Stair) {
  return stairLayout(b, s);
}

export function stairParts(b: Building, s: Stair): StairPart[] {
  return stairLayout(b, s).parts;
}
