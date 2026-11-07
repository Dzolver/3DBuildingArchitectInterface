import { create } from 'zustand';
import { normalize, syncRooms, syncStairOpenings } from './model/ops';
import { uid } from './model/geometry';
import { DEFAULT_KIT, type Building, type Id, type ProjectDoc } from './model/types';
import { emptyBuilding, migrate } from './model/migrate';
import { saveBlueprint } from './model/library';
import type { ElevationSide } from './model/elevation';

export type Tool = 'select' | 'wall' | 'rect' | 'door' | 'window' | 'arch' | 'stair' | 'roof' | 'chimney' | 'hole';
export type ViewMode = 'plan' | '3d' | ElevationSide;
export type Screen = 'editor' | 'library';

export interface Selection {
  walls: Id[];
  rooms: Id[];
  corners: Id[];
  openings: Id[];
  stairs: Id[];
  roofs: Id[];
  chimneys: Id[];
  holes: Id[];
}

export const EMPTY_SEL: Selection = { walls: [], rooms: [], corners: [], openings: [], stairs: [], roofs: [], chimneys: [], holes: [] };
const SEL_KEYS = Object.keys(EMPTY_SEL) as (keyof Selection)[];
const AUTOSAVE_KEY = 'building-architect:autosave';
const HISTORY_LIMIT = 200;

export function newDoc(name = 'Untitled building'): ProjectDoc {
  return { schema: 'bpa/1', id: uid('doc'), kit: structuredClone(DEFAULT_KIT), building: emptyBuilding(name) };
}

const clone = <T,>(v: T): T => structuredClone(v);

function restackFloors(b: Building) {
  let z = b.floors[0]?.elevation ?? 0;
  for (const f of b.floors) {
    f.elevation = Math.round(z * 1000) / 1000;
    z += f.height;
  }
}

function tidy(b: Building) {
  for (const f of b.floors) {
    normalize(b, f.id);
    syncRooms(b, f.id);
  }
  restackFloors(b);
  // keep openings inside their walls
  for (const o of Object.values(b.openings)) {
    const w = b.walls[o.wallId];
    if (!w) continue;
    const len = Math.hypot(b.corners[w.b].x - b.corners[w.a].x, b.corners[w.b].y - b.corners[w.a].y);
    o.width = Math.min(o.width, len);
    o.offset = Math.round(Math.max(o.width / 2, Math.min(len - o.width / 2, o.offset)) * 1000) / 1000;
  }
  const floorIds = new Set(b.floors.map((f) => f.id));
  for (const s of Object.values(b.stairs)) if (!floorIds.has(s.floorId)) delete b.stairs[s.id];
  for (const r of Object.values(b.roofs)) if (!floorIds.has(r.floorId)) delete b.roofs[r.id];
  for (const c of Object.values(b.chimneys)) if (!floorIds.has(c.floorId)) delete b.chimneys[c.id];
  for (const h of Object.values(b.holes)) if (!floorIds.has(h.floorId)) delete b.holes[h.id];
  syncStairOpenings(b);
  const exists = (id: Id) => !!(b.walls[id] || b.openings[id] || b.rooms[id] || b.stairs[id] || b.roofs[id] || b.chimneys[id] || b.holes[id] || floorIds.has(id));
  for (const g of Object.values(b.groups)) g.members = g.members.filter(exists);
}

function loadAutosave(): ProjectDoc | null {
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    if (!raw) return null;
    return migrate(JSON.parse(raw));
  } catch {
    return null;
  }
}

interface State {
  doc: ProjectDoc;
  past: ProjectDoc[];
  future: ProjectDoc[];
  dragBase: ProjectDoc | null;
  fileName: string | null;
  dirty: boolean;
  activeFloorId: Id;
  tool: Tool;
  view: ViewMode;
  selection: Selection;
  showFloorBelow: boolean;
  showRoofs: boolean;
  screen: Screen;

  /** Apply an edit as one undoable step. */
  commit: (fn: (b: Building, doc: ProjectDoc) => void) => void;
  /** Live edits during a drag: each call re-applies fn to the state at drag start. */
  dragStart: () => void;
  dragUpdate: (fn: (b: Building) => void) => void;
  dragEnd: () => void;
  undo: () => void;
  redo: () => void;
  load: (doc: ProjectDoc, fileName?: string | null) => void;
  markSaved: (fileName: string) => void;
  setTool: (t: Tool) => void;
  setView: (v: ViewMode) => void;
  setActiveFloor: (id: Id) => void;
  select: (sel: Partial<Selection>, additive?: boolean) => void;
  clearSelection: () => void;
  toggleFloorBelow: () => void;
  toggleRoofs: () => void;
  setScreen: (s: Screen) => void;
}

const initial = loadAutosave() ?? newDoc();

export const useStore = create<State>((set, get) => ({
  doc: initial,
  past: [],
  future: [],
  dragBase: null,
  fileName: null,
  dirty: false,
  activeFloorId: initial.building.floors[0].id,
  tool: 'wall',
  view: 'plan',
  selection: EMPTY_SEL,
  showFloorBelow: true,
  showRoofs: true,
  screen: 'editor',

  commit: (fn) => {
    const { doc, past } = get();
    const next = clone(doc);
    fn(next.building, next);
    tidy(next.building);
    set({ doc: next, past: [...past, doc].slice(-HISTORY_LIMIT), future: [], dirty: true });
    pruneSelection();
  },

  dragStart: () => set({ dragBase: get().doc }),
  dragUpdate: (fn) => {
    const base = get().dragBase;
    if (!base) return;
    const next = clone(base);
    fn(next.building);
    syncRoomsLive(next.building);
    set({ doc: next });
  },
  dragEnd: () => {
    const { dragBase, doc, past } = get();
    if (!dragBase) return;
    if (JSON.stringify(dragBase.building) === JSON.stringify(doc.building)) {
      set({ dragBase: null });
      return;
    }
    const next = clone(doc);
    tidy(next.building);
    set({ doc: next, dragBase: null, past: [...past, dragBase].slice(-HISTORY_LIMIT), future: [], dirty: true });
    pruneSelection();
  },

  undo: () => {
    const { past, doc, future } = get();
    if (!past.length) return;
    set({ doc: past[past.length - 1], past: past.slice(0, -1), future: [doc, ...future], dirty: true });
    fixActiveFloor();
    pruneSelection();
  },
  redo: () => {
    const { past, doc, future } = get();
    if (!future.length) return;
    set({ doc: future[0], past: [...past, doc], future: future.slice(1), dirty: true });
    fixActiveFloor();
    pruneSelection();
  },

  load: (doc, fileName = null) => {
    const d = migrate(clone(doc));
    tidy(d.building);
    set({ doc: d, past: [], future: [], fileName, dirty: false, selection: EMPTY_SEL, activeFloorId: d.building.floors[0].id });
  },
  markSaved: (fileName) => set({ fileName, dirty: false }),

  setTool: (tool) => set({ tool }),
  setView: (view) => set({ view }),
  setActiveFloor: (activeFloorId) => set({ activeFloorId, selection: EMPTY_SEL }),
  select: (sel, additive = false) => {
    if (!additive) {
      set({ selection: { ...EMPTY_SEL, ...sel } });
      return;
    }
    const cur = get().selection;
    const toggle = (list: Id[], add: Id[] = []) => {
      const s = new Set(list);
      for (const id of add) (s.has(id) ? s.delete(id) : s.add(id));
      return [...s];
    };
    const next = { ...cur };
    for (const k of SEL_KEYS) next[k] = toggle(cur[k], sel[k]);
    set({ selection: next });
  },
  clearSelection: () => set({ selection: EMPTY_SEL }),
  toggleFloorBelow: () => set({ showFloorBelow: !get().showFloorBelow }),
  toggleRoofs: () => set({ showRoofs: !get().showRoofs }),
  setScreen: (screen) => set({ screen }),
}));

/** During a drag, rooms are recomputed (names kept) without merging corners yet. */
function syncRoomsLive(b: Building) {
  for (const f of b.floors) syncRooms(b, f.id);
  syncStairOpenings(b);
}

function pruneSelection() {
  const { doc, selection } = useStore.getState();
  const b = doc.building;
  useStore.setState({
    selection: {
      walls: selection.walls.filter((id) => b.walls[id]),
      rooms: selection.rooms.filter((id) => b.rooms[id]),
      corners: selection.corners.filter((id) => b.corners[id]),
      openings: selection.openings.filter((id) => b.openings[id]),
      stairs: selection.stairs.filter((id) => b.stairs[id]),
      roofs: selection.roofs.filter((id) => b.roofs[id]),
      chimneys: selection.chimneys.filter((id) => b.chimneys[id]),
      holes: selection.holes.filter((id) => b.holes[id]),
    },
  });
}

function fixActiveFloor() {
  const { doc, activeFloorId } = useStore.getState();
  if (!doc.building.floors.some((f) => f.id === activeFloorId)) useStore.setState({ activeFloorId: doc.building.floors[0].id });
}

// Autosave (crash recovery only; real saves go to .bpa.json files)
let timer: number | undefined;
useStore.subscribe((s, prev) => {
  if (s.doc === prev.doc) return;
  window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    const doc = useStore.getState().doc;
    try {
      localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(doc));
    } catch {
      /* storage unavailable */
    }
    // every structure with content is kept in the blueprint library
    const b = doc.building;
    if (Object.keys(b.walls).length || Object.keys(b.roofs).length || Object.keys(b.stairs).length) {
      saveBlueprint(doc).catch(() => undefined);
    }
  }, 800);
});
