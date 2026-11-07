// All lengths are in metres (1 Blender unit = 1 m = 100 Unreal units).
// Plan coordinates: x to the right, y up (looking down from above).

export type Id = string;

export interface Vec2 {
  x: number;
  y: number;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Corner extends Vec2 {
  id: Id;
  floorId: Id;
}

export type WallKind = 'exterior' | 'interior';

export interface Wall {
  id: Id;
  floorId: Id;
  a: Id; // corner id
  b: Id; // corner id
  thickness: number;
  height: number | null; // null = use floor height
  kind: WallKind;
  tags: string[];
  hidden?: boolean;
}

export type OpeningType = 'door' | 'window' | 'arch';

/** A door / window / arch cut through a wall. */
export interface Opening {
  id: Id;
  wallId: Id;
  type: OpeningType;
  /** Distance from the wall's `a` corner to the opening's centre, along the centreline. */
  offset: number;
  width: number;
  height: number;
  /** Height of the opening's bottom above the floor (0 for doors). */
  sill: number;
  tags: string[];
  hidden?: boolean;
}

export interface Room {
  id: Id;
  floorId: Id;
  /** Corner ids around the room, sorted and joined. Used to keep names stable across edits. */
  key: string;
  name: string;
  tags: string[];
}

export interface Floor {
  id: Id;
  name: string;
  elevation: number;
  height: number; // floor-to-floor
  slab: number;
}

/** Rotation in plan, counter-clockwise, in quarter turns. */
export type Quarter = 0 | 90 | 180 | 270;

export type StairShape = 'straight' | 'landing' | 'l' | 'u';

/**
 * A stair inside a rectangle. Climbs from `floorId` up to the next floor, starting in direction
 * `dir`. Shapes: one straight flight, straight with a mid landing, L (quarter turn at a corner
 * landing) or U (half turn at a full-width landing, flights side by side).
 */
export interface Stair {
  id: Id;
  floorId: Id;
  name: string;
  /** Rectangle in plan (min corner + size), before rotation. */
  x: number;
  y: number;
  w: number;
  d: number;
  /** Direction of travel going up: 0 = +x, 90 = +y, 180 = -x, 270 = -y. */
  dir: Quarter;
  /** Target riser height; the actual riser divides the floor height evenly. */
  riser: number;
  shape: StairShape;
  /** Free rotation of the whole stair around its rectangle centre, degrees counter-clockwise. */
  angle: number;
  /** Which way L and U stairs turn at the landing, seen climbing. */
  turn: 'left' | 'right';
  /** Width of each flight (L and U stairs; straight stairs use the full width). */
  flightWidth: number;
  /** Landing depth along the direction of travel (mid landing and U stairs). */
  landing: number;
  /** Share of the risers in the first flight, 0..1 (stairs with a landing). */
  split: number;
  /** Cut an opening in the floor above automatically. */
  opening: boolean;
  /** How far the automatic opening reaches past the stair on every side. */
  openingMargin: number;
  tags: string[];
  hidden?: boolean;
}

export const STAIR_DEFAULTS = { shape: 'straight', angle: 0, turn: 'left', flightWidth: 1, landing: 1, split: 0.5, opening: true, openingMargin: 0.15 } as const;

/**
 * A hole in a floor slab (negative space): a stairwell, a double-height void, a hatch.
 * Stairs keep their own opening (`stairId`) sized to them while `auto` is on; once you
 * move or resize it by hand it stays where you put it.
 */
export interface FloorHole {
  id: Id;
  floorId: Id;
  name: string;
  /** Rectangle in plan (min corner + size), before rotation around its centre. */
  x: number;
  y: number;
  w: number;
  d: number;
  angle: number;
  stairId: Id | null;
  auto: boolean;
  tags: string[];
  hidden?: boolean;
}

export type RoofType = 'gable' | 'hip' | 'shed' | 'flat' | 'gambrel';

/** A roof over a rectangle, sitting on top of `floorId`. */
export interface Roof {
  id: Id;
  floorId: Id;
  name: string;
  type: RoofType;
  /** Footprint rectangle measured to the wall centrelines. */
  x: number;
  y: number;
  w: number;
  d: number;
  /** Ridge direction: 0 = ridge runs along x, 90 = along y. For shed roofs, 0/90/180/270 = side that is high. */
  dir: Quarter;
  /** Free rotation of the whole roof around its footprint centre, degrees counter-clockwise. */
  angle: number;
  /** Cut this roof where it runs into other roofs or chimneys (valleys). */
  trim: boolean;
  pitch: number; // degrees
  overhang: number;
  thickness: number;
  /** Extra height for flat-roof parapets. */
  parapet: number;
  /** Base height above the floor's elevation; null = top of the floor's walls. */
  base: number | null;
  /** Keys of pieces hidden from view and marked hidden in the export. */
  hiddenPieces: string[];
  tags: string[];
  hidden?: boolean;
}

/** A chimney stack rising from a floor up through the roofs. */
export interface Chimney {
  id: Id;
  floorId: Id;
  name: string;
  /** Centre in plan. */
  x: number;
  y: number;
  w: number;
  d: number;
  angle: number;
  /** Top height above ground; null = auto (clears the highest roof it passes through by `clearance`). */
  top: number | null;
  clearance: number;
  /** Wider cap course at the top. */
  crown: boolean;
  tags: string[];
  hidden?: boolean;
}

export interface Group {
  id: Id;
  name: string;
  /** Ids of walls, openings, rooms, stairs, roofs or floors. */
  members: Id[];
  tags: string[];
  hidden?: boolean;
}

export interface KitSettings {
  module: number; // wall module length (m)
  fineGrid: number; // fine snapping step (m)
  storyHeight: number;
  wallThickness: number;
  pxPerMetre: number;
  door: { width: number; height: number };
  window: { width: number; height: number; sill: number };
}

export interface Building {
  name: string;
  floors: Floor[];
  corners: Record<Id, Corner>;
  walls: Record<Id, Wall>;
  rooms: Record<Id, Room>;
  openings: Record<Id, Opening>;
  stairs: Record<Id, Stair>;
  roofs: Record<Id, Roof>;
  chimneys: Record<Id, Chimney>;
  holes: Record<Id, FloorHole>;
  groups: Record<Id, Group>;
}

export interface ProjectDoc {
  schema: 'bpa/1';
  /** Stable id used by the blueprint library. */
  id: Id;
  kit: KitSettings;
  building: Building;
}

export const DEFAULT_KIT: KitSettings = {
  module: 2,
  fineGrid: 0.125,
  storyHeight: 3,
  wallThickness: 0.25,
  pxPerMetre: 32,
  door: { width: 1, height: 2.25 },
  window: { width: 1, height: 1, sill: 1 },
};
