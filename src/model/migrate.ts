import { uid } from './geometry';
import { DEFAULT_KIT, STAIR_DEFAULTS, type Building, type ProjectDoc } from './types';

export function emptyBuilding(name = 'Untitled building', storyHeight = DEFAULT_KIT.storyHeight): Building {
  return {
    name,
    floors: [{ id: uid('f'), name: 'Ground floor', elevation: 0, height: storyHeight, slab: 0.2 }],
    corners: {},
    walls: {},
    rooms: {},
    openings: {},
    stairs: {},
    roofs: {},
    chimneys: {},
    holes: {},
    groups: {},
  };
}

/** Fill in fields added after a file was saved, so older projects keep opening. */
export function migrate(raw: unknown): ProjectDoc {
  const d = raw as Partial<ProjectDoc> & { building?: Partial<Building> };
  if (d?.schema !== 'bpa/1' || !d.building?.floors?.length) throw new Error('Not a Building Architect project file.');
  const b = d.building;
  return {
    schema: 'bpa/1',
    id: d.id ?? uid('doc'),
    kit: {
      ...DEFAULT_KIT,
      ...d.kit,
      door: { ...DEFAULT_KIT.door, ...d.kit?.door },
      window: { ...DEFAULT_KIT.window, ...d.kit?.window },
    },
    building: {
      name: b.name ?? 'Untitled building',
      floors: b.floors!,
      corners: b.corners ?? {},
      walls: b.walls ?? {},
      rooms: b.rooms ?? {},
      openings: b.openings ?? {},
      stairs: Object.fromEntries(Object.entries(b.stairs ?? {}).map(([k, st]) => [k, { ...STAIR_DEFAULTS, ...st }])),
      roofs: Object.fromEntries(Object.entries(b.roofs ?? {}).map(([k, r]) => [k, { ...r, angle: r.angle ?? 0, trim: r.trim ?? true }])),
      chimneys: b.chimneys ?? {},
      holes: b.holes ?? {},
      groups: b.groups ?? {},
    },
  };
}
