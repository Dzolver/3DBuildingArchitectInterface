import { describe, expect, it } from 'vitest';
import { addRectangle, addWall, setWallLength, syncRooms, deleteWalls, normalize } from '../ops';
import { findFaces, roomInterior, signedArea } from '../geometry';
import { DEFAULT_KIT, type Building } from '../types';

const blank = (): Building => ({
  name: 'Test',
  floors: [{ id: 'f1', name: 'Ground', elevation: 0, height: 3, slab: 0.2 }],
  corners: {},
  walls: {},
  rooms: {},
  openings: {},
  stairs: {},
  roofs: {},
  chimneys: {},
  holes: {},
  groups: {},
});

describe('rooms from walls', () => {
  it('a rectangle makes one room with auto tags', () => {
    const b = blank();
    addRectangle(b, 'f1', { x: 0, y: 0 }, { x: 8, y: 6 }, DEFAULT_KIT);
    syncRooms(b, 'f1');
    const rooms = Object.values(b.rooms);
    expect(rooms).toHaveLength(1);
    expect(rooms[0].tags).toEqual(['f1-r1']);
    expect(Object.values(b.walls).map((w) => w.tags[0]).sort()).toEqual(['f1-w1', 'f1-w2', 'f1-w3', 'f1-w4']);
    const face = findFaces(b, 'f1')[0];
    expect(signedArea(face.polygon)).toBeCloseTo(48);
    // interior inset by half of 0.25 m on each side
    expect(signedArea(roomInterior(b, face))).toBeCloseTo(7.75 * 5.75);
  });

  it('a dividing wall splits the room in two and keeps the first name', () => {
    const b = blank();
    addRectangle(b, 'f1', { x: 0, y: 0 }, { x: 8, y: 6 }, DEFAULT_KIT);
    syncRooms(b, 'f1');
    const firstId = Object.keys(b.rooms)[0];
    b.rooms[firstId].name = 'Hall';
    addWall(b, 'f1', { x: 4, y: 0 }, { x: 4, y: 6 }, DEFAULT_KIT);
    syncRooms(b, 'f1');
    const rooms = Object.values(b.rooms);
    expect(rooms).toHaveLength(2);
    expect(rooms.map((r) => r.name)).toContain('Hall');
    expect(findFaces(b, 'f1').map((f) => signedArea(f.polygon)).sort()).toEqual([24, 24]);
  });

  it('a crossing wall splits both walls', () => {
    const b = blank();
    addRectangle(b, 'f1', { x: 0, y: 0 }, { x: 8, y: 6 }, DEFAULT_KIT);
    addWall(b, 'f1', { x: 4, y: -2 }, { x: 4, y: 8 }, DEFAULT_KIT);
    syncRooms(b, 'f1');
    expect(Object.values(b.rooms)).toHaveLength(2);
    expect(Object.values(b.walls)).toHaveLength(9); // 6 outer pieces + 3 pieces of the crossing wall
  });

  it('deleting a wall opens the room', () => {
    const b = blank();
    const ids = addRectangle(b, 'f1', { x: 0, y: 0 }, { x: 4, y: 4 }, DEFAULT_KIT);
    syncRooms(b, 'f1');
    deleteWalls(b, [ids[0]]);
    syncRooms(b, 'f1');
    expect(Object.values(b.rooms)).toHaveLength(0);
  });

  it('setting a length stretches the plan and keeps it square', () => {
    const b = blank();
    addRectangle(b, 'f1', { x: 0, y: 0 }, { x: 8, y: 6 }, DEFAULT_KIT);
    const bottom = Object.values(b.walls).find((w) => b.corners[w.a].y === 0 && b.corners[w.b].y === 0)!;
    setWallLength(b, bottom.id, 10);
    normalize(b, 'f1');
    syncRooms(b, 'f1');
    expect(signedArea(findFaces(b, 'f1')[0].polygon)).toBeCloseTo(60);
  });
});
