import { Canvas } from '@react-three/fiber';
import { Edges, Grid, OrbitControls } from '@react-three/drei';
import { useMemo } from 'react';
import * as THREE from 'three';
import { useStore } from '../store';
import { clipToConvex, findFaces, isConvex, pointInPolygon, rotRect, signedArea, wallLength } from '../model/geometry';
import { buildingCentre, isHidden } from '../model/ops';
import { chimneyPieces, planOutline, roofParts } from '../model/solids';
import { stairParts } from '../model/stairs';
import type { Building, Floor, Wall } from '../model/types';

const BLUE = '#4da3ff';
const CYAN = '#7fe3ff';

// Plan (x, y) with z up  ->  three.js (x, z, -y) with y up.

/** Solid pieces of a wall after cutting its openings: [start, end, bottom, top] along the wall. */
function wallSegments(b: Building, w: Wall, height: number) {
  const len = wallLength(b, w);
  const ops = Object.values(b.openings)
    .filter((o) => o.wallId === w.id && !isHidden(b, o.id))
    .sort((p, q) => p.offset - q.offset);
  const segs: [number, number, number, number][] = [];
  let cur = -w.thickness / 2; // extend into the corner like the plan view
  for (const o of ops) {
    const s0 = Math.max(cur, o.offset - o.width / 2);
    const s1 = o.offset + o.width / 2;
    if (s0 > cur + 1e-6) segs.push([cur, s0, 0, height]);
    if (o.sill > 0) segs.push([s0, s1, 0, Math.min(o.sill, height)]);
    if (o.sill + o.height < height) segs.push([s0, s1, o.sill + o.height, height]);
    cur = Math.max(cur, s1);
  }
  if (cur < len + w.thickness / 2) segs.push([cur, len + w.thickness / 2, 0, height]);
  return segs;
}

function FloorMeshes({ b, floor, active, selected }: { b: Building; floor: Floor; active: boolean; selected: Set<string> }) {
  const faces = useMemo(() => findFaces(b, floor.id), [b, floor.id]);
  const opacity = active ? 0.92 : 0.4;
  return (
    <group position={[0, floor.elevation, 0]}>
      {faces.map((f) => {
        const shape = new THREE.Shape(f.polygon.map((p) => new THREE.Vector2(p.x, p.y)));
        // floor openings punch through the slab
        const rings = [f.polygon];
        for (const h of Object.values(b.holes)) {
          if (h.floorId !== floor.id || isHidden(b, h.id)) continue;
          let poly = rotRect(h);
          if (isConvex(f.polygon)) poly = clipToConvex(poly, f.polygon);
          else if (!pointInPolygon({ x: h.x + h.w / 2, y: h.y + h.d / 2 }, f.polygon)) continue;
          if (poly.length < 3 || Math.abs(signedArea(poly)) < 1e-4) continue;
          shape.holes.push(new THREE.Path(poly.map((p) => new THREE.Vector2(p.x, p.y))));
          rings.push(poly);
        }
        // Outline the slab from its own rings (top, bottom, uprights) rather than from the
        // triangulation, whose bridge triangles to the holes would otherwise show as stray lines.
        const pos: number[] = [];
        for (const ring of rings) {
          ring.forEach((p, i) => {
            const q = ring[(i + 1) % ring.length];
            for (const z of [0, floor.slab]) pos.push(p.x, p.y, z, q.x, q.y, z);
            pos.push(p.x, p.y, 0, p.x, p.y, floor.slab);
          });
        }
        const edges = new THREE.BufferGeometry();
        edges.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        return (
          <mesh key={f.cornerIds.join()} rotation={[-Math.PI / 2, 0, 0]} position={[0, -floor.slab, 0]}>
            <extrudeGeometry args={[shape, { depth: floor.slab, bevelEnabled: false }]} />
            <meshStandardMaterial color="#1b2d4d" transparent opacity={opacity} />
            <lineSegments geometry={edges}>
              <lineBasicMaterial color={BLUE} />
            </lineSegments>
          </mesh>
        );
      })}
      {Object.values(b.walls)
        .filter((w) => w.floorId === floor.id && !isHidden(b, w.id))
        .map((w) => {
          const A = b.corners[w.a];
          const B = b.corners[w.b];
          const h = w.height ?? floor.height;
          const ang = Math.atan2(B.y - A.y, B.x - A.x);
          const sel = selected.has(w.id);
          return (
            <group key={w.id} position={[A.x, 0, -A.y]} rotation={[0, ang, 0]}>
              {wallSegments(b, w, h).map(([s0, s1, z0, z1], i) => (
                <mesh key={i} position={[(s0 + s1) / 2, (z0 + z1) / 2, 0]}>
                  <boxGeometry args={[s1 - s0, z1 - z0, w.thickness]} />
                  <meshStandardMaterial color={sel ? '#1d4a7a' : '#18294a'} transparent opacity={opacity} />
                  <Edges color={sel ? CYAN : BLUE} />
                </mesh>
              ))}
            </group>
          );
        })}
      {Object.values(b.stairs)
        .filter((s) => s.floorId === floor.id && !isHidden(b, s.id))
        .flatMap((s) =>
          stairParts(b, s).map((st, i) => (
            <mesh key={`${s.id}-${i}`} position={[st.centre.x, st.top / 2, -st.centre.y]} rotation={[0, st.rot, 0]}>
              <boxGeometry args={[st.size[0], st.top, st.size[1]]} />
              <meshStandardMaterial color={selected.has(s.id) ? '#1d4a7a' : st.kind === 'landing' ? '#1a2c4b' : '#16243f'} transparent opacity={opacity} />
              <Edges color={selected.has(s.id) ? CYAN : BLUE} />
            </mesh>
          )),
        )}
    </group>
  );
}

function RoofMeshes({ b, floor, selected, opacity }: { b: Building; floor: Floor; selected: Set<string>; opacity: number }) {
  return (
    <>
      {Object.values(b.roofs)
        .filter((r) => r.floorId === floor.id && !isHidden(b, r.id))
        .flatMap((r) =>
          roofParts(b, r)
            .filter((p) => !r.hiddenPieces.includes(p.key) && p.parts?.length !== 0)
            .map((p) => {
              const geo = new THREE.BufferGeometry();
              const pos: number[] = [];
              for (const part of p.parts ?? [p.polygon]) {
                const v = part.map((q) => new THREE.Vector3(q.x, q.z, -q.y));
                for (let i = 1; i < v.length - 1; i++) pos.push(...v[0].toArray(), ...v[i].toArray(), ...v[i + 1].toArray());
              }
              geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
              geo.computeVertexNormals();
              // outline without the seams between trimmed parts
              const edges = new THREE.BufferGeometry();
              edges.setAttribute('position', new THREE.Float32BufferAttribute(planOutline(p.parts ?? [p.polygon]).flatMap(([a, c]) => [a.x, a.z, -a.y, c.x, c.z, -c.y]), 3));
              const sel = selected.has(r.id);
              return (
                <group key={`${r.id}-${p.key}`}>
                  <mesh geometry={geo}>
                    <meshStandardMaterial color={sel ? '#1d4a7a' : p.kind === 'gable' ? '#18294a' : '#1f3558'} side={THREE.DoubleSide} transparent opacity={opacity} />
                  </mesh>
                  <lineSegments geometry={edges}>
                    <lineBasicMaterial color={sel ? CYAN : BLUE} />
                  </lineSegments>
                </group>
              );
            }),
        )}
    </>
  );
}

function ChimneyMeshes({ b, floor, selected }: { b: Building; floor: Floor; selected: Set<string> }) {
  return (
    <>
      {Object.values(b.chimneys)
        .filter((c) => c.floorId === floor.id && !isHidden(b, c.id))
        .flatMap((c) =>
          chimneyPieces(b, c).map((p) => {
            const grow = p.key === 'crown' ? 0.12 : 0;
            const h = Math.max(0.01, p.z1 - p.z0);
            const sel = selected.has(c.id);
            return (
              <mesh key={`${c.id}-${p.key}`} position={[c.x, (p.z0 + p.z1) / 2, -c.y]} rotation={[0, (c.angle * Math.PI) / 180, 0]}>
                <boxGeometry args={[c.w + grow, h, c.d + grow]} />
                <meshStandardMaterial color={sel ? '#5a3a1d' : '#3a2a20'} />
                <Edges color={sel ? CYAN : '#ffb547'} />
              </mesh>
            );
          }),
        )}
    </>
  );
}

export function View3D() {
  const doc = useStore((s) => s.doc);
  const activeFloorId = useStore((s) => s.activeFloorId);
  const selection = useStore((s) => s.selection);
  const showRoofs = useStore((s) => s.showRoofs);
  const b = doc.building;
  const selected = new Set([...selection.walls, ...selection.stairs, ...selection.roofs, ...selection.chimneys]);
  const c = useMemo(() => buildingCentre(b) ?? { x: 0, y: 0 }, [b]);
  const center = new THREE.Vector3(c.x, 1.5, -c.y);
  const activeIdx = b.floors.findIndex((f) => f.id === activeFloorId);
  const isTop = activeIdx === b.floors.length - 1;
  return (
    <div className="view3d">
      <Canvas camera={{ position: [center.x + 16, 16, center.z + 20], fov: 40 }}>
        <color attach="background" args={['#0b1220']} />
        <ambientLight intensity={0.8} />
        <directionalLight position={[10, 20, 10]} intensity={1.2} />
        <Grid args={[200, 200]} cellSize={doc.kit.module / 2} sectionSize={doc.kit.module} cellColor="#1e2a3e" sectionColor="#2a3a55" infiniteGrid fadeDistance={120} position={[0, -0.001, 0]} />
        {/* building centre axis */}
        <mesh position={[c.x, 6, -c.y]}>
          <cylinderGeometry args={[0.02, 0.02, 12, 6]} />
          <meshBasicMaterial color="#ffb547" transparent opacity={0.6} />
        </mesh>
        {b.floors.map((f, i) =>
          i <= activeIdx ? (
            <group key={f.id}>
              <FloorMeshes b={b} floor={f} active={f.id === activeFloorId} selected={selected} />
              {/* roofs show on lower floors always; on the active floor when the roof layer is on */}
              <ChimneyMeshes b={b} floor={f} selected={selected} />
              {(i < activeIdx || showRoofs) && <RoofMeshes b={b} floor={f} selected={selected} opacity={i === activeIdx || isTop ? 0.92 : 0.4} />}
            </group>
          ) : null,
        )}
        <OrbitControls target={center} makeDefault />
      </Canvas>
      <div className="statusbar"><span>Drag to orbit · right-drag to pan · wheel to zoom · floors above the active one are hidden · orange line = building centre</span></div>
    </div>
  );
}
