import { describe, expect, it } from 'vitest';
import { addRectangle, syncRooms } from '../ops';
import { buildExport } from '../export';
import { DEFAULT_KIT, type ProjectDoc } from '../types';

describe('export', () => {
  it('writes metres plus Unreal units, interior clear sizes and module checks', () => {
    const doc: ProjectDoc = {
      schema: 'bpa/1',
      id: 'doc1',
      kit: DEFAULT_KIT,
      building: { name: 'Inn', floors: [{ id: 'f1', name: 'Ground', elevation: 0, height: 3, slab: 0.2 }], corners: {}, walls: {}, rooms: {}, openings: {}, stairs: {}, roofs: {}, chimneys: {}, holes: {}, groups: {} },
    };
    addRectangle(doc.building, 'f1', { x: 0, y: 0 }, { x: 8, y: 6 }, DEFAULT_KIT);
    syncRooms(doc.building, 'f1');
    const out = buildExport(doc);
    const f = out.building.floors[0];
    expect(f.walls).toHaveLength(4);
    const bottom = f.walls.find((w) => w.start[1] === 0 && w.end[1] === 0)!;
    expect(bottom.length).toBe(8);
    expect(bottom.modules).toBe(4);
    expect(bottom.onModuleGrid).toBe(true);
    expect(bottom.uu.length).toBe(800);
    expect(bottom.uu.thickness).toBe(25);
    const room = f.rooms[0]!;
    expect(room.clear).toEqual([7.75, 5.75]);
    expect(room.uu.clear).toEqual([775, 575]);
    expect(room.tags).toEqual(['f1-r1']);
    expect(f.uu.height).toBe(300);
  });
});
