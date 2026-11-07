import { describe, expect, it } from 'vitest';
import { stairLayout, stairRect } from '../stairs';
import { pointInPolygon } from '../geometry';
import { migrate, emptyBuilding } from '../migrate';
import { buildExport } from '../export';
import { DEFAULT_KIT, STAIR_DEFAULTS, type Building, type Stair } from '../types';

const make = (): Building => {
  const b = emptyBuilding('T');
  b.floors[0].id = 'f1';
  return b;
};
const stair = (o: Partial<Stair>): Stair => ({ id: 's', floorId: 'f1', name: 'S', x: 0, y: 0, w: 4, d: 2.5, dir: 0, riser: 0.18, ...STAIR_DEFAULTS, tags: [], ...o });
const inRect = (s: Stair) => (p: { x: number; y: number }) => pointInPolygon(p, stairRect(s, 1e-6));

describe('stair shapes', () => {
  it('straight stair: one flight of steps across the full width', () => {
    const b = make();
    const s = stair({ w: 4.5, d: 1 });
    const l = stairLayout(b, s);
    expect(l.steps).toBe(17);
    expect(l.flights).toHaveLength(1);
    expect(l.parts.every((p) => p.kind === 'step')).toBe(true);
    expect(l.parts[l.parts.length - 1].top).toBeCloseTo(3);
  });

  it('mid landing splits the risers and sits at the split height', () => {
    const b = make();
    const s = stair({ shape: 'landing', w: 6, d: 1, landing: 1.2 });
    const l = stairLayout(b, s);
    const [f1, f2] = l.flights;
    expect(f1.risers + f2.risers).toBe(l.steps);
    expect(l.landing!.d).toBeCloseTo(1.2);
    expect(l.landing!.height).toBeCloseTo(f1.risers * l.riser);
    expect(f1.tread).toBeCloseTo(f2.tread);
    expect(l.parts.filter((p) => p.kind === 'landing')).toHaveLength(1);
  });

  it('L stair: corner landing, second flight turns left (or right)', () => {
    const b = make();
    const s = stair({ shape: 'l', w: 3.5, d: 3, flightWidth: 1 });
    const l = stairLayout(b, s);
    const land = l.parts.find((p) => p.kind === 'landing')!;
    expect(land.centre.x).toBeCloseTo(3);
    expect(land.centre.y).toBeCloseTo(0.5); // left turn from +x travel goes to +y
    const last = l.parts[l.parts.length - 1];
    expect(last.centre.y).toBeGreaterThan(2.5);
    const r = stairLayout(b, { ...s, turn: 'right' });
    expect(r.parts.find((p) => p.kind === 'landing')!.centre.y).toBeCloseTo(2.5);
    expect(l.parts.every((p) => p.poly.every(inRect(s)))).toBe(true);
  });

  it('U stair: full-width landing, flights side by side going opposite ways', () => {
    const b = make();
    const s = stair({ shape: 'u', w: 4, d: 2.2, flightWidth: 1, landing: 1 });
    const l = stairLayout(b, s);
    const land = l.parts.find((p) => p.kind === 'landing')!;
    expect(land.size[1]).toBeCloseTo(2.2);
    const f1 = l.parts.filter((p) => p.kind === 'step' && p.flight === 0);
    const f2 = l.parts.filter((p) => p.kind === 'step' && p.flight === 1);
    // first flight climbs along +x, second comes back along -x on the other side
    expect(f1[1].centre.x).toBeGreaterThan(f1[0].centre.x);
    expect(f2[1].centre.x).toBeLessThan(f2[0].centre.x);
    expect(f2[0].centre.y).toBeGreaterThan(f1[0].centre.y);
    expect(f2[f2.length - 1].top).toBeCloseTo(3);
    expect(l.walk).toHaveLength(4);
  });

  it('every shape works in every direction and rotation, staying inside its rectangle', () => {
    const b = make();
    for (const shape of ['straight', 'landing', 'l', 'u'] as const)
      for (const dir of [0, 90, 180, 270] as const)
        for (const angle of [0, 30, -75]) {
          const s = stair({ shape, dir, angle, w: dir % 180 ? 2.4 : 4, d: dir % 180 ? 4 : 2.4 });
          const l = stairLayout(b, s);
          expect(l.parts.every((p) => p.poly.every(inRect(s)))).toBe(true);
          const tops = l.parts.map((p) => p.top);
          expect([...tops].sort((a, c) => a - c)).toEqual(tops); // always climbing
        }
  });

  it('rotating turns the parts around the centre', () => {
    const b = make();
    const s = stair({ angle: 90, w: 4, d: 1 });
    const l = stairLayout(b, s);
    const ys = l.parts.map((p) => p.centre.y);
    expect(ys[1]).toBeGreaterThan(ys[0]); // +x travel turned 90 degrees climbs along +y
    expect(l.parts[0].centre.x).toBeCloseTo(2);
  });

  it('old stairs open as straight and export their flights', () => {
    const b = make();
    const raw = { id: 's', floorId: 'f1', name: 'S', x: 0, y: 0, w: 4, d: 2.5, dir: 0, riser: 0.18, tags: [] };
    const doc = migrate({ schema: 'bpa/1', id: 'x', kit: DEFAULT_KIT, building: { ...b, stairs: { s: raw } } });
    expect(doc.building.stairs.s.shape).toBe('straight');
    doc.building.stairs.s.shape = 'u';
    const ex = buildExport(doc);
    const st = ex.building.floors[0].stairs[0];
    expect(st.flights).toHaveLength(2);
    expect(st.landing).not.toBeNull();
    expect(st.parts.length).toBe(st.steps);
  });
});
