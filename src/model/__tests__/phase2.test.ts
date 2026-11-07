import { describe, expect, it } from 'vitest';
import { addOpening, addRectangle, addWall, buildingCentre, isHidden, mergeWalls, mergeableCount, normalize, recentre, syncRooms } from '../ops';
import { roofPieces, roofRidgeZ } from '../roof';
import { stairInfo } from '../stairs';
import { buildElevation } from '../elevation';
import { buildExport } from '../export';
import { emptyBuilding } from '../migrate';
import { wallLength } from '../geometry';
import { DEFAULT_KIT, STAIR_DEFAULTS, type Building, type Roof } from '../types';

const make = (): Building => {
  const b = emptyBuilding('T');
  b.floors[0].id = 'f1';
  return b;
};

describe('merging walls', () => {
  it('joins two collinear walls that meet end to end, keeping openings in place', () => {
    const b = make();
    addWall(b, 'f1', { x: 0, y: 0 }, { x: 4, y: 0 }, DEFAULT_KIT);
    addWall(b, 'f1', { x: 4, y: 0 }, { x: 10, y: 0 }, DEFAULT_KIT);
    const [w1, w2] = Object.values(b.walls);
    addOpening(b, w2.id, 'window', 3, 1, DEFAULT_KIT); // 3 m into the second wall -> 7 m overall
    expect(mergeableCount(b, [w1.id, w2.id])).toBe(1);
    const kept = mergeWalls(b, [w1.id, w2.id]);
    expect(kept).toHaveLength(1);
    expect(wallLength(b, b.walls[kept[0]])).toBe(10);
    expect(Object.values(b.openings)[0].offset).toBeCloseTo(7);
    expect(Object.keys(b.corners)).toHaveLength(2);
  });

  it('does not merge across a T-junction or a bend', () => {
    const b = make();
    addRectangle(b, 'f1', { x: 0, y: 0 }, { x: 8, y: 6 }, DEFAULT_KIT);
    addWall(b, 'f1', { x: 4, y: 0 }, { x: 4, y: 6 }, DEFAULT_KIT);
    const bottom = Object.values(b.walls).filter((w) => b.corners[w.a].y === 0 && b.corners[w.b].y === 0);
    expect(bottom).toHaveLength(2);
    expect(mergeableCount(b, bottom.map((w) => w.id))).toBe(0);
    const all = Object.keys(b.walls);
    expect(mergeableCount(b, all)).toBe(0);
  });
});

describe('openings', () => {
  it('follow their half when a wall is split', () => {
    const b = make();
    addWall(b, 'f1', { x: 0, y: 0 }, { x: 10, y: 0 }, DEFAULT_KIT);
    const w = Object.values(b.walls)[0];
    addOpening(b, w.id, 'door', 8, 1, DEFAULT_KIT);
    addWall(b, 'f1', { x: 5, y: -3 }, { x: 5, y: 3 }, DEFAULT_KIT); // splits at x=5
    normalize(b, 'f1');
    const o = Object.values(b.openings)[0];
    const host = b.walls[o.wallId];
    expect(host.id).not.toBe(w.id);
    expect(o.offset).toBeCloseTo(3);
    expect(wallLength(b, host)).toBe(5);
  });
});

describe('roofs', () => {
  const roof = (type: Roof['type']): Roof => ({ id: 'r', floorId: 'f1', name: 'R', type, x: 0, y: 0, w: 8, d: 6, dir: 0, pitch: 45, overhang: 0, thickness: 0.2, parapet: 0.5, base: null, hiddenPieces: [], tags: [], angle: 0, trim: true });
  it('gable: 2 slopes + 2 gable ends, ridge at half span × tan(pitch)', () => {
    const b = make();
    const r = roof('gable');
    const pieces = roofPieces(b, r);
    expect(pieces.map((p) => p.key).sort()).toEqual(['gable-left', 'gable-right', 'slope-back', 'slope-front']);
    expect(roofRidgeZ(b, r)).toBeCloseTo(3 + 3); // wall top 3 m + 3 m rise
  });
  it('hip, shed, gambrel and flat all build', () => {
    const b = make();
    expect(roofPieces(b, roof('hip'))).toHaveLength(4);
    expect(roofPieces(b, roof('shed'))).toHaveLength(4);
    expect(roofPieces(b, roof('gambrel'))).toHaveLength(6);
    expect(roofPieces(b, roof('flat'))).toHaveLength(5);
  });
});

describe('stairs, centre, elevation, export', () => {
  it('stair steps divide the floor height', () => {
    const b = make();
    b.stairs.s = { id: 's', floorId: 'f1', name: 'S', x: 0, y: 0, w: 4.5, d: 1, dir: 0, riser: 0.18, ...STAIR_DEFAULTS, tags: [] };
    const info = stairInfo(b, b.stairs.s);
    expect(info.steps).toBe(17);
    expect(info.riser * info.steps).toBeCloseTo(3);
  });

  it('centre and recentre', () => {
    const b = make();
    addRectangle(b, 'f1', { x: 2, y: 2 }, { x: 10, y: 8 }, DEFAULT_KIT);
    expect(buildingCentre(b)).toEqual({ x: 6, y: 5 });
    recentre(b, 0.125);
    expect(buildingCentre(b)).toEqual({ x: 0, y: 0 });
  });

  it('front elevation punches window holes and hides hidden walls', () => {
    const b = make();
    addRectangle(b, 'f1', { x: 0, y: 0 }, { x: 8, y: 6 }, DEFAULT_KIT);
    syncRooms(b, 'f1');
    const front = Object.values(b.walls).find((w) => b.corners[w.a].y === 0 && b.corners[w.b].y === 0)!;
    addOpening(b, front.id, 'window', 4, 1, DEFAULT_KIT);
    const el = buildElevation(b, 'front');
    const wall = el.items.find((d) => d.refId === front.id)!;
    expect(wall.holes).toHaveLength(1);
    expect(el.items.filter((d) => d.kind === 'opening')).toHaveLength(1);
    b.walls[front.id].hidden = true;
    expect(isHidden(b, front.id)).toBe(true);
    expect(buildElevation(b, 'front').items.find((d) => d.refId === front.id)).toBeUndefined();
  });

  it('export carries openings, roofs and the centre', () => {
    const b = make();
    addRectangle(b, 'f1', { x: 0, y: 0 }, { x: 8, y: 6 }, DEFAULT_KIT);
    syncRooms(b, 'f1');
    const w = Object.values(b.walls)[0];
    addOpening(b, w.id, 'door', 2, 1, DEFAULT_KIT);
    b.roofs.r = { id: 'r', floorId: 'f1', name: 'R', type: 'hip', x: 0, y: 0, w: 8, d: 6, dir: 0, pitch: 30, overhang: 0.4, thickness: 0.2, parapet: 0, base: null, hiddenPieces: ['hip-left'], tags: [], angle: 0, trim: true };
    const out = buildExport({ schema: 'bpa/1', id: 'd', kit: DEFAULT_KIT, building: b });
    const f = out.building.floors[0];
    const door = f.walls.flatMap((x) => x.openings)[0];
    expect(door.fromStart).toBe(1.5);
    expect(door.uu.width).toBe(100);
    expect(f.roofs[0].pieces.find((p) => p.key === 'hip-left')!.hidden).toBe(true);
    expect(out.building.centre!.plan).toEqual([4, 3]);
  });
});
