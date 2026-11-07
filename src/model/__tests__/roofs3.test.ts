import { describe, expect, it } from 'vitest';
import { addRectangle } from '../ops';
import { roofPieces } from '../roof';
import { chimneyTop, polygonArea3, resolveRoofs, roofRect } from '../solids';
import { buildElevation } from '../elevation';
import { buildExport } from '../export';
import { emptyBuilding, migrate } from '../migrate';
import { DEFAULT_KIT, type Building, type Chimney, type Roof } from '../types';

const make = (): Building => {
  const b = emptyBuilding('T');
  b.floors[0].id = 'f1';
  return b;
};
const roof = (id: string, o: Partial<Roof>): Roof => ({
  id, floorId: 'f1', name: id, type: 'gable', x: 0, y: 0, w: 10, d: 6, dir: 0, angle: 0, trim: true,
  pitch: 35, overhang: 0.4, thickness: 0.2, parapet: 0.5, base: null, hiddenPieces: [], tags: [], ...o,
});
const chimney = (o: Partial<Chimney>): Chimney => ({
  id: 'ch1', floorId: 'f1', name: 'Chimney 1', x: 3, y: 1.5, w: 0.75, d: 0.75, angle: 0, top: null, clearance: 0.9, crown: true, tags: [], ...o,
});
const area = (parts: { x: number; y: number; z: number }[][]) => parts.reduce((s, p) => s + polygonArea3(p), 0);

describe('roof rotation', () => {
  it('rotates every piece around the footprint centre', () => {
    const b = make();
    const r = roof('r1', { angle: 90 });
    const flat = roofPieces(b, { ...r, angle: 0 });
    const turned = roofPieces(b, r);
    // ridge of a gable along x becomes a ridge along y when turned 90 degrees
    const ridge = (ps: ReturnType<typeof roofPieces>) => ps[0].polygon.filter((v) => Math.abs(v.z - Math.max(...ps[0].polygon.map((q) => q.z))) < 1e-9);
    const [a0, a1] = ridge(flat);
    const [b0, b1] = ridge(turned);
    expect(Math.abs(a0.y - a1.y)).toBeLessThan(1e-9);
    expect(Math.abs(b0.x - b1.x)).toBeLessThan(1e-9);
    expect(b0.x).toBeCloseTo(5); // centre x stays put
    expect(area(turned.map((p) => p.polygon))).toBeCloseTo(area(flat.map((p) => p.polygon)));
  });

  it('roofRect follows the angle', () => {
    const rect = roofRect(roof('r', { angle: 90 }));
    const xs = rect.map((p) => p.x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(6);
  });

  it('old files without angle/trim open with defaults', () => {
    const b = make();
    const r = roof('r1', {}) as Partial<Roof>;
    delete r.angle;
    delete r.trim;
    const doc = migrate({ schema: 'bpa/1', id: 'x', kit: DEFAULT_KIT, building: { ...b, roofs: { r1: r }, chimneys: undefined } });
    expect(doc.building.roofs.r1.angle).toBe(0);
    expect(doc.building.roofs.r1.trim).toBe(true);
    expect(doc.building.chimneys).toEqual({});
  });
});

describe('overlapping roofs trim each other', () => {
  it('a cross gable cuts into the main roof and is cut back to the valley', () => {
    const b = make();
    addRectangle(b, 'f1', { x: 0, y: 0 }, { x: 10, y: 6 }, DEFAULT_KIT);
    addRectangle(b, 'f1', { x: 3, y: -4 }, { x: 7, y: 0 }, DEFAULT_KIT);
    b.roofs.main = roof('main', {});
    b.roofs.wing = roof('wing', { x: 3, y: -4, w: 4, d: 7, dir: 90, pitch: 35 }); // runs into the main roof
    const res = resolveRoofs(b);
    const main = res.get('main')!;
    const wing = res.get('wing')!;
    expect(main.trimmedBy).toContain('wing');
    expect(wing.trimmedBy).toContain('main');
    // the wing's ridge is lower than the main ridge, so the end of the wing inside the main roof is gone
    const wingFull = area(wing.pieces.map((p) => p.polygon));
    const wingLeft = area(wing.pieces.flatMap((p) => p.parts!));
    expect(wingLeft).toBeLessThan(wingFull - 0.5);
    // the main roof loses only a small valley patch on its front slope, nothing on the back
    const front = main.pieces.find((p) => p.key === 'slope-front')!;
    const back = main.pieces.find((p) => p.key === 'slope-back')!;
    expect(area(front.parts!)).toBeLessThan(polygonArea3(front.polygon) - 0.1);
    expect(area(back.parts!)).toBeCloseTo(polygonArea3(back.polygon));
  });

  it('roofs that do not touch are left alone, and trim can be switched off', () => {
    const b = make();
    b.roofs.a = roof('a', {});
    b.roofs.b = roof('b', { x: 20 });
    const res = resolveRoofs(b);
    expect(res.get('a')!.trimmedBy).toEqual([]);
    b.roofs.b = roof('b', { x: 4, angle: 30, trim: false });
    const res2 = resolveRoofs(b);
    expect(res2.get('b')!.trimmedBy).toEqual([]);
    expect(res2.get('a')!.trimmedBy).toContain('b');
  });

  it('a roof never trims itself', () => {
    const b = make();
    b.roofs.a = roof('a', { type: 'hip', angle: 17 });
    const p = resolveRoofs(b).get('a')!;
    expect(p.trimmedBy).toEqual([]);
    expect(area(p.pieces.flatMap((x) => x.parts!))).toBeCloseTo(area(p.pieces.map((x) => x.polygon)));
  });
});

describe('chimneys', () => {
  it('auto top clears the roof it pokes through, and the roof is cut around it', () => {
    const b = make();
    b.roofs.main = roof('main', {});
    b.chimneys.ch1 = chimney({});
    const t = Math.tan((35 * Math.PI) / 180);
    // the ridge (5.1 m) is within 3 m, so the stack clears it by 0.6 m (3-2-10 rule)
    expect(chimneyTop(b, b.chimneys.ch1)).toBeCloseTo(3 + 3 * t + 0.6, 2);
    // far from the ridge on a wide roof, the 0.9 m clearance at the roof line governs
    b.roofs.main = roof('main', { d: 20 });
    b.chimneys.ch1 = chimney({ x: 5, y: 1 });
    const atCorner = 3 + 1.375 * t; // highest corner of the stack, 1.375 m in from the wall line
    const near = 3 + (1.375 + 3) * t; // highest roof within 3 m
    expect(chimneyTop(b, b.chimneys.ch1)).toBeCloseTo(Math.max(atCorner + 0.9, near + 0.6), 2);
    b.roofs.main = roof('main', {});
    b.chimneys.ch1 = chimney({});
    const res = resolveRoofs(b).get('main')!;
    expect(res.trimmedBy).toEqual(['ch1']);
    const front = res.pieces.find((p) => p.key === 'slope-front')!;
    expect(polygonArea3(front.polygon) - area(front.parts!)).toBeGreaterThan(0.5); // ~0.75 x 0.75 / cos 35
  });

  it('fixed top is used as given; chimneys show in elevations and the export', () => {
    const b = make();
    addRectangle(b, 'f1', { x: 0, y: 0 }, { x: 10, y: 6 }, DEFAULT_KIT);
    b.chimneys.ch1 = chimney({ top: 9 });
    expect(chimneyTop(b, b.chimneys.ch1)).toBe(9);
    const el = buildElevation(b, 'front');
    expect(el.items.some((d) => d.kind === 'chimney')).toBe(true);
    expect(el.bounds!.maxZ).toBeCloseTo(9);
    const ex = buildExport({ schema: 'bpa/1', id: 'd', kit: DEFAULT_KIT, building: b });
    const c = ex.building.floors[0].chimneys[0];
    expect(c.top).toBe(9);
    expect(c.uu.top).toBe(900);
    expect(c.pieces.map((p) => p.key)).toEqual(['stack', 'crown']);
  });
});

describe('roof over rotated walls', () => {
  it('lines the roof up with the walls it covers', async () => {
    const { alignedRect } = await import('../../components/Inspector');
    const b = make();
    // a 10 x 6 box turned 30 degrees about the origin
    const a = (30 * Math.PI) / 180;
    const R = (x: number, y: number) => ({ x: x * Math.cos(a) - y * Math.sin(a), y: x * Math.sin(a) + y * Math.cos(a) });
    const { addWall } = await import('../ops');
    const pts = [R(0, 0), R(10, 0), R(10, 6), R(0, 6)];
    for (let i = 0; i < 4; i++) addWall(b, 'f1', pts[i], pts[(i + 1) % 4], DEFAULT_KIT);
    const fit = alignedRect(b, new Set(Object.keys(b.corners)));
    expect(fit.angle).toBeCloseTo(30);
    expect(fit.w).toBeCloseTo(10);
    expect(fit.d).toBeCloseTo(6);
    const c = R(5, 3);
    expect(fit.x + fit.w / 2).toBeCloseTo(c.x, 2);
    expect(fit.y + fit.d / 2).toBeCloseTo(c.y, 2);
  });
});
