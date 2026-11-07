import { bbox, findFaces, roomInterior, rotRect, signedArea, wallLength } from './geometry';
import type { ProjectDoc, Vec2, Vec3 } from './types';
import { buildingCentre, footprint, isHidden } from './ops';
import { roofRidgeZ } from './roof';
import { chimneyPieces, chimneyRect, chimneyTop, resolvedRoofs } from './solids';
import { stairLayout, stairRect } from './stairs';

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const pt = (p: Vec2) => [r3(p.x), r3(p.y)];
/** Plan (x right, y up, metres) -> Unreal (X, Y, left-handed, Z up, centimetres). */
const ue = (p: Vec2) => [r3(p.x * 100), r3(-p.y * 100)];
const pt3 = (p: Vec3) => [r3(p.x), r3(p.y), r3(p.z)];
const ue3 = (p: Vec3) => [r3(p.x * 100), r3(-p.y * 100), r3(p.z * 100)];

/**
 * Build the handoff file for the UE / Blender side. Metres are the primary values
 * (1 Blender unit = 1 m); each geometry block also carries an `uu` copy in Unreal units.
 */
export function buildExport(doc: ProjectDoc) {
  const b = doc.building;
  const floors = b.floors.map((f, i) => {
    const walls = Object.values(b.walls)
      .filter((w) => w.floorId === f.id)
      .map((w) => {
        const A = b.corners[w.a];
        const B = b.corners[w.b];
        const height = w.height ?? f.height;
        const length = wallLength(b, w);
        const ux = length ? (B.x - A.x) / length : 0;
        const uy = length ? (B.y - A.y) / length : 0;
        const openings = Object.values(b.openings)
          .filter((o) => o.wallId === w.id)
          .sort((p, q) => p.offset - q.offset)
          .map((o) => {
            const s0 = o.offset - o.width / 2;
            const s1 = o.offset + o.width / 2;
            const p0 = { x: A.x + ux * s0, y: A.y + uy * s0 };
            const p1 = { x: A.x + ux * s1, y: A.y + uy * s1 };
            return {
              id: o.id,
              type: o.type,
              tags: o.tags,
              hidden: isHidden(b, o.id),
              fromStart: r3(s0),
              fromEnd: r3(length - s1),
              centre: r3(o.offset),
              width: o.width,
              height: o.height,
              sill: o.sill,
              head: r3(o.sill + o.height),
              start: pt(p0),
              end: pt(p1),
              uu: { start: ue(p0), end: ue(p1), width: r3(o.width * 100), height: r3(o.height * 100), sill: r3(o.sill * 100), fromStart: r3(s0 * 100) },
            };
          });
        return {
          id: w.id,
          tags: w.tags,
          kind: w.kind,
          hidden: isHidden(b, w.id),
          openings,
          start: pt(A),
          end: pt(B),
          length: r3(length),
          thickness: w.thickness,
          height,
          modules: r3(length / doc.kit.module),
          onModuleGrid: Math.abs(length / doc.kit.module - Math.round(length / doc.kit.module)) < 1e-3,
          uu: { start: ue(A), end: ue(B), length: r3(length * 100), thickness: r3(w.thickness * 100), height: r3(height * 100) },
        };
      });
    const faces = findFaces(b, f.id);
    const rooms = Object.values(b.rooms)
      .filter((r) => r.floorId === f.id)
      .map((r) => {
        const face = faces.find((fc) => [...fc.cornerIds].sort().join('|') === r.key);
        if (!face) return null;
        const inner = roomInterior(b, face);
        const bb = bbox(inner);
        return {
          id: r.id,
          name: r.name,
          tags: r.tags,
          wallIds: face.wallIds,
          centreline: face.polygon.map(pt),
          interior: inner.map(pt),
          clear: [r3(bb.maxX - bb.minX), r3(bb.maxY - bb.minY)],
          area_m2: r3(signedArea(inner)),
          ceiling: r3(f.height - f.slab),
          uu: { interior: inner.map(ue), clear: [r3((bb.maxX - bb.minX) * 100), r3((bb.maxY - bb.minY) * 100)] },
        };
      })
      .filter(Boolean);
    return {
      id: f.id,
      name: f.name,
      level: i + 1,
      tags: [`f${i + 1}`],
      elevation: f.elevation,
      height: f.height,
      slab: f.slab,
      uu: { elevation: r3(f.elevation * 100), height: r3(f.height * 100), slab: r3(f.slab * 100) },
      walls,
      rooms,
      stairs: Object.values(b.stairs)
        .filter((st) => st.floorId === f.id)
        .map((st) => {
          const info = stairLayout(b, st);
          return {
            id: st.id,
            name: st.name,
            tags: st.tags,
            hidden: isHidden(b, st.id),
            rect: { x: st.x, y: st.y, w: st.w, d: st.d },
            rotation: r3(st.angle ?? 0),
            corners: stairRect(st).map(pt),
            shape: st.shape,
            turn: st.shape === 'l' || st.shape === 'u' ? st.turn : null,
            climbs: { 0: '+x', 90: '+y', 180: '-x', 270: '-y' }[st.dir],
            toFloor: info.toFloor?.id ?? null,
            rise: r3(info.rise),
            steps: info.steps,
            riser: r3(info.riser),
            tread: r3(info.tread),
            run: r3(info.run),
            width: r3(info.width),
            flights: info.flights.map((fl) => ({ risers: fl.risers, treads: fl.treads, tread: r3(fl.tread), width: r3(fl.width), run: r3(fl.run) })),
            landing: info.landing ? { w: r3(info.landing.w), d: r3(info.landing.d), height: r3(info.landing.height) } : null,
            walkLine: info.walk.map(pt),
            /** Each tread block and landing: plan outline, top above the floor (blocks are solid from the floor up). */
            parts: info.parts.map((p) => ({ kind: p.kind, flight: p.flight, top: r3(p.top), outline: p.poly.map(pt), uu: { outline: p.poly.map(ue), top: r3(p.top * 100) } })),
            uu: { x: r3(st.x * 100), y: r3(-(st.y + st.d) * 100), w: r3(st.w * 100), d: r3(st.d * 100), riser: r3(info.riser * 100), tread: r3(info.tread * 100) },
          };
        }),
      roofs: Object.values(b.roofs)
        .filter((r) => r.floorId === f.id)
        .map((r) => ({
          id: r.id,
          name: r.name,
          tags: r.tags,
          type: r.type,
          hidden: isHidden(b, r.id),
          footprint: { x: r.x, y: r.y, w: r.w, d: r.d },
          direction: r.dir,
          rotation: r3(r.angle ?? 0),
          trim: r.trim !== false,
          trimmedBy: resolvedRoofs(b).get(r.id)?.trimmedBy ?? [],
          pitch: r.pitch,
          overhang: r.overhang,
          thickness: r.thickness,
          ridgeHeight: r3(roofRidgeZ(b, r)),
          pieces: (resolvedRoofs(b).get(r.id)?.pieces ?? []).map((p) => ({
            key: p.key,
            label: p.label,
            kind: p.kind,
            hidden: r.hiddenPieces.includes(p.key) || isHidden(b, r.id),
            /** Full untrimmed piece. */
            vertices: p.polygon.map(pt3),
            uu: p.polygon.map(ue3),
            /** What is left after cutting where other roofs and chimneys run through it (convex polygons). */
            trimmed: (p.parts ?? [p.polygon]).map((q) => ({ vertices: q.map(pt3), uu: q.map(ue3) })),
          })),
        })),
      floorOpenings: Object.values(b.holes)
        .filter((h) => h.floorId === f.id)
        .map((h) => ({
          id: h.id,
          name: h.name,
          tags: h.tags,
          hidden: isHidden(b, h.id),
          stair: h.stairId,
          sizedTo: h.stairId && h.auto ? 'stair' : 'manual',
          rect: { x: h.x, y: h.y, w: h.w, d: h.d },
          rotation: r3(h.angle),
          corners: rotRect(h).map(pt),
          area: r3(h.w * h.d),
          uu: { corners: rotRect(h).map(ue), w: r3(h.w * 100), d: r3(h.d * 100) },
        })),
      chimneys: Object.values(b.chimneys)
        .filter((c) => c.floorId === f.id)
        .map((c) => {
          const top = chimneyTop(b, c);
          return {
            id: c.id,
            name: c.name,
            tags: c.tags,
            hidden: isHidden(b, c.id),
            centre: pt(c), uuCentre: ue(c),
            size: [r3(c.w), r3(c.d)],
            rotation: r3(c.angle),
            base: r3(f.elevation),
            top: r3(top),
            topMode: c.top === null ? 'auto' : 'manual',
            corners: chimneyRect(c).map(pt),
            pieces: chimneyPieces(b, c).map((p) => ({ key: p.key, z0: r3(p.z0), z1: r3(p.z1), outline: p.outline.map(pt), uu: { outline: p.outline.map(ue), z0: r3(p.z0 * 100), z1: r3(p.z1 * 100) } })),
            uu: { w: r3(c.w * 100), d: r3(c.d * 100), base: r3(f.elevation * 100), top: r3(top * 100) },
          };
        }),
    };
  });
  const centre = buildingCentre(b);
  const fp0 = b.floors[0] ? footprint(b, b.floors[0].id) : null;
  return {
    schema: doc.schema,
    exportedAt: new Date().toISOString(),
    units: 'm',
    conventions: {
      plan: 'x right, y up, metres; 1 Blender unit = 1 m',
      unreal: 'uu blocks are centimetres in Unreal axes: X = plan x, Y = -plan y, Z up',
      walls: 'start/end are wall centrelines',
      rooms: 'interior and clear are measured to the inside faces of the walls',
      openings: 'fromStart/fromEnd are measured along the wall centreline from its start/end corner to the opening edge',
      hidden: 'hidden items are kept in the file but flagged so the modelling side can skip them',
      roofs: 'rotation is degrees counter-clockwise in plan around the footprint centre; pieces[].trimmed holds the parts left after valleys/chimney cuts',
      stairs: 'rect is before rotation; rotation is degrees counter-clockwise around its centre; corners/parts are already rotated',
      floorOpenings: 'holes through this floor slab (stair wells and other voids); corners are already rotated',
      chimneys: 'centre is in plan; base is the floor the stack starts on; top is the height above ground',
    },
    kit: doc.kit,
    building: {
      name: b.name,
      origin: [0, 0, 0],
      centre: centre ? { plan: pt(centre), uu: ue(centre), note: 'middle of the ground-floor footprint; use as the actor pivot' } : null,
      groundFootprint: fp0 ? { min: pt({ x: fp0.minX, y: fp0.minY }), max: pt({ x: fp0.maxX, y: fp0.maxY }), size: [r3(fp0.maxX - fp0.minX), r3(fp0.maxY - fp0.minY)] } : null,
      floors,
      groups: Object.values(b.groups).map((g) => ({ id: g.id, name: g.name, tags: g.tags, hidden: !!g.hidden, members: g.members })),
    },
  };
}
