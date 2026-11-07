import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store';
import { SIDE_LABEL, buildElevation, project, type Drawable, type ElevationSide, type Pt } from '../model/elevation';
import { buildingCentre } from '../model/ops';
import { fmt } from '../format';

interface Viewport {
  scale: number;
  ox: number;
  oy: number;
}

export function ElevationView({ side }: { side: ElevationSide }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [vp, setVp] = useState<Viewport | null>(null);
  const [pan, setPan] = useState<{ start: { x: number; y: number }; vp: Viewport } | null>(null);
  const doc = useStore((s) => s.doc);
  const selection = useStore((s) => s.selection);
  const activeFloorId = useStore((s) => s.activeFloorId);
  const b = doc.building;
  const { items, bounds } = useMemo(() => buildElevation(b, side), [b, side]);
  const centre = useMemo(() => buildingCentre(b), [b]);

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

  // fit to view whenever the side changes or the size is first known
  const fit = () => {
    if (!bounds) return setVp({ scale: 40, ox: size.w / 2, oy: size.h * 0.75 });
    const w = bounds.maxU - bounds.minU || 1;
    const h = bounds.maxZ - bounds.minZ || 1;
    // leave room for level labels on the left and the height dimension on the right
    const scale = Math.min((size.w - 380) / w, (size.h - 170) / h, 120);
    setVp({ scale, ox: 200 + (size.w - 360) / 2 - ((bounds.minU + bounds.maxU) / 2) * scale, oy: size.h / 2 + 10 + ((bounds.minZ + bounds.maxZ) / 2) * scale });
  };
  useEffect(fit, [side, size.w, size.h]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!vp) return <div className="plan-wrap"><svg ref={svgRef} className="plan" /></div>;

  const S = (p: Pt) => [vp.ox + p[0] * vp.scale, vp.oy - p[1] * vp.scale];
  const path = (pts: Pt[]) => pts.map((p, i) => `${i ? 'L' : 'M'}${S(p).join(' ')}`).join(' ') + ' Z';
  const selected = (d: Drawable) =>
    (d.kind === 'wall' && selection.walls.includes(d.refId)) ||
    (d.kind === 'opening' && selection.openings.includes(d.refId)) ||
    (d.kind === 'roof' && selection.roofs.includes(d.refId)) ||
    (d.kind === 'stair' && selection.stairs.includes(d.refId)) ||
    (d.kind === 'chimney' && selection.chimneys.includes(d.refId));

  const pick = (d: Drawable, e: React.MouseEvent) => {
    const st = useStore.getState();
    const key = d.kind === 'wall' ? 'walls' : d.kind === 'opening' ? 'openings' : d.kind === 'roof' ? 'roofs' : d.kind === 'stair' ? 'stairs' : d.kind === 'chimney' ? 'chimneys' : null;
    if (!key) return;
    st.select({ [key]: [d.refId] }, e.shiftKey);
    if (d.floorId !== st.activeFloorId) useStore.setState({ activeFloorId: d.floorId });
  };

  const levels = b.floors.map((f, i) => ({ f, i, y: vp.oy - f.elevation * vp.scale }));
  const top = bounds ? vp.oy - bounds.maxZ * vp.scale : 0;
  const leftX = bounds ? vp.ox + bounds.minU * vp.scale : 0;
  const rightX = bounds ? vp.ox + bounds.maxU * vp.scale : 0;
  const ground = vp.oy;
  const cu = centre ? vp.ox + project(side, centre).u * vp.scale : null;

  return (
    <div className="plan-wrap">
      <svg
        ref={svgRef}
        className="plan elevation"
        onWheel={(e) => {
          const r = svgRef.current!.getBoundingClientRect();
          const sx = e.clientX - r.left;
          const sy = e.clientY - r.top;
          const scale = Math.min(400, Math.max(4, vp.scale * Math.exp(-e.deltaY * 0.0015)));
          const k = scale / vp.scale;
          setVp({ scale, ox: sx - (sx - vp.ox) * k, oy: sy - (sy - vp.oy) * k });
        }}
        onPointerDown={(e) => {
          if (e.button === 1 || e.button === 2) {
            svgRef.current?.setPointerCapture(e.pointerId);
            setPan({ start: { x: e.clientX, y: e.clientY }, vp });
          } else if (e.target === svgRef.current) useStore.getState().clearSelection();
        }}
        onPointerMove={(e) => pan && setVp({ ...pan.vp, ox: pan.vp.ox + e.clientX - pan.start.x, oy: pan.vp.oy + e.clientY - pan.start.y })}
        onPointerUp={() => setPan(null)}
        onContextMenu={(e) => e.preventDefault()}
      >
        {/* ground and floor levels */}
        <line className="ground" x1={0} x2={size.w} y1={ground} y2={ground} />
        {items.map((d, i) => (
          <path
            key={`${d.kind}${d.refId}${d.pieceKey ?? ''}${i}`}
            className={`el-${d.kind} ${d.openingType ?? ''} ${selected(d) ? 'selected' : ''} ${d.floorId === activeFloorId ? 'active-floor' : ''}`}
            d={path(d.outline) + d.holes.map((h) => ' ' + path(h)).join('')}
            fillRule="evenodd"
            onClick={(e) => pick(d, e)}
          />
        ))}
        {/* opening details */}
        {items.filter((d) => d.kind === 'opening').map((d) => {
          const [x0, y1] = S(d.outline[0]);
          const [x1, y0] = S(d.outline[2]);
          const mx = (x0 + x1) / 2;
          const my = (y0 + y1) / 2;
          return (
            <g key={`od${d.refId}`} className="el-opening-detail">
              {d.openingType === 'window' && (
                <>
                  <line x1={mx} x2={mx} y1={y0} y2={y1} />
                  <line x1={x0} x2={x1} y1={my} y2={my} />
                </>
              )}
              {d.openingType === 'door' && <circle cx={x1 - (x1 - x0) * 0.15} cy={my + (y1 - y0) * 0.05} r={2} />}
            </g>
          );
        })}
        {bounds && (
          <g className="overall-dims">
            {levels.map(({ f, i, y }) => (
              <g key={f.id}>
                <line className="level" x1={leftX - 60} x2={rightX + 20} y1={y} y2={y} />
                <text x={leftX - 64} y={y - 4} textAnchor="end">f{i + 1} {f.name}</text>
                <text x={leftX - 64} y={y + 12} textAnchor="end" className="muted">+{fmt(f.elevation)}</text>
              </g>
            ))}
            {/* overall width */}
            <line x1={leftX} x2={rightX} y1={ground + 34} y2={ground + 34} />
            <line x1={leftX} x2={leftX} y1={ground + 28} y2={ground + 40} />
            <line x1={rightX} x2={rightX} y1={ground + 28} y2={ground + 40} />
            <text x={(leftX + rightX) / 2} y={ground + 50} textAnchor="middle">{fmt(bounds.maxU - bounds.minU)} overall (incl. overhangs)</text>
            {/* total height */}
            <line x1={rightX + 34} x2={rightX + 34} y1={ground} y2={top} />
            <line x1={rightX + 28} x2={rightX + 40} y1={top} y2={top} />
            <line x1={rightX + 28} x2={rightX + 40} y1={ground} y2={ground} />
            <text x={rightX + 44} y={(ground + top) / 2} textAnchor="start">{fmt(bounds.maxZ)} to top</text>
          </g>
        )}
        {cu !== null && (
          <g className="centre-axis">
            <line x1={cu} x2={cu} y1={top - 30} y2={ground + 20} />
            <text x={cu + 6} y={top - 34}>centre</text>
          </g>
        )}
        {!items.length && (
          <text x={size.w / 2} y={size.h / 2} textAnchor="middle" className="muted">Nothing to show yet — draw walls in the plan view.</text>
        )}
      </svg>
      <div className="statusbar">
        <span className="hint">{SIDE_LABEL[side]} · click a wall, opening, stair, roof piece or chimney to select it · wheel zooms · right-drag pans</span>
        <button className="link" onClick={fit}>Fit</button>
        <span>{Math.round(vp.scale)} px/m</span>
      </div>
    </div>
  );
}
