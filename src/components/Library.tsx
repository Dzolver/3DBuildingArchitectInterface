import { useEffect, useMemo, useState } from 'react';
import { useStore, newDoc } from '../store';
import { deleteBlueprint, listBlueprints, saveBlueprint, type BlueprintRecord } from '../model/library';
import { buildElevation } from '../model/elevation';
import { footprint } from '../model/ops';
import { roofParts } from '../model/solids';
import { migrate } from '../model/migrate';
import { uid } from '../model/geometry';
import type { ProjectDoc } from '../model/types';
import { fmt } from '../format';

/** Small blueprint drawing: plan of every floor (ground strongest) plus roof outlines. */
export function PlanThumb({ doc }: { doc: ProjectDoc }) {
  const b = doc.building;
  const cs = Object.values(b.corners);
  if (!cs.length) return <svg className="thumb" viewBox="0 0 100 70"><text x="50" y="38" textAnchor="middle" className="muted">empty</text></svg>;
  const xs = cs.map((c) => c.x);
  const ys = cs.map((c) => c.y);
  const pad = 1.2;
  const minX = Math.min(...xs) - pad;
  const maxX = Math.max(...xs) + pad;
  const minY = Math.min(...ys) - pad;
  const maxY = Math.max(...ys) + pad;
  const vb = `${minX} ${-maxY} ${maxX - minX} ${maxY - minY}`;
  return (
    <svg className="thumb" viewBox={vb} preserveAspectRatio="xMidYMid meet">
      {b.floors.map((f, i) => (
        <g key={f.id} opacity={i === 0 ? 1 : 0.45}>
          {Object.values(b.walls)
            .filter((w) => w.floorId === f.id)
            .map((w) => (
              <line key={w.id} x1={b.corners[w.a].x} y1={-b.corners[w.a].y} x2={b.corners[w.b].x} y2={-b.corners[w.b].y} stroke="#4da3ff" strokeWidth={w.thickness} strokeLinecap="square" />
            ))}
        </g>
      ))}
      {Object.values(b.roofs).flatMap((r) =>
        roofParts(b, r).filter((p) => p.kind !== 'gable').flatMap((p) => (p.parts ?? [p.polygon]).map((q, i) => (
          <polygon key={r.id + p.key + i} points={q.map((v) => `${v.x},${-v.y}`).join(' ')} fill="none" stroke="#7fe3ff" strokeWidth={0.06} strokeDasharray="0.25 0.18" />
        ))),
      )}
    </svg>
  );
}

export function FrontThumb({ doc }: { doc: ProjectDoc }) {
  const { items, bounds } = useMemo(() => buildElevation(doc.building, 'front'), [doc]);
  if (!bounds) return <svg className="thumb" viewBox="0 0 100 70" />;
  const pad = 0.8;
  const vb = `${bounds.minU - pad} ${-bounds.maxZ - pad} ${bounds.maxU - bounds.minU + 2 * pad} ${bounds.maxZ - bounds.minZ + 2 * pad}`;
  const path = (pts: [number, number][]) => pts.map((p, i) => `${i ? 'L' : 'M'}${p[0]} ${-p[1]}`).join(' ') + 'Z';
  return (
    <svg className="thumb" viewBox={vb} preserveAspectRatio="xMidYMid meet">
      {items.map((d, i) => (
        <path key={i} d={path(d.outline) + d.holes.map((h) => path(h)).join('')} fillRule="evenodd" fill={d.kind === 'opening' ? 'none' : d.kind === 'roof' ? '#1f3558' : '#15233d'} stroke="#4da3ff" strokeWidth={0.05} />
      ))}
    </svg>
  );
}

export function Library() {
  const [records, setRecords] = useState<BlueprintRecord[] | null>(null);
  const [query, setQuery] = useState('');
  const current = useStore((s) => s.doc);
  const refresh = () => listBlueprints().then(setRecords);
  useEffect(() => {
    // make sure the open structure is in the list before showing it
    saveBlueprint(useStore.getState().doc).catch(() => undefined).finally(refresh);
  }, []);

  const open = (r: BlueprintRecord) => {
    useStore.getState().load(r.doc, null);
    useStore.getState().setScreen('editor');
  };
  const create = () => {
    const name = window.prompt('Name for the new blueprint', 'New building');
    if (!name) return;
    const d = newDoc(name);
    useStore.getState().load(d, null);
    saveBlueprint(d).finally(() => useStore.getState().setScreen('editor'));
  };
  const duplicate = async (r: BlueprintRecord) => {
    const copy = structuredClone(r.doc);
    copy.id = uid('doc');
    copy.building.name = `${r.name} copy`;
    await saveBlueprint(copy);
    refresh();
  };
  const rename = async (r: BlueprintRecord) => {
    const name = window.prompt('Rename blueprint', r.name);
    if (!name) return;
    const d = structuredClone(r.doc);
    d.building.name = name;
    await saveBlueprint(d);
    if (current.id === r.id) useStore.getState().commit((bb) => (bb.name = name));
    refresh();
  };
  const remove = async (r: BlueprintRecord) => {
    if (!window.confirm(`Delete "${r.name}" from the library? This can't be undone (export it first to keep a copy).`)) return;
    await deleteBlueprint(r.id);
    refresh();
  };
  const exportFile = (r: BlueprintRecord) => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(r.doc, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${r.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.bpa.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const importFiles = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = '.json,application/json';
    input.onchange = async () => {
      const bad: string[] = [];
      for (const f of Array.from(input.files ?? [])) {
        try {
          await saveBlueprint(migrate(JSON.parse(await f.text())));
        } catch {
          bad.push(f.name);
        }
      }
      if (bad.length) window.alert(`Skipped (not Building Architect projects): ${bad.join(', ')}`);
      refresh();
    };
    input.click();
  };

  const shown = (records ?? []).filter((r) => r.name.toLowerCase().includes(query.toLowerCase()));

  return (
    <div className="library">
      <header className="lib-head">
        <div>
          <h2>Blueprint library</h2>
          <p className="muted">{records ? `${records.length} structure${records.length === 1 ? '' : 's'}` : 'Loading…'} · saved in this browser automatically as you work</p>
        </div>
        <input className="search" placeholder="Search by name" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button onClick={importFiles}>Import files</button>
        <button className="primary" onClick={create}>+ New blueprint</button>
      </header>
      <div className="cards">
        {shown.map((r) => {
          const b = r.doc.building;
          const fp = footprint(b, b.floors[0].id);
          const isCurrent = r.id === current.id;
          return (
            <article key={r.id} className={`card ${isCurrent ? 'current' : ''}`}>
              <button className="thumbs" onClick={() => open(r)} title="Open">
                <PlanThumb doc={r.doc} />
                <FrontThumb doc={r.doc} />
              </button>
              <div className="card-body">
                <h4>{r.name} {isCurrent && <span className="badge">open</span>}</h4>
                <p className="muted">
                  {b.floors.length} floor{b.floors.length === 1 ? '' : 's'} · {Object.keys(b.rooms).length} rooms · {Object.keys(b.openings).length} openings
                  {Object.keys(b.roofs).length ? ` · ${Object.keys(b.roofs).length} roof${Object.keys(b.roofs).length === 1 ? '' : 's'}` : ''}
                </p>
                <p className="muted">{fp ? `${fmt(fp.maxX - fp.minX)} × ${fmt(fp.maxY - fp.minY)} footprint` : 'no walls yet'} · edited {new Date(r.updatedAt).toLocaleString()}</p>
              </div>
              <div className="card-actions">
                <button onClick={() => open(r)}>Open</button>
                <button onClick={() => duplicate(r)}>Duplicate</button>
                <button onClick={() => rename(r)}>Rename</button>
                <button onClick={() => exportFile(r)}>Export</button>
                <button className="danger-text" onClick={() => remove(r)}>Delete</button>
              </div>
            </article>
          );
        })}
        {records && !shown.length && <p className="muted">No blueprints match.</p>}
      </div>
    </div>
  );
}
