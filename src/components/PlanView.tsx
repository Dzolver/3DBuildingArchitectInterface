import { useEffect, useMemo, useRef, useState } from 'react';
import { EMPTY_SEL, useStore, type Selection } from '../store';
import { addOpening, addRectangle, addWall, buildingCentre, footprint, isHidden, moveCorners, nextHoleTag } from '../model/ops';
import {
  bbox,
  centroid,
  cornerAt,
  dist,
  findFaces,
  faceKey,
  mm,
  pointInPolygon,
  projectOnSegment,
  roomInterior,
  signedArea,
  snap,
  uid,
  wallLength,
  wallsOnFloor,
  rotRect,
} from '../model/geometry';
import { chimneyRect, chimneyTop, planOutline, roofParts, roofRect } from '../model/solids';
import { stairLayout, stairRect } from '../model/stairs';
import { STAIR_DEFAULTS, type Building, type Id, type OpeningType, type Quarter, type Vec2 } from '../model/types';
import { fmt } from '../format';

interface Viewport {
  scale: number; // px per metre
  ox: number; // screen x of world origin
  oy: number; // screen y of world origin
}

type Gesture =
  | { kind: 'none' }
  | { kind: 'pan'; start: Vec2; vp: Viewport }
  | { kind: 'rect'; start: Vec2; purpose: 'room' | 'stair' | 'roof' | 'chimney' | 'hole' }
  | { kind: 'resize'; what: 'holes' | 'stairs'; id: Id; fixed: Vec2; angle: number; orig: Vec2 }
  | { kind: 'rotate'; what: 'roofs' | 'stairs'; id: Id; centre: Vec2; startAng: number; angle0: number }
  | { kind: 'box'; start: Vec2; additive: boolean }
  | { kind: 'opening'; wallId: Id; startS: number }
  | {
      kind: 'move';
      startWorld: Vec2;
      cornerIds: Id[];
      origin: Record<Id, Vec2>;
      rects: { kind: 'stairs' | 'roofs' | 'chimneys' | 'holes'; id: Id; x: number; y: number }[];
      openings: { id: Id; offset: number; wallId: Id }[];
      moved: boolean;
    };

const SNAP_PX = 10;
let savedVp: Viewport | null = null;

export function PlanView() {
  const svgRef = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [vp, setVpState] = useState<Viewport>(savedVp ?? { scale: 40, ox: 260, oy: 520 });
  const setVp = (v: Viewport) => {
    savedVp = v;
    setVpState(v);
  };
  const [cursor, setCursor] = useState<Vec2 | null>(null);
  const [chainStart, setChainStart] = useState<Vec2 | null>(null);
  const [gesture, setGesture] = useState<Gesture>({ kind: 'none' });
  const [mods, setMods] = useState({ shift: false, alt: false });

  const doc = useStore((s) => s.doc);
  const tool = useStore((s) => s.tool);
  const floorId = useStore((s) => s.activeFloorId);
  const selection = useStore((s) => s.selection);
  const showFloorBelow = useStore((s) => s.showFloorBelow);
  const showRoofs = useStore((s) => s.showRoofs);
  const b = doc.building;
  const kit = doc.kit;

  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setSize({ w: r.width, h: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      setMods({ shift: e.shiftKey, alt: e.altKey });
      if (e.key === 'Escape') {
        setChainStart(null);
        setGesture({ kind: 'none' });
      }
    };
    const up = (e: KeyboardEvent) => setMods({ shift: e.shiftKey, alt: e.altKey });
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  useEffect(() => setChainStart(null), [tool, floorId]);

  const toWorld = (sx: number, sy: number): Vec2 => ({ x: (sx - vp.ox) / vp.scale, y: (vp.oy - sy) / vp.scale });
  const toScreen = (p: Vec2) => ({ x: vp.ox + p.x * vp.scale, y: vp.oy - p.y * vp.scale });

  const step = mods.shift ? kit.fineGrid : kit.module;

  const snapPoint = (p: Vec2): Vec2 => {
    const c = cornerAt(b, floorId, p, SNAP_PX / vp.scale);
    if (c) return { x: c.x, y: c.y };
    if (mods.alt) return { x: mm(p.x), y: mm(p.y) };
    return { x: snap(p.x, step), y: snap(p.y, step) };
  };
  /** Snap to the fine grid (chimneys are small, so they ignore the 2 m module). */
  const snapFine = (p: Vec2): Vec2 => (mods.alt ? { x: mm(p.x), y: mm(p.y) } : { x: snap(p.x, kit.fineGrid), y: snap(p.y, kit.fineGrid) });

  const localPoint = (e: React.PointerEvent | React.WheelEvent) => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const floorIndex = b.floors.findIndex((f) => f.id === floorId);
  const floor = b.floors[floorIndex];
  const floorBelow = floorIndex > 0 ? b.floors[floorIndex - 1] : null;
  const faces = useMemo(() => findFaces(b, floorId), [b, floorId]);
  const facesBelow = useMemo(() => (floorBelow ? findFaces(b, floorBelow.id) : []), [b, floorBelow]);
  const walls = wallsOnFloor(b, floorId);
  const stairsHere = Object.values(b.stairs).filter((s) => s.floorId === floorId);
  const holesHere = Object.values(b.holes).filter((h) => h.floorId === floorId);
  const roofsHere = Object.values(b.roofs).filter((r) => r.floorId === floorId);
  const chimneysHere = Object.values(b.chimneys).filter((c) => {
    const fi = b.floors.findIndex((f) => f.id === c.floorId);
    return fi === floorIndex || (fi >= 0 && fi < floorIndex && floor && chimneyTop(b, c) > floor.elevation);
  });
  /** Rotation handle of the one selected roof or stair: world position of the knob and the centre. */
  const rotHandle = (() => {
    if (tool !== 'select') return null;
    const total = Object.values(selection).reduce((n, l) => n + l.length, 0);
    if (total !== 1) return null;
    const r = showRoofs && selection.roofs.length === 1 ? b.roofs[selection.roofs[0]] : null;
    const st = selection.stairs.length === 1 ? b.stairs[selection.stairs[0]] : null;
    const item = r ?? st;
    if (!item || item.floorId !== floorId) return null;
    const a = ((item.angle ?? 0) * Math.PI) / 180;
    const centre = { x: item.x + item.w / 2, y: item.y + item.d / 2 };
    const reach = item.d / 2 + (r ? r.overhang : 0) + 30 / vp.scale;
    return { what: (r ? 'roofs' : 'stairs') as 'roofs' | 'stairs', id: item.id, angle: item.angle ?? 0, centre, knob: { x: centre.x - Math.sin(a) * reach, y: centre.y + Math.cos(a) * reach } };
  })();
  /** Corner handles of the one selected floor opening or stair, for resizing. */
  const sizeHandles = (() => {
    if (tool !== 'select') return null;
    const total = Object.values(selection).reduce((n, l) => n + l.length, 0);
    if (total !== 1) return null;
    const h = selection.holes.length === 1 ? b.holes[selection.holes[0]] : null;
    const st = selection.stairs.length === 1 ? b.stairs[selection.stairs[0]] : null;
    const item = h ?? st;
    if (!item || item.floorId !== floorId) return null;
    return { what: (h ? 'holes' : 'stairs') as 'holes' | 'stairs', id: item.id, angle: item.angle ?? 0, corners: rotRect(item) };
  })();
  const centre = useMemo(() => buildingCentre(b), [b]);
  const fp = useMemo(() => footprint(b, floorId), [b, floorId]);
  const planCentre = fp ? { x: (fp.minX + fp.maxX) / 2, y: (fp.minY + fp.maxY) / 2 } : { x: 0, y: 0 };

  /** Position along a wall (distance from corner a), snapped to fine-grid nodes. */
  const alongWall = (wallId: Id, p: Vec2, free = false) => {
    const w = b.walls[wallId];
    const A = b.corners[w.a];
    const B = b.corners[w.b];
    const len = dist(A, B);
    const pr = projectOnSegment(p, A, B);
    const s = pr.t * len;
    return free ? mm(s) : Math.max(0, Math.min(len, snap(s, kit.fineGrid)));
  };

  const wallUnder = (p: Vec2): Id | null => {
    const tol = 10 / vp.scale;
    let best: { id: Id; d: number } | null = null;
    for (const w of walls) {
      const pr = projectOnSegment(p, b.corners[w.a], b.corners[w.b]);
      if (pr.d <= Math.max(w.thickness / 2, tol) && (!best || pr.d < best.d)) best = { id: w.id, d: pr.d };
    }
    return best?.id ?? null;
  };

  const roomAt = (p: Vec2) => {
    let room: { id: Id; area: number } | null = null;
    for (const f of faces) {
      if (!pointInPolygon(p, f.polygon)) continue;
      const r = Object.values(b.rooms).find((x) => x.floorId === floorId && x.key === faceKey(f.cornerIds));
      const area = signedArea(f.polygon);
      if (r && (!room || area < room.area)) room = { id: r.id, area };
    }
    return room?.id;
  };

  // hit testing, most specific first
  const hit = (p: Vec2): Partial<Selection> => {
    const tol = 8 / vp.scale;
    const c = cornerAt(b, floorId, p, tol);
    if (c) return { corners: [c.id] };
    for (const ch of chimneysHere) if (pointInPolygon(p, chimneyRect(ch))) return { chimneys: [ch.id] };
    for (const o of Object.values(b.openings)) {
      const w = b.walls[o.wallId];
      if (!w || w.floorId !== floorId) continue;
      const A = b.corners[w.a];
      const B = b.corners[w.b];
      const len = dist(A, B);
      const pr = projectOnSegment(p, A, B);
      const s = pr.t * len;
      if (pr.d <= Math.max(w.thickness / 2, tol) && Math.abs(s - o.offset) <= o.width / 2) return { openings: [o.id] };
    }
    const wid = wallUnder(p);
    if (wid) return { walls: [wid] };
    if (showRoofs) {
      for (const r of roofsHere) {
        for (const piece of roofParts(b, r)) {
          for (const poly of piece.parts ?? [piece.polygon]) {
            for (let i = 0; i < poly.length; i++) {
              if (projectOnSegment(p, poly[i], poly[(i + 1) % poly.length]).d < tol) return { roofs: [r.id] };
            }
          }
        }
      }
    }
    for (const s of stairsHere) if (pointInPolygon(p, stairRect(s))) return { stairs: [s.id] };
    for (const h of holesHere) if (pointInPolygon(p, rotRect(h))) return { holes: [h.id] };
    const room = roomAt(p);
    return room ? { rooms: [room] } : {};
  };

  const isSelected = (h: Partial<Selection>) =>
    (Object.keys(h) as (keyof Selection)[]).some((k) => h[k]!.some((id) => selection[k].includes(id)));

  const onPointerDown = (e: React.PointerEvent) => {
    svgRef.current?.setPointerCapture(e.pointerId);
    const sp = localPoint(e);
    const wp = toWorld(sp.x, sp.y);
    if (e.button === 1 || e.button === 2) {
      setGesture({ kind: 'pan', start: sp, vp });
      return;
    }
    if (e.button !== 0) return;
    const store = useStore.getState();
    if (tool === 'wall') {
      const p = snapPoint(wp);
      if (!chainStart) {
        setChainStart(p);
        return;
      }
      if (dist(p, chainStart) < 1e-6) {
        setChainStart(null);
        return;
      }
      const landsOnCorner = !!cornerAt(b, floorId, p);
      store.commit((bb) => {
        addWall(bb, floorId, chainStart, p, store.doc.kit);
      });
      setChainStart(landsOnCorner ? null : p);
      return;
    }
    if (tool === 'rect' || tool === 'stair' || tool === 'roof' || tool === 'hole') {
      setGesture({ kind: 'rect', start: snapPoint(wp), purpose: tool === 'rect' ? 'room' : tool });
      return;
    }
    if (tool === 'chimney') {
      setGesture({ kind: 'rect', start: snapFine(wp), purpose: 'chimney' });
      return;
    }
    if (tool === 'door' || tool === 'window' || tool === 'arch') {
      const wid = wallUnder(wp);
      if (wid) setGesture({ kind: 'opening', wallId: wid, startS: alongWall(wid, wp, e.altKey) });
      return;
    }
    // select tool
    if (sizeHandles) {
      const i = sizeHandles.corners.findIndex((c) => dist(toScreen(wp), toScreen(c)) <= 8);
      if (i >= 0) {
        store.dragStart();
        const fixed = sizeHandles.corners[(i + 2) % 4];
        const c = sizeHandles.corners[i];
        const ra = (sizeHandles.angle * Math.PI) / 180;
        const ox = c.x - fixed.x;
        const oy = c.y - fixed.y;
        const orig = { x: ox * Math.cos(ra) + oy * Math.sin(ra), y: -ox * Math.sin(ra) + oy * Math.cos(ra) };
        setGesture({ kind: 'resize', what: sizeHandles.what, id: sizeHandles.id, fixed, angle: sizeHandles.angle, orig });
        return;
      }
    }
    if (rotHandle && dist(toScreen(wp), toScreen(rotHandle.knob)) <= 10) {
      store.dragStart();
      setGesture({ kind: 'rotate', what: rotHandle.what, id: rotHandle.id, centre: rotHandle.centre, startAng: Math.atan2(wp.y - rotHandle.centre.y, wp.x - rotHandle.centre.x), angle0: rotHandle.angle });
      return;
    }
    const h = hit(wp);
    const additive = e.shiftKey;
    if (!Object.keys(h).length) {
      if (!additive) store.clearSelection();
      setGesture({ kind: 'box', start: wp, additive });
      return;
    }
    if (!isSelected(h)) store.select(h, additive);
    else if (additive) {
      store.select(h, true);
      return;
    }
    const sel = useStore.getState().selection;
    const ids = new Set<Id>(sel.corners);
    sel.walls.forEach((id) => {
      ids.add(b.walls[id].a);
      ids.add(b.walls[id].b);
    });
    sel.rooms.forEach((id) => b.rooms[id]?.key.split('|').forEach((c) => ids.add(c)));
    const origin: Record<Id, Vec2> = {};
    ids.forEach((id) => (origin[id] = { x: b.corners[id].x, y: b.corners[id].y }));
    const rects = [
      ...sel.stairs.map((id) => ({ kind: 'stairs' as const, id, x: b.stairs[id].x, y: b.stairs[id].y })),
      ...sel.roofs.map((id) => ({ kind: 'roofs' as const, id, x: b.roofs[id].x, y: b.roofs[id].y })),
      ...sel.chimneys.map((id) => ({ kind: 'chimneys' as const, id, x: b.chimneys[id].x, y: b.chimneys[id].y })),
      ...sel.holes.map((id) => ({ kind: 'holes' as const, id, x: b.holes[id].x, y: b.holes[id].y })),
    ];
    // openings slide along their wall (only when the wall itself isn't moving)
    const openings = sel.openings
      .filter((id) => !sel.walls.includes(b.openings[id].wallId))
      .map((id) => ({ id, offset: b.openings[id].offset, wallId: b.openings[id].wallId }));
    store.dragStart();
    setGesture({ kind: 'move', startWorld: wp, cornerIds: [...ids], origin, rects, openings, moved: false });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const sp = localPoint(e);
    const wp = toWorld(sp.x, sp.y);
    setCursor(wp);
    setMods({ shift: e.shiftKey, alt: e.altKey });
    if (gesture.kind === 'resize') {
      const g = gesture;
      const a = (g.angle * Math.PI) / 180;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const dx = wp.x - g.fixed.x;
      const dy = wp.y - g.fixed.y;
      const st = e.altKey ? 0.001 : e.shiftKey ? kit.fineGrid : kit.module;
      // move the dragged corner by whole snap steps in the item's own frame; keep at least 0.25 m
      const sn = (raw: number, o: number) => {
        const v = o + Math.round((raw - o) / st) * st;
        const sign = Math.sign(o) || 1;
        return sign * Math.max(0.25, v * sign);
      };
      const lu = sn(dx * ca + dy * sa, g.orig.x);
      const lv = sn(-dx * sa + dy * ca, g.orig.y);
      const cx = g.fixed.x + (lu / 2) * ca - (lv / 2) * sa;
      const cy = g.fixed.y + (lu / 2) * sa + (lv / 2) * ca;
      useStore.getState().dragUpdate((bb) => {
        const item = bb[g.what][g.id];
        item.w = mm(Math.abs(lu));
        item.d = mm(Math.abs(lv));
        item.x = mm(cx - item.w / 2);
        item.y = mm(cy - item.d / 2);
        if (g.what === 'holes') bb.holes[g.id].auto = false;
      });
    } else if (gesture.kind === 'rotate') {
      const g = gesture;
      const now = Math.atan2(wp.y - g.centre.y, wp.x - g.centre.x);
      let a = g.angle0 + ((now - g.startAng) * 180) / Math.PI;
      const stepDeg = e.altKey ? 0.1 : e.shiftKey ? 1 : 15;
      a = Math.round(a / stepDeg) * stepDeg;
      a = Math.round((((a % 360) + 540) % 360 - 180) * 10) / 10;
      useStore.getState().dragUpdate((bb) => {
        bb[g.what][g.id].angle = a;
      });
    } else if (gesture.kind === 'pan') {
      setVp({ ...gesture.vp, ox: gesture.vp.ox + sp.x - gesture.start.x, oy: gesture.vp.oy + sp.y - gesture.start.y });
    } else if (gesture.kind === 'move') {
      const st = e.shiftKey ? kit.fineGrid : kit.module;
      const raw = { x: wp.x - gesture.startWorld.x, y: wp.y - gesture.startWorld.y };
      const delta = e.altKey ? raw : { x: snap(raw.x, st), y: snap(raw.y, st) };
      const g = gesture;
      useStore.getState().dragUpdate((bb) => {
        moveCorners(bb, g.cornerIds, delta, g.origin);
        for (const r of g.rects) {
          const item = bb[r.kind][r.id];
          item.x = mm(r.x + delta.x);
          item.y = mm(r.y + delta.y);
          // a stair opening moved by hand stops following its stair
          if (r.kind === 'holes' && (delta.x || delta.y)) bb.holes[r.id].auto = false;
        }
        for (const o of g.openings) {
          const w = bb.walls[o.wallId];
          const A = bb.corners[w.a];
          const B = bb.corners[w.b];
          const len = dist(A, B);
          const along = ((B.x - A.x) * raw.x + (B.y - A.y) * raw.y) / len;
          const s = e.altKey ? along : snap(along, kit.fineGrid);
          const op = bb.openings[o.id];
          op.offset = mm(Math.max(op.width / 2, Math.min(len - op.width / 2, o.offset + s)));
        }
      });
      if (!gesture.moved && (delta.x || delta.y)) setGesture({ ...gesture, moved: true });
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const sp = localPoint(e);
    const wp = toWorld(sp.x, sp.y);
    const store = useStore.getState();
    if (gesture.kind === 'rect' && gesture.purpose === 'hole') {
      const q = snapPoint(wp);
      const s0 = gesture.start;
      if (Math.abs(q.x - s0.x) > 1e-6 && Math.abs(q.y - s0.y) > 1e-6) {
        const id = uid('h');
        store.commit((bb) => {
          const n = Object.values(bb.holes).filter((h) => h.floorId === floorId).length + 1;
          bb.holes[id] = { id, floorId, name: `Opening ${n}`, x: Math.min(s0.x, q.x), y: Math.min(s0.y, q.y), w: mm(Math.abs(q.x - s0.x)), d: mm(Math.abs(q.y - s0.y)), angle: 0, stairId: null, auto: false, tags: [nextHoleTag(bb, floorId)] };
        });
        store.select({ holes: [id] });
      }
    } else if (gesture.kind === 'rect' && gesture.purpose === 'chimney') {
      const q = snapFine(wp);
      const s0 = gesture.start;
      const dragged = Math.abs(q.x - s0.x) >= 0.25 && Math.abs(q.y - s0.y) >= 0.25;
      const id = uid('ch');
      store.commit((bb) => {
        const n = Object.values(bb.chimneys).filter((c) => c.floorId === floorId).length + 1;
        bb.chimneys[id] = {
          id,
          floorId,
          name: `Chimney ${n}`,
          x: dragged ? mm((s0.x + q.x) / 2) : s0.x,
          y: dragged ? mm((s0.y + q.y) / 2) : s0.y,
          w: dragged ? mm(Math.abs(q.x - s0.x)) : 0.75,
          d: dragged ? mm(Math.abs(q.y - s0.y)) : 0.75,
          angle: 0,
          top: null,
          clearance: 0.9,
          crown: true,
          tags: [`f${floorIndex + 1}-ch${n}`],
        };
      });
      store.select({ chimneys: [id] });
      store.setTool('select');
    } else if (gesture.kind === 'rect') {
      const q = snapPoint(wp);
      const s0 = gesture.start;
      if (Math.abs(q.x - s0.x) > 1e-6 && Math.abs(q.y - s0.y) > 1e-6) {
        const x = Math.min(s0.x, q.x);
        const y = Math.min(s0.y, q.y);
        const w = Math.abs(q.x - s0.x);
        const d = Math.abs(q.y - s0.y);
        if (gesture.purpose === 'room') {
          store.commit((bb) => {
            addRectangle(bb, floorId, s0, q, store.doc.kit);
          });
        } else if (gesture.purpose === 'stair') {
          const id = uid('s');
          // climb along the longer side, in the direction it was dragged
          const dir: Quarter = w >= d ? (q.x >= s0.x ? 0 : 180) : q.y >= s0.y ? 90 : 270;
          store.commit((bb) => {
            const n = Object.values(bb.stairs).filter((s) => s.floorId === floorId).length + 1;
            bb.stairs[id] = { id, floorId, name: `Stair ${n}`, x, y, w, d, dir, riser: 0.18, ...STAIR_DEFAULTS, tags: [`f${floorIndex + 1}-s${n}`] };
          });
          store.select({ stairs: [id] });
          store.setTool('select');
        } else {
          const id = uid('rf');
          store.commit((bb) => {
            const n = Object.keys(bb.roofs).length + 1;
            bb.roofs[id] = { id, floorId, name: `Roof ${n}`, type: 'gable', x, y, w, d, dir: w >= d ? 0 : 90, pitch: 35, overhang: 0.4, thickness: 0.2, parapet: 0.5, base: null, hiddenPieces: [], tags: [`roof-${n}`], angle: 0, trim: true };
          });
          store.select({ roofs: [id] });
          store.setTool('select');
        }
      }
    } else if (gesture.kind === 'opening') {
      const w = b.walls[gesture.wallId];
      const s1 = alongWall(gesture.wallId, wp, e.altKey);
      const type = tool as OpeningType;
      const span = Math.abs(s1 - gesture.startS);
      const width = span >= kit.fineGrid ? span : type === 'window' ? kit.window.width : kit.door.width;
      const centre = span >= kit.fineGrid ? (s1 + gesture.startS) / 2 : gesture.startS;
      if (w) {
        let newId = '';
        store.commit((bb) => {
          newId = addOpening(bb, gesture.wallId, type, centre, width, store.doc.kit).id;
        });
        store.select({ openings: [newId] });
      }
    } else if (gesture.kind === 'box') {
      const box = { minX: Math.min(gesture.start.x, wp.x), maxX: Math.max(gesture.start.x, wp.x), minY: Math.min(gesture.start.y, wp.y), maxY: Math.max(gesture.start.y, wp.y) };
      if ((box.maxX - box.minX) * vp.scale > 4 || (box.maxY - box.minY) * vp.scale > 4) {
        const inside = (p: Vec2) => p.x >= box.minX && p.x <= box.maxX && p.y >= box.minY && p.y <= box.maxY;
        const ws = walls.filter((w) => inside(b.corners[w.a]) && inside(b.corners[w.b])).map((w) => w.id);
        const rs = faces
          .filter((f) => f.polygon.every(inside))
          .map((f) => Object.values(b.rooms).find((r) => r.floorId === floorId && r.key === faceKey(f.cornerIds))?.id)
          .filter((x): x is Id => !!x);
        const os = Object.values(b.openings).filter((o) => ws.includes(o.wallId)).map((o) => o.id);
        const ss = stairsHere.filter((s) => stairRect(s).every(inside)).map((s) => s.id);
        const rfs = showRoofs ? roofsHere.filter((r) => inside({ x: r.x, y: r.y }) && inside({ x: r.x + r.w, y: r.y + r.d })).map((r) => r.id) : [];
        const chs = chimneysHere.filter((c) => chimneyRect(c).every(inside)).map((c) => c.id);
        const hs = holesHere.filter((h) => rotRect(h).every(inside)).map((h) => h.id);
        store.select({ ...EMPTY_SEL, walls: ws, rooms: rs, openings: os, stairs: ss, roofs: rfs, chimneys: chs, holes: hs }, gesture.additive);
      }
    } else if (gesture.kind === 'move' || gesture.kind === 'rotate' || gesture.kind === 'resize') {
      store.dragEnd();
    }
    setGesture({ kind: 'none' });
  };

  const onWheel = (e: React.WheelEvent) => {
    const sp = localPoint(e);
    const factor = Math.exp(-e.deltaY * 0.0015);
    const scale = Math.min(400, Math.max(4, vp.scale * factor));
    const k = scale / vp.scale;
    setVp({ scale, ox: sp.x - (sp.x - vp.ox) * k, oy: sp.y - (sp.y - vp.oy) * k });
  };

  // ---------- drawing ----------
  const grid = useMemo(() => {
    const lines: JSX.Element[] = [];
    const tl = { x: -vp.ox / vp.scale, y: vp.oy / vp.scale };
    const br = { x: (size.w - vp.ox) / vp.scale, y: (vp.oy - size.h) / vp.scale };
    const layer = (stepM: number, cls: string, skip?: number) => {
      if (stepM * vp.scale < 6) return;
      const x0 = Math.floor(tl.x / stepM) * stepM;
      for (let x = x0; x <= br.x; x += stepM) {
        if (skip && Math.abs(x / skip - Math.round(x / skip)) < 1e-6) continue;
        const sx = vp.ox + x * vp.scale;
        lines.push(<line key={`${cls}x${x.toFixed(4)}`} className={cls} x1={sx} x2={sx} y1={0} y2={size.h} />);
      }
      const y0 = Math.floor(br.y / stepM) * stepM;
      for (let y = y0; y <= tl.y; y += stepM) {
        if (skip && Math.abs(y / skip - Math.round(y / skip)) < 1e-6) continue;
        const sy = vp.oy - y * vp.scale;
        lines.push(<line key={`${cls}y${y.toFixed(4)}`} className={cls} y1={sy} y2={sy} x1={0} x2={size.w} />);
      }
    };
    layer(kit.fineGrid, 'grid-fine', 1);
    layer(1, 'grid-metre', kit.module);
    layer(kit.module, 'grid-module');
    return lines;
  }, [vp, size, kit.fineGrid, kit.module]);

  const wallFrame = (bb: Building, id: Id) => {
    const w = bb.walls[id];
    const A = toScreen(bb.corners[w.a]);
    const B = toScreen(bb.corners[w.b]);
    const len = Math.hypot(B.x - A.x, B.y - A.y) || 1;
    const ux = (B.x - A.x) / len;
    const uy = (B.y - A.y) / len;
    const t = (w.thickness * vp.scale) / 2;
    return { A, B, ux, uy, nx: -uy * t, ny: ux * t, t, lenPx: len };
  };
  const wallPoly = (bb: Building, id: Id) => {
    const { A, B, ux, uy, nx, ny, t } = wallFrame(bb, id);
    const ex = ux * t;
    const ey = uy * t;
    return [
      [A.x - ex + nx, A.y - ey + ny],
      [B.x + ex + nx, B.y + ey + ny],
      [B.x + ex - nx, B.y + ey - ny],
      [A.x - ex - nx, A.y - ey - ny],
    ]
      .map((p) => p.join(','))
      .join(' ');
  };

  const pts = (poly: Vec2[]) => poly.map((p) => { const s = toScreen(p); return `${s.x},${s.y}`; }).join(' ');
  const sel = {
    walls: new Set(selection.walls),
    rooms: new Set(selection.rooms),
    corners: new Set(selection.corners),
    openings: new Set(selection.openings),
    stairs: new Set(selection.stairs),
    roofs: new Set(selection.roofs),
    chimneys: new Set(selection.chimneys),
    holes: new Set(selection.holes),
  };

  const openingShapes = Object.values(b.openings)
    .filter((o) => b.walls[o.wallId]?.floorId === floorId)
    .map((o) => {
      const { A, ux, uy, nx, ny, t } = wallFrame(b, o.wallId);
      const s0 = (o.offset - o.width / 2) * vp.scale;
      const s1 = (o.offset + o.width / 2) * vp.scale;
      const p0 = { x: A.x + ux * s0, y: A.y + uy * s0 };
      const p1 = { x: A.x + ux * s1, y: A.y + uy * s1 };
      const quad = [
        [p0.x + nx, p0.y + ny],
        [p1.x + nx, p1.y + ny],
        [p1.x - nx, p1.y - ny],
        [p0.x - nx, p0.y - ny],
      ].map((p) => p.join(',')).join(' ');
      const hidden = isHidden(b, o.id);
      const cls = `opening ${o.type} ${sel.openings.has(o.id) ? 'selected' : ''} ${hidden ? 'is-hidden' : ''}`;
      const wPx = o.width * vp.scale;
      return (
        <g key={o.id} className={cls}>
          <polygon className="cut" points={quad} />
          {o.type === 'window' && (
            <>
              <line x1={p0.x} y1={p0.y} x2={p1.x} y2={p1.y} />
              <line x1={p0.x + nx * 0.5} y1={p0.y + ny * 0.5} x2={p1.x + nx * 0.5} y2={p1.y + ny * 0.5} />
              <line x1={p0.x - nx * 0.5} y1={p0.y - ny * 0.5} x2={p1.x - nx * 0.5} y2={p1.y - ny * 0.5} />
            </>
          )}
          {o.type === 'door' && (() => {
            // leaf hinged at p0, swinging to the wall's left side
            const nlen = t || 1;
            const lx = (nx / nlen) * wPx;
            const ly = (ny / nlen) * wPx;
            return (
              <>
                <line className="leaf" x1={p0.x + nx} y1={p0.y + ny} x2={p0.x + nx + lx} y2={p0.y + ny + ly} />
                <path className="swing" d={`M${p0.x + nx + lx} ${p0.y + ny + ly} A ${wPx} ${wPx} 0 0 ${vp.scale > 0 ? 0 : 1} ${p1.x + nx} ${p1.y + ny}`} />
              </>
            );
          })()}
          {o.type === 'arch' && <line className="arch-line" x1={p0.x} y1={p0.y} x2={p1.x} y2={p1.y} />}
          {wPx > 34 && (
            <text className="opening-label" x={(p0.x + p1.x) / 2 + (nx / (t || 1)) * (t + 22)} y={(p0.y + p1.y) / 2 + (ny / (t || 1)) * (t + 22)} textAnchor="middle" dominantBaseline="middle">
              {fmt(o.width)}
            </text>
          )}
        </g>
      );
    });

  const polyPts = (poly: Vec2[]) => poly.map((q) => { const t = toScreen(q); return `${t.x},${t.y}`; }).join(' ');

  const stairShapes = stairsHere.map((s) => {
    const lay = stairLayout(b, s);
    const hidden = isHidden(b, s.id);
    const walk = lay.walk.map(toScreen);
    // walking line ends in an arrow head pointing the way up
    const end = walk[walk.length - 1];
    const prev = walk[walk.length - 2];
    const ang = (Math.atan2(end.y - prev.y, end.x - prev.x) * 180) / Math.PI;
    const start = walk[0];
    const c = toScreen({ x: s.x + s.w / 2, y: s.y + s.d / 2 });
    const top = lay.parts[lay.parts.length - 1];
    return (
      <g key={s.id} className={`stair ${sel.stairs.has(s.id) ? 'selected' : ''} ${hidden ? 'is-hidden' : ''}`}>
        <polygon className="outline" points={polyPts(stairRect(s))} />
        {lay.parts.map((p, i) => (p === top && p.kind === 'step' ? null : <polygon key={i} className={p.kind} points={polyPts(p.poly)} />))}
        {lay.landing && (() => {
          const l = lay.parts.find((p) => p.kind === 'landing')!;
          const lc = toScreen(l.centre);
          return <text className="stair-landing-label" x={lc.x} y={lc.y + 4} textAnchor="middle">landing +{fmt(lay.landing.height)}</text>;
        })()}
        <circle className="walk-start" cx={start.x} cy={start.y} r={3} />
        <polyline className="arrow" points={walk.map((q) => `${q.x},${q.y}`).join(' ')} />
        <path className="arrow-head" d="M0 0 l-9 -5 v10 z" transform={`translate(${end.x} ${end.y}) rotate(${ang})`} />
        <text className="stair-label" x={c.x} y={c.y - 8} textAnchor="middle">UP · {lay.steps} × {fmt(lay.riser)}{lay.flights.length > 1 ? ` · ${lay.flights[0].risers}+${lay.flights[1].risers}` : ''}</text>
      </g>
    );
  });

  const holeShapes = holesHere.map((h) => {
    const r = rotRect(h).map(toScreen);
    const c = toScreen({ x: h.x + h.w / 2, y: h.y + h.d / 2 });
    const st = h.stairId ? b.stairs[h.stairId] : null;
    return (
      <g key={h.id} className={`floor-hole ${sel.holes.has(h.id) ? 'selected' : ''} ${isHidden(b, h.id) ? 'is-hidden' : ''}`}>
        <polygon points={r.map((q) => `${q.x},${q.y}`).join(' ')} />
        <line x1={r[0].x} y1={r[0].y} x2={r[2].x} y2={r[2].y} />
        <line x1={r[1].x} y1={r[1].y} x2={r[3].x} y2={r[3].y} />
        {h.w * vp.scale > 50 && (
          <>
            <text x={c.x} y={c.y - 4} textAnchor="middle">{st ? 'Stair opening · DN' : h.name}</text>
            <text x={c.x} y={c.y + 10} textAnchor="middle" className="dims">{fmt(h.w)} × {fmt(h.d)}{st && !h.auto ? ' · manual' : ''}</text>
          </>
        )}
      </g>
    );
  });

  const resizeKnobs = sizeHandles
    ? sizeHandles.corners.map((c, i) => {
        const q = toScreen(c);
        return <rect key={i} className="size-handle" x={q.x - 5} y={q.y - 5} width={10} height={10} />;
      })
    : null;

  const roofShapes = showRoofs
    ? roofsHere.map((r) => {
        const hidden = isHidden(b, r.id);
        const pieces = roofParts(b, r);
        const outline = roofRect(r, r.overhang).map(toScreen);
        const topY = Math.min(...outline.map((q) => q.y));
        const c = toScreen({ x: r.x + r.w / 2, y: r.y + r.d / 2 });
        return (
          <g key={r.id} className={`roof ${sel.roofs.has(r.id) ? 'selected' : ''} ${hidden ? 'is-hidden' : ''}`}>
            {pieces
              .filter((p) => p.kind !== 'gable')
              .map((p) => {
                const parts = p.parts ?? [p.polygon];
                const d = planOutline(parts).map(([u, v]) => { const s0 = toScreen(u); const s1 = toScreen(v); return `M${s0.x} ${s0.y}L${s1.x} ${s1.y}`; }).join('');
                return (
                  <g key={p.key} className={r.hiddenPieces.includes(p.key) ? 'piece-hidden' : ''}>
                    {parts.map((q, i) => <polygon key={i} className="fill" points={pts(q)} />)}
                    <path className="edge" d={d} />
                  </g>
                );
              })}
            <text className="roof-label" x={c.x} y={topY - 8} textAnchor="middle">
              {r.name} · {r.type} {r.type !== 'flat' ? `${r.pitch}°` : ''}{r.angle ? ` · ${r.angle}°` : ''}
            </text>
          </g>
        );
      })
    : null;

  const chimneyShapes = chimneysHere.map((ch) => {
    const own = ch.floorId === floorId;
    const poly = chimneyRect(ch).map(toScreen);
    const c = toScreen(ch);
    const top = chimneyTop(b, ch);
    return (
      <g key={ch.id} className={`chimney ${own ? '' : 'through'} ${sel.chimneys.has(ch.id) ? 'selected' : ''} ${isHidden(b, ch.id) ? 'is-hidden' : ''}`}>
        <polygon points={poly.map((q) => `${q.x},${q.y}`).join(' ')} />
        <line x1={poly[0].x} y1={poly[0].y} x2={poly[2].x} y2={poly[2].y} />
        <line x1={poly[1].x} y1={poly[1].y} x2={poly[3].x} y2={poly[3].y} />
        {ch.w * vp.scale > 20 && (
          <text className="chimney-label" x={c.x} y={Math.max(...poly.map((q) => q.y)) + 14} textAnchor="middle">
            {ch.name} · top {fmt(top)}
          </text>
        )}
      </g>
    );
  });

  const rotateKnob = rotHandle ? (() => {
    const c = toScreen(rotHandle.centre);
    const k = toScreen(rotHandle.knob);
    return (
      <g className="rotate-handle">
        <line x1={c.x} y1={c.y} x2={k.x} y2={k.y} />
        <circle cx={k.x} cy={k.y} r={7} />
        <text x={k.x + 12} y={k.y - 8}>{fmt0(rotHandle.angle)}°</text>
      </g>
    );
  })() : null;

  const preview = (() => {
    if (!cursor) return null;
    const els: JSX.Element[] = [];
    if (tool === 'door' || tool === 'window' || tool === 'arch') {
      const wid = gesture.kind === 'opening' ? gesture.wallId : wallUnder(cursor);
      if (!wid) return null;
      const w = b.walls[wid];
      const len = wallLength(b, w);
      const s1 = alongWall(wid, cursor, mods.alt);
      const dragging = gesture.kind === 'opening';
      const span = dragging ? Math.abs(s1 - gesture.startS) : 0;
      const width = span >= kit.fineGrid ? span : tool === 'window' ? kit.window.width : kit.door.width;
      const mid = span >= kit.fineGrid && dragging ? (s1 + gesture.startS) / 2 : dragging ? gesture.startS : s1;
      const c0 = Math.max(0, mid - width / 2);
      const c1 = Math.min(len, mid + width / 2);
      const { A, ux, uy, nx, ny } = wallFrame(b, wid);
      const q0 = { x: A.x + ux * c0 * vp.scale, y: A.y + uy * c0 * vp.scale };
      const q1 = { x: A.x + ux * c1 * vp.scale, y: A.y + uy * c1 * vp.scale };
      // nodes along the wall every fine-grid step (drawn when they're far enough apart)
      const gap = kit.fineGrid * vp.scale;
      if (gap >= 5) {
        for (let s = 0; s <= len + 1e-6; s += kit.fineGrid) {
          const major = Math.abs(s / 1 - Math.round(s)) < 1e-6;
          els.push(<circle key={`n${s.toFixed(3)}`} className={`wall-node ${major ? 'major' : ''}`} cx={A.x + ux * s * vp.scale} cy={A.y + uy * s * vp.scale} r={major ? 2.5 : 1.5} />);
        }
      }
      els.push(<polygon key="op" className="preview-opening" points={[[q0.x + nx, q0.y + ny], [q1.x + nx, q1.y + ny], [q1.x - nx, q1.y - ny], [q0.x - nx, q0.y - ny]].map((p) => p.join(',')).join(' ')} />);
      els.push(<text key="opl" className="dim-label live" x={(q0.x + q1.x) / 2} y={(q0.y + q1.y) / 2 - 16} textAnchor="middle">{tool} {fmt(c1 - c0)} · {fmt(c0)} from end</text>);
      return els;
    }
    const p = tool === 'chimney' ? snapFine(cursor) : snapPoint(cursor);
    const s = toScreen(p);
    if (tool === 'chimney' && gesture.kind !== 'rect') {
      const h = (0.75 / 2) * vp.scale;
      els.push(<rect key="pc" className="preview-rect chimney" x={s.x - h} y={s.y - h} width={h * 2} height={h * 2} />);
    }
    els.push(<circle key="snap" className="snap-dot" cx={s.x} cy={s.y} r={4} />);
    if (tool === 'wall' && chainStart) {
      const a = toScreen(chainStart);
      const len = dist(chainStart, p);
      els.push(<line key="pw" className="preview-wall" x1={a.x} y1={a.y} x2={s.x} y2={s.y} strokeWidth={Math.max(2, kit.wallThickness * vp.scale)} />);
      els.push(<text key="pl" className="dim-label live" x={(a.x + s.x) / 2} y={(a.y + s.y) / 2 - 12} textAnchor="middle">{fmt(len)} · {+(len / kit.module).toFixed(3)} mod</text>);
    }
    if (gesture.kind === 'rect') {
      const a = toScreen(gesture.start);
      const w = Math.abs(p.x - gesture.start.x);
      const h = Math.abs(p.y - gesture.start.y);
      els.push(<rect key="pr" className={`preview-rect ${gesture.purpose}`} x={Math.min(a.x, s.x)} y={Math.min(a.y, s.y)} width={Math.abs(s.x - a.x)} height={Math.abs(s.y - a.y)} />);
      els.push(<text key="prl" className="dim-label live" x={(a.x + s.x) / 2} y={Math.min(a.y, s.y) - 10} textAnchor="middle">{gesture.purpose === 'room' ? '' : `${gesture.purpose === 'hole' ? 'opening' : gesture.purpose} `}{fmt(w)} × {fmt(h)}</text>);
    }
    return els;
  })();

  const boxRect = gesture.kind === 'box' && cursor ? (() => {
    const a = toScreen(gesture.start);
    const c = toScreen(cursor);
    return <rect className="box-select" x={Math.min(a.x, c.x)} y={Math.min(a.y, c.y)} width={Math.abs(c.x - a.x)} height={Math.abs(c.y - a.y)} />;
  })() : null;

  // overall dimension chains for this floor (outside faces)
  const overall = fp && walls.length ? (() => {
    const tl = toScreen({ x: fp.minX, y: fp.maxY });
    const br = toScreen({ x: fp.maxX, y: fp.minY });
    const yTop = tl.y - 34;
    const xLeft = tl.x - 34;
    return (
      <g className="overall-dims">
        <line x1={tl.x} x2={br.x} y1={yTop} y2={yTop} />
        <line x1={tl.x} x2={tl.x} y1={yTop - 5} y2={yTop + 5} />
        <line x1={br.x} x2={br.x} y1={yTop - 5} y2={yTop + 5} />
        <text x={(tl.x + br.x) / 2} y={yTop - 6} textAnchor="middle">{fmt(fp.maxX - fp.minX)} overall</text>
        <line y1={tl.y} y2={br.y} x1={xLeft} x2={xLeft} />
        <line y1={tl.y} y2={tl.y} x1={xLeft - 5} x2={xLeft + 5} />
        <line y1={br.y} y2={br.y} x1={xLeft - 5} x2={xLeft + 5} />
        <text x={xLeft - 6} y={(tl.y + br.y) / 2} textAnchor="middle" transform={`rotate(-90 ${xLeft - 6} ${(tl.y + br.y) / 2})`}>{fmt(fp.maxY - fp.minY)} overall</text>
      </g>
    );
  })() : null;

  return (
    <div className="plan-wrap">
      <svg
        ref={svgRef}
        className={`plan tool-${tool}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => setCursor(null)}
        onWheel={onWheel}
        onContextMenu={(e) => {
          e.preventDefault();
          setChainStart(null);
        }}
        onDoubleClick={() => setChainStart(null)}
      >
        <g>{grid}</g>
        <g className="origin">
          <line x1={vp.ox - 10} x2={vp.ox + 10} y1={vp.oy} y2={vp.oy} />
          <line y1={vp.oy - 10} y2={vp.oy + 10} x1={vp.ox} x2={vp.ox} />
        </g>

        {showFloorBelow && floorBelow && (
          <g className="ghost">
            {facesBelow.map((f) => <polygon key={f.cornerIds.join()} points={pts(f.polygon)} />)}
            {wallsOnFloor(b, floorBelow.id).map((w) => <polygon key={w.id} points={wallPoly(b, w.id)} />)}
          </g>
        )}

        {faces.map((f) => {
          const room = Object.values(b.rooms).find((r) => r.floorId === floorId && r.key === faceKey(f.cornerIds));
          return <polygon key={f.cornerIds.join()} className={`room ${room && sel.rooms.has(room.id) ? 'selected' : ''}`} points={pts(f.polygon)} />;
        })}

        {holeShapes}
        {stairShapes}

        {walls.map((w) => (
          <polygon key={w.id} className={`wall ${sel.walls.has(w.id) ? 'selected' : ''} ${w.kind} ${isHidden(b, w.id) ? 'is-hidden' : ''}`} points={wallPoly(b, w.id)} />
        ))}
        {openingShapes}

        {walls.map((w) => {
          const len = wallLength(b, w);
          const { A: sa, B: sb, lenPx } = wallFrame(b, w.id);
          if (lenPx < 36) return null;
          let nx = -(sb.y - sa.y) / lenPx;
          let ny = (sb.x - sa.x) / lenPx;
          const off = (w.thickness * vp.scale) / 2 + 12;
          const mid = toScreen(planCentre);
          const mxs = (sa.x + sb.x) / 2;
          const mys = (sa.y + sb.y) / 2;
          if ((mxs - mid.x) * nx + (mys - mid.y) * ny > 0) {
            nx = -nx;
            ny = -ny;
          }
          let ang = (Math.atan2(sb.y - sa.y, sb.x - sa.x) * 180) / Math.PI;
          if (ang > 90 || ang < -90) ang += 180;
          const mx = mxs - nx * off;
          const my = mys - ny * off;
          const offGrid = Math.abs(len / kit.module - Math.round(len / kit.module)) > 1e-3;
          return (
            <text key={`d${w.id}`} className={`dim-label ${offGrid ? 'off-grid' : ''}`} x={mx} y={my} textAnchor="middle" dominantBaseline="middle" transform={`rotate(${ang} ${mx} ${my})`}>
              {fmt(len)}
            </text>
          );
        })}

        {faces.map((f) => {
          const room = Object.values(b.rooms).find((r) => r.floorId === floorId && r.key === faceKey(f.cornerIds));
          if (!room) return null;
          const inner = roomInterior(b, f);
          const bb = bbox(inner);
          const c = toScreen(centroid(f.polygon));
          if ((bb.maxX - bb.minX) * vp.scale < 50) return null;
          return (
            <g key={`l${room.id}`} className="room-label">
              <text x={c.x} y={c.y - 12} textAnchor="middle" className="room-name">{room.name}</text>
              <text x={c.x} y={c.y + 4} textAnchor="middle" className="room-dims">{fmt(bb.maxX - bb.minX)} × {fmt(bb.maxY - bb.minY)} · {signedArea(inner).toFixed(2)} m²</text>
              {room.tags.length > 0 && <text x={c.x} y={c.y + 19} textAnchor="middle" className="room-tags">{room.tags.join('  ')}</text>}
            </g>
          );
        })}

        {roofShapes}
        {chimneyShapes}
        {rotateKnob}
        {resizeKnobs}
        {overall}

        {centre && (() => {
          const c = toScreen(centre);
          return (
            <g className="centre-marker">
              <circle cx={c.x} cy={c.y} r={9} />
              <line x1={c.x - 16} x2={c.x + 16} y1={c.y} y2={c.y} />
              <line y1={c.y - 16} y2={c.y + 16} x1={c.x} x2={c.x} />
              <text x={c.x + 12} y={c.y + 24}>centre {fmt(centre.x)}, {fmt(centre.y)}</text>
            </g>
          );
        })()}

        {tool === 'select' &&
          Object.values(b.corners)
            .filter((c) => c.floorId === floorId)
            .map((c) => {
              const s = toScreen(c);
              return <circle key={c.id} className={`corner ${sel.corners.has(c.id) ? 'selected' : ''}`} cx={s.x} cy={s.y} r={sel.corners.has(c.id) ? 5 : 3} />;
            })}

        {preview}
        {boxRect}
      </svg>
      <div className="statusbar">
        <span>{cursor ? `x ${fmt(cursor.x)}  y ${fmt(cursor.y)}` : '—'}</span>
        <span>{floor ? `f${floorIndex + 1} @ ${fmt(floor.elevation)}` : ''}</span>
        <span>Snap: {mods.alt ? 'free (Alt)' : tool === 'door' || tool === 'window' || tool === 'arch' ? `wall nodes ${kit.fineGrid} m` : mods.shift ? `fine ${kit.fineGrid} m (Shift)` : `module ${kit.module} m`}</span>
        <span className="hint">{hintFor(tool, !!chainStart)}</span>
        <span>{Math.round(vp.scale)} px/m</span>
      </div>
      {walls.length === 0 && stairsHere.length === 0 && (
        <div className="empty-hint">
          Press <kbd>R</kbd> and drag to draw a room, or <kbd>W</kbd> and click to draw walls.
          <br />
          Walls snap to {kit.module} m modules; hold <kbd>Shift</kbd> for {kit.fineGrid} m, <kbd>Alt</kbd> for free.
        </div>
      )}
    </div>
  );
}

function hintFor(tool: string, chaining: boolean) {
  switch (tool) {
    case 'wall':
      return chaining ? 'Click to place the next corner · Esc, right-click or double-click to stop' : 'Click to start a wall';
    case 'rect':
      return 'Drag to draw a rectangular room';
    case 'door':
    case 'window':
    case 'arch':
      return `Click a wall node for a default ${tool}, or drag from node to node along a wall to set its width`;
    case 'stair':
      return 'Drag the stair area in the direction you climb; pick straight, landing, L or U in the inspector';
    case 'hole':
      return 'Drag to cut an opening in this floor (stair wells, double-height voids, hatches); drag its corner squares to resize';
    case 'chimney':
      return 'Click to drop a 0.75 m chimney (or drag its size); it rises through the roofs and they cut around it';
    case 'roof':
      return 'Drag the roof footprint over the walls (centreline to centreline); edit type and pitch in the inspector';
    default:
      return 'Click to select · Shift adds · drag the round knob on a roof or stair to rotate it (15° steps, Shift 1°) · [ ] rotate · drag to move · drag empty space to box-select · Del deletes · H hides';
  }
}

const fmt0 = (a: number) => (Math.round(a * 10) / 10).toString();
