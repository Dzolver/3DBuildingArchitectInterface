// Mutating operations on a Building. The store always calls these on a fresh clone.
import {
  MERGE_DIST,
  cornerAt,
  dist,
  faceKey,
  findFaces,
  mm,
  projectOnSegment,
  segmentIntersection,
  uid,
  wallLength,
  wallsOnFloor,
} from './geometry';
import type { Building, Corner, Id, KitSettings, Opening, OpeningType, Vec2, Wall } from './types';

const AUTO_WALL_TAG = /^f\d+-w(\d+)$/;
const AUTO_ROOM_TAG = /^f\d+-r(\d+)$/;

function floorNumber(b: Building, floorId: Id) {
  return b.floors.findIndex((f) => f.id === floorId) + 1;
}

function nextNumber(tags: string[][], re: RegExp) {
  let max = 0;
  for (const list of tags) for (const t of list) {
    const m = re.exec(t);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

export function nextWallTag(b: Building, floorId: Id) {
  const n = nextNumber(wallsOnFloor(b, floorId).map((w) => w.tags), AUTO_WALL_TAG);
  return `f${floorNumber(b, floorId)}-w${n}`;
}

function nextRoomNumber(b: Building, floorId: Id) {
  return nextNumber(
    Object.values(b.rooms).filter((r) => r.floorId === floorId).map((r) => r.tags),
    AUTO_ROOM_TAG,
  );
}

function newCorner(b: Building, floorId: Id, p: Vec2): Corner {
  const c: Corner = { id: uid('c'), floorId, x: mm(p.x), y: mm(p.y) };
  b.corners[c.id] = c;
  return c;
}

/** Split a wall at an existing corner. The original wall keeps the first half; openings follow their half. */
function splitWallAtCorner(b: Building, wallId: Id, c: Corner): Wall {
  const w = b.walls[wallId];
  const splitAt = dist(b.corners[w.a], c);
  const second: Wall = {
    ...w,
    id: uid('w'),
    a: c.id,
    b: w.b,
    tags: [...w.tags.filter((t) => !AUTO_WALL_TAG.test(t)), nextWallTag(b, w.floorId)],
  };
  w.b = c.id;
  b.walls[second.id] = second;
  for (const o of Object.values(b.openings)) {
    if (o.wallId === w.id && o.offset > splitAt) {
      o.wallId = second.id;
      o.offset = mm(o.offset - splitAt);
    }
  }
  return second;
}

/** Split a wall at point p, returning the new corner. */
export function splitWall(b: Building, wallId: Id, p: Vec2): Corner {
  const c = newCorner(b, b.walls[wallId].floorId, p);
  splitWallAtCorner(b, wallId, c);
  return c;
}

/** Find or create a corner at p; lands on a wall's middle by splitting it. */
export function ensureCorner(b: Building, floorId: Id, p: Vec2): Corner {
  const existing = cornerAt(b, floorId, p);
  if (existing) return existing;
  for (const w of wallsOnFloor(b, floorId)) {
    const pr = projectOnSegment(p, b.corners[w.a], b.corners[w.b]);
    if (pr.d < MERGE_DIST && pr.t > 0 && pr.t < 1) return splitWall(b, w.id, pr.point);
  }
  return newCorner(b, floorId, p);
}

function wallBetween(b: Building, floorId: Id, c1: Id, c2: Id) {
  return wallsOnFloor(b, floorId).find((w) => (w.a === c1 && w.b === c2) || (w.a === c2 && w.b === c1));
}

/** Add a wall from p to q, splitting at every crossing so rooms close correctly. Returns new wall ids. */
export function addWall(b: Building, floorId: Id, p: Vec2, q: Vec2, kit: KitSettings): Id[] {
  if (dist(p, q) < MERGE_DIST) return [];
  const ca = ensureCorner(b, floorId, p);
  const cb = ensureCorner(b, floorId, q);
  if (ca.id === cb.id) return [];
  const A = { x: ca.x, y: ca.y };
  const B = { x: cb.x, y: cb.y };
  const stops: { t: number; id: Id }[] = [
    { t: 0, id: ca.id },
    { t: 1, id: cb.id },
  ];
  // corners lying on the new segment
  for (const c of Object.values(b.corners)) {
    if (c.floorId !== floorId || c.id === ca.id || c.id === cb.id) continue;
    const pr = projectOnSegment(c, A, B);
    if (pr.d < MERGE_DIST && pr.t > 0 && pr.t < 1) stops.push({ t: pr.t, id: c.id });
  }
  // crossings with existing walls
  for (const w of wallsOnFloor(b, floorId)) {
    const wa = b.corners[w.a];
    const wb = b.corners[w.b];
    const hit = segmentIntersection(A, B, wa, wb);
    if (!hit) continue;
    if (hit.u * dist(wa, wb) < MERGE_DIST || (1 - hit.u) * dist(wa, wb) < MERGE_DIST) continue; // at the wall's end
    if (hit.t * dist(A, B) < MERGE_DIST || (1 - hit.t) * dist(A, B) < MERGE_DIST) continue; // at our end
    const c = splitWall(b, w.id, hit.point);
    stops.push({ t: hit.t, id: c.id });
  }
  stops.sort((s1, s2) => s1.t - s2.t);
  const ids: Id[] = [];
  for (let i = 0; i < stops.length - 1; i++) {
    const s = stops[i].id;
    const e = stops[i + 1].id;
    if (s === e || wallBetween(b, floorId, s, e)) continue;
    const w: Wall = {
      id: uid('w'),
      floorId,
      a: s,
      b: e,
      thickness: kit.wallThickness,
      height: null,
      kind: 'exterior',
      tags: [nextWallTag(b, floorId)],
    };
    b.walls[w.id] = w;
    ids.push(w.id);
  }
  return ids;
}

export function addRectangle(b: Building, floorId: Id, p: Vec2, q: Vec2, kit: KitSettings): Id[] {
  const pts = [p, { x: q.x, y: p.y }, q, { x: p.x, y: q.y }];
  const ids: Id[] = [];
  for (let i = 0; i < 4; i++) ids.push(...addWall(b, floorId, pts[i], pts[(i + 1) % 4], kit));
  return ids;
}

export function removeOrphanCorners(b: Building) {
  const used = new Set<Id>();
  for (const w of Object.values(b.walls)) {
    used.add(w.a);
    used.add(w.b);
  }
  for (const id of Object.keys(b.corners)) if (!used.has(id)) delete b.corners[id];
}

export function deleteWalls(b: Building, ids: Id[]) {
  const gone = new Set(ids);
  for (const id of ids) delete b.walls[id];
  for (const o of Object.values(b.openings)) if (gone.has(o.wallId)) delete b.openings[o.id];
  removeOrphanCorners(b);
}

/**
 * Clean up after a drag: merge coincident corners, drop zero-length and duplicate
 * walls, and split walls where a corner now sits on them (T-junctions).
 */
export function normalize(b: Building, floorId: Id) {
  const corners = Object.values(b.corners).filter((c) => c.floorId === floorId);
  const remap = new Map<Id, Id>();
  for (let i = 0; i < corners.length; i++) {
    if (remap.has(corners[i].id)) continue;
    for (let j = i + 1; j < corners.length; j++) {
      if (!remap.has(corners[j].id) && dist(corners[i], corners[j]) < MERGE_DIST) remap.set(corners[j].id, corners[i].id);
    }
  }
  for (const w of wallsOnFloor(b, floorId)) {
    w.a = remap.get(w.a) ?? w.a;
    w.b = remap.get(w.b) ?? w.b;
  }
  const seen = new Set<string>();
  for (const w of wallsOnFloor(b, floorId)) {
    const key = [w.a, w.b].sort().join('|');
    if (w.a === w.b || seen.has(key)) delete b.walls[w.id];
    else seen.add(key);
  }
  // T-junctions
  let changed = true;
  let guard = 0;
  while (changed && guard++ < 1000) {
    changed = false;
    outer: for (const c of Object.values(b.corners)) {
      if (c.floorId !== floorId) continue;
      for (const w of wallsOnFloor(b, floorId)) {
        if (w.a === c.id || w.b === c.id) continue;
        const pr = projectOnSegment(c, b.corners[w.a], b.corners[w.b]);
        if (pr.d < MERGE_DIST && pr.t > 0 && pr.t < 1) {
          splitWallAtCorner(b, w.id, c);
          changed = true;
          break outer;
        }
      }
    }
  }
  removeOrphanCorners(b);
  for (const o of Object.values(b.openings)) if (!b.walls[o.wallId]) delete b.openings[o.id];
}

/** Recompute rooms on a floor from its walls, keeping names and tags of rooms that still exist. */
export function syncRooms(b: Building, floorId: Id) {
  const faces = findFaces(b, floorId);
  const old = Object.values(b.rooms).filter((r) => r.floorId === floorId);
  const byKey = new Map(old.map((r) => [r.key, r]));
  const claimed = new Set<Id>();
  const result: { key: string; cornerIds: Id[]; roomId?: Id }[] = faces.map((f) => ({ key: faceKey(f.cornerIds), cornerIds: f.cornerIds }));
  // exact matches first
  for (const r of result) {
    const m = byKey.get(r.key);
    if (m && !claimed.has(m.id)) {
      r.roomId = m.id;
      claimed.add(m.id);
    }
  }
  // then best corner overlap, so a room survives a wall being split or a corner moved
  for (const r of result) {
    if (r.roomId) continue;
    const set = new Set(r.cornerIds);
    let best: { id: Id; score: number } | null = null;
    for (const o of old) {
      if (claimed.has(o.id)) continue;
      const oc = o.key.split('|');
      const inter = oc.filter((id) => set.has(id)).length;
      const score = inter / Math.max(oc.length, set.size);
      if (score >= 0.5 && (!best || score > best.score)) best = { id: o.id, score };
    }
    if (best) {
      r.roomId = best.id;
      claimed.add(best.id);
    }
  }
  for (const o of old) if (!claimed.has(o.id)) delete b.rooms[o.id];
  for (const r of result) {
    if (r.roomId) {
      b.rooms[r.roomId].key = r.key;
    } else {
      const n = nextRoomNumber(b, floorId);
      const id = uid('r');
      b.rooms[id] = { id, floorId, key: r.key, name: `Room ${n}`, tags: [`f${floorNumber(b, floorId)}-r${n}`] };
    }
  }
}

/** Move a set of corners by a delta (snapped by the caller). */
export function moveCorners(b: Building, ids: Id[], delta: Vec2, origin: Record<Id, Vec2>) {
  for (const id of ids) {
    const c = b.corners[id];
    const o = origin[id];
    if (!c || !o) continue;
    c.x = mm(o.x + delta.x);
    c.y = mm(o.y + delta.y);
  }
}

/**
 * Set a wall's length by stretching the plan: every corner on this floor at or beyond the
 * wall's far end (measured along the wall) shifts with it, so attached walls stay square.
 */
export function setWallLength(b: Building, wallId: Id, length: number) {
  const w = b.walls[wallId];
  const A = b.corners[w.a];
  const B = b.corners[w.b];
  const len = dist(A, B);
  if (len < 1e-9 || length <= 0) return;
  const ux = (B.x - A.x) / len;
  const uy = (B.y - A.y) / len;
  const delta = length - len;
  const along = (p: Vec2) => (p.x - A.x) * ux + (p.y - A.y) * uy;
  for (const c of Object.values(b.corners)) {
    if (c.floorId !== w.floorId) continue;
    if (along(c) >= len - MERGE_DIST) {
      c.x = mm(c.x + ux * delta);
      c.y = mm(c.y + uy * delta);
    }
  }
}

// ---------- merging walls ----------

function wallsAt(b: Building, cornerId: Id) {
  return Object.values(b.walls).filter((w) => w.a === cornerId || w.b === cornerId);
}

function collinear(b: Building, w1: Wall, w2: Wall) {
  const d1 = { x: b.corners[w1.b].x - b.corners[w1.a].x, y: b.corners[w1.b].y - b.corners[w1.a].y };
  const d2 = { x: b.corners[w2.b].x - b.corners[w2.a].x, y: b.corners[w2.b].y - b.corners[w2.a].y };
  const l1 = Math.hypot(d1.x, d1.y);
  const l2 = Math.hypot(d2.x, d2.y);
  return Math.abs(d1.x * d2.y - d1.y * d2.x) / (l1 * l2) < 1e-4;
}

/**
 * Merge connected, parallel walls into single walls. Two walls merge when they meet at a
 * corner that no other wall uses and run in the same line. Returns the surviving wall ids.
 */
export function mergeWalls(b: Building, ids: Id[]): Id[] {
  const pool = new Set(ids.filter((id) => b.walls[id]));
  let merged = true;
  while (merged) {
    merged = false;
    for (const id of pool) {
      const w = b.walls[id];
      for (const end of [w.a, w.b]) {
        const at = wallsAt(b, end);
        if (at.length !== 2) continue;
        const other = at.find((x) => x.id !== w.id)!;
        if (!pool.has(other.id) || other.floorId !== w.floorId || !collinear(b, w, other)) continue;
        // orient: w runs P -> end, other runs end -> Q
        const P = w.a === end ? w.b : w.a;
        const Q = other.a === end ? other.b : other.a;
        const lenW = dist(b.corners[P], b.corners[end]);
        const lenO = dist(b.corners[end], b.corners[Q]);
        const oldLenW = wallLength(b, w);
        // openings: re-measure from P
        for (const o of Object.values(b.openings)) {
          if (o.wallId === w.id) o.offset = w.a === P ? o.offset : mm(oldLenW - o.offset);
          else if (o.wallId === other.id) {
            o.wallId = w.id;
            o.offset = mm(lenW + (other.a === end ? o.offset : lenO - o.offset));
          }
        }
        w.a = P;
        w.b = Q;
        w.thickness = Math.max(w.thickness, other.thickness);
        const auto = w.tags.filter((t) => AUTO_WALL_TAG.test(t));
        const extra = [...w.tags, ...other.tags].filter((t) => !AUTO_WALL_TAG.test(t));
        w.tags = [...new Set([...auto.slice(0, 1), ...extra])];
        for (const g of Object.values(b.groups)) g.members = [...new Set(g.members.map((m) => (m === other.id ? w.id : m)))];
        delete b.walls[other.id];
        delete b.corners[end];
        pool.delete(other.id);
        merged = true;
        break;
      }
      if (merged) break;
    }
  }
  return [...pool];
}

/** How many of these walls would merge (for enabling the button). */
export function mergeableCount(b: Building, ids: Id[]): number {
  const set = new Set(ids);
  let n = 0;
  for (const id of ids) {
    const w = b.walls[id];
    if (!w) continue;
    for (const end of [w.a, w.b]) {
      const at = wallsAt(b, end);
      if (at.length === 2) {
        const other = at.find((x) => x.id !== w.id)!;
        if (set.has(other.id) && collinear(b, w, other)) n++;
      }
    }
  }
  return n / 2;
}

// ---------- openings ----------

export function addOpening(b: Building, wallId: Id, type: OpeningType, offset: number, width: number, kit: KitSettings): Opening {
  const len = wallLength(b, b.walls[wallId]);
  const wdt = Math.min(width, len);
  const o: Opening = {
    id: uid('o'),
    wallId,
    type,
    offset: mm(Math.max(wdt / 2, Math.min(len - wdt / 2, offset))),
    width: mm(wdt),
    height: type === 'window' ? kit.window.height : kit.door.height,
    sill: type === 'window' ? kit.window.sill : 0,
    tags: [],
  };
  const w = b.walls[wallId];
  const n = Object.values(b.openings).filter((x) => b.walls[x.wallId]?.floorId === w.floorId && x.type === type).length + 1;
  const f = b.floors.findIndex((fl) => fl.id === w.floorId) + 1;
  o.tags.push(`f${f}-${type === 'window' ? 'win' : type === 'door' ? 'd' : 'arch'}${n}`);
  b.openings[o.id] = o;
  return o;
}

// ---------- centre / origin ----------

/** Centre of the building footprint: middle of the bounding box of all walls' outer faces on the ground floor (or any floor). */
export function buildingCentre(b: Building, floorId?: Id): Vec2 | null {
  const target = floorId ?? b.floors[0]?.id;
  let cs = Object.values(b.corners).filter((c) => c.floorId === target);
  if (!cs.length) cs = Object.values(b.corners);
  if (!cs.length) return null;
  const xs = cs.map((c) => c.x);
  const ys = cs.map((c) => c.y);
  return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
}

export function footprint(b: Building, floorId: Id) {
  const cs = Object.values(b.corners).filter((c) => c.floorId === floorId);
  if (!cs.length) return null;
  const walls = Object.values(b.walls).filter((w) => w.floorId === floorId);
  const t = walls.length ? Math.max(...walls.map((w) => w.thickness)) / 2 : 0;
  const xs = cs.map((c) => c.x);
  const ys = cs.map((c) => c.y);
  return { minX: Math.min(...xs) - t, maxX: Math.max(...xs) + t, minY: Math.min(...ys) - t, maxY: Math.max(...ys) + t };
}

/** Move everything so the ground-floor centre sits on the world origin (snapped to `step`). */
export function recentre(b: Building, step: number) {
  const c = buildingCentre(b);
  if (!c) return;
  const dx = -Math.round(c.x / step) * step;
  const dy = -Math.round(c.y / step) * step;
  for (const k of Object.values(b.corners)) {
    k.x = mm(k.x + dx);
    k.y = mm(k.y + dy);
  }
  for (const s of [...Object.values(b.stairs), ...Object.values(b.roofs), ...Object.values(b.chimneys), ...Object.values(b.holes)]) {
    s.x = mm(s.x + dx);
    s.y = mm(s.y + dy);
  }
}

// ---------- visibility ----------

/** An item is visible unless it, its wall, its floor or any group holding them is hidden. */
export function isHidden(b: Building, id: Id): boolean {
  const hiddenGroups = Object.values(b.groups).filter((g) => g.hidden);
  const inHiddenGroup = (x: Id) => hiddenGroups.some((g) => g.members.includes(x));
  const w = b.walls[id];
  if (w) return !!w.hidden || inHiddenGroup(id) || inHiddenGroup(w.floorId);
  const o = b.openings[id];
  if (o) return !!o.hidden || inHiddenGroup(id) || isHidden(b, o.wallId);
  const s = b.stairs[id];
  if (s) return !!s.hidden || inHiddenGroup(id) || inHiddenGroup(s.floorId);
  const r = b.roofs[id];
  if (r) return !!r.hidden || inHiddenGroup(id) || inHiddenGroup(r.floorId);
  const h = b.holes[id];
  if (h) return !!h.hidden || inHiddenGroup(id) || inHiddenGroup(h.floorId) || (!!h.stairId && !!b.stairs[h.stairId] && isHidden(b, h.stairId));
  const c = b.chimneys[id];
  if (c) return !!c.hidden || inHiddenGroup(id) || inHiddenGroup(c.floorId);
  return inHiddenGroup(id);
}

// ---------- floor openings ----------

/** Next free opening tag number on a floor (f2-o1, f2-o2, ...). */
export function nextHoleTag(b: Building, floorId: Id): string {
  const fi = b.floors.findIndex((f) => f.id === floorId);
  const used = new Set(Object.values(b.holes).flatMap((h) => h.tags));
  let n = 1;
  while (used.has(`f${fi + 1}-o${n}`)) n++;
  return `f${fi + 1}-o${n}`;
}

/**
 * Keep every stair's opening in the floor above: create it when missing, size it to the stair
 * plus its margin while it is automatic, and drop openings whose stair is gone or has no floor above.
 */
export function syncStairOpenings(b: Building) {
  for (const h of Object.values(b.holes)) if (h.stairId && !b.stairs[h.stairId]) delete b.holes[h.id];
  for (const s of Object.values(b.stairs)) {
    const idx = b.floors.findIndex((f) => f.id === s.floorId);
    const above = b.floors[idx + 1];
    const mine = Object.values(b.holes).filter((h) => h.stairId === s.id);
    if (!above || s.opening === false) {
      mine.forEach((h) => delete b.holes[h.id]);
      continue;
    }
    mine.slice(1).forEach((h) => delete b.holes[h.id]);
    let h = mine[0];
    if (!h) {
      const id = uid('h');
      h = b.holes[id] = { id, floorId: above.id, name: `Stair opening (${s.name})`, x: 0, y: 0, w: 1, d: 1, angle: 0, stairId: s.id, auto: true, tags: [nextHoleTag(b, above.id)] };
    }
    h.floorId = above.id;
    if (h.auto) {
      const m = s.openingMargin ?? 0.15;
      h.x = mm(s.x - m);
      h.y = mm(s.y - m);
      h.w = mm(s.w + 2 * m);
      h.d = mm(s.d + 2 * m);
      h.angle = s.angle ?? 0;
      h.name = `Stair opening (${s.name})`;
    }
  }
}
