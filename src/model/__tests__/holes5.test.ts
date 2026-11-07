import { describe, expect, it } from 'vitest';
import { addRectangle, isHidden, syncStairOpenings } from '../ops';
import { emptyBuilding, migrate } from '../migrate';
import { buildExport } from '../export';
import { rotRect } from '../geometry';
import { DEFAULT_KIT, STAIR_DEFAULTS, type Building, type Stair } from '../types';

const twoFloors = (): Building => {
  const b = emptyBuilding('T');
  b.floors[0].id = 'f1';
  b.floors.push({ id: 'f2', name: 'Upper', elevation: 3, height: 3, slab: 0.2 });
  addRectangle(b, 'f1', { x: 0, y: 0 }, { x: 8, y: 6 }, DEFAULT_KIT);
  addRectangle(b, 'f2', { x: 0, y: 0 }, { x: 8, y: 6 }, DEFAULT_KIT);
  return b;
};
const stair = (o: Partial<Stair> = {}): Stair => ({ id: 's', floorId: 'f1', name: 'Main stair', x: 1, y: 1, w: 4.5, d: 1, dir: 0, riser: 0.18, ...STAIR_DEFAULTS, tags: [], ...o });

describe('stair openings', () => {
  it('a stair cuts a generous opening in the floor above, sized to it plus the margin', () => {
    const b = twoFloors();
    b.stairs.s = stair();
    syncStairOpenings(b);
    const holes = Object.values(b.holes);
    expect(holes).toHaveLength(1);
    const h = holes[0];
    expect(h.floorId).toBe('f2');
    expect(h.stairId).toBe('s');
    expect([h.x, h.y, h.w, h.d]).toEqual([0.85, 0.85, 4.8, 1.3]);
    expect(h.tags).toEqual(['f2-o1']);
  });

  it('follows the stair while automatic, stays put once sized by hand, and goes with the stair', () => {
    const b = twoFloors();
    b.stairs.s = stair();
    syncStairOpenings(b);
    const id = Object.keys(b.holes)[0];
    b.stairs.s.x = 2;
    b.stairs.s.angle = 30;
    syncStairOpenings(b);
    expect(b.holes[id].x).toBeCloseTo(1.85);
    expect(b.holes[id].angle).toBe(30);
    b.holes[id].auto = false;
    b.holes[id].w = 6;
    b.stairs.s.x = 0.5;
    syncStairOpenings(b);
    expect(b.holes[id].w).toBe(6);
    expect(b.holes[id].x).toBeCloseTo(1.85);
    b.stairs.s.hidden = true;
    expect(isHidden(b, id)).toBe(true);
    delete b.stairs.s;
    syncStairOpenings(b);
    expect(Object.keys(b.holes)).toHaveLength(0);
  });

  it('no floor above or opening switched off means no hole', () => {
    const b = twoFloors();
    b.stairs.s = stair({ floorId: 'f2' });
    syncStairOpenings(b);
    expect(Object.keys(b.holes)).toHaveLength(0);
    b.stairs.s = stair({ opening: false });
    syncStairOpenings(b);
    expect(Object.keys(b.holes)).toHaveLength(0);
  });

  it('openings are exported per floor and old files open without them', () => {
    const b = twoFloors();
    b.stairs.s = stair({ angle: 90 });
    b.holes.h2 = { id: 'h2', floorId: 'f2', name: 'Void', x: 5, y: 3, w: 2, d: 2, angle: 0, stairId: null, auto: false, tags: ['f2-o2'] };
    syncStairOpenings(b);
    const ex = buildExport({ schema: 'bpa/1', id: 'd', kit: DEFAULT_KIT, building: b });
    const ops = ex.building.floors[1].floorOpenings;
    expect(ops.map((o) => o.sizedTo).sort()).toEqual(['manual', 'stair']);
    const auto = ops.find((o) => o.sizedTo === 'stair')!;
    expect(auto.corners).toEqual(rotRect(Object.values(b.holes).find((h) => h.stairId)!).map((p) => [Math.round(p.x * 1000) / 1000, Math.round(p.y * 1000) / 1000]));
    const raw = JSON.parse(JSON.stringify({ schema: 'bpa/1', id: 'x', kit: DEFAULT_KIT, building: { ...b, holes: undefined } }));
    expect(migrate(raw).building.holes).toEqual({});
  });
});
