import { useStore, type Tool } from '../store';
import { uid } from '../model/geometry';
import type { Id } from '../model/types';
import { recentre } from '../model/ops';
import { groupSelection } from './Inspector';

const TOOLS: { id: Tool; label: string; key: string }[] = [
  { id: 'select', label: 'Select', key: 'V' },
  { id: 'wall', label: 'Wall', key: 'W' },
  { id: 'rect', label: 'Room', key: 'R' },
  { id: 'door', label: 'Door', key: 'D' },
  { id: 'window', label: 'Window', key: 'N' },
  { id: 'arch', label: 'Arch / opening', key: 'A' },
  { id: 'stair', label: 'Stair area', key: 'S' },
  { id: 'roof', label: 'Roof', key: 'F' },
  { id: 'chimney', label: 'Chimney', key: 'C' },
  { id: 'hole', label: 'Floor opening', key: 'O' },
];

export function Sidebar() {
  const tool = useStore((s) => s.tool);
  const setTool = useStore((s) => s.setTool);
  const doc = useStore((s) => s.doc);
  const activeFloorId = useStore((s) => s.activeFloorId);
  const setActiveFloor = useStore((s) => s.setActiveFloor);
  const commit = useStore((s) => s.commit);
  const showFloorBelow = useStore((s) => s.showFloorBelow);
  const toggleFloorBelow = useStore((s) => s.toggleFloorBelow);
  const showRoofs = useStore((s) => s.showRoofs);
  const toggleRoofs = useStore((s) => s.toggleRoofs);
  const b = doc.building;

  const addFloorAbove = (copy: boolean) => {
    const id = uid('f');
    const src = b.floors.find((f) => f.id === activeFloorId)!;
    commit((bb) => {
      const idx = bb.floors.findIndex((f) => f.id === activeFloorId);
      bb.floors.splice(idx + 1, 0, { id, name: `Floor ${bb.floors.length + 1}`, elevation: 0, height: src.height, slab: src.slab });
      if (copy) {
        const map = new Map<Id, Id>();
        for (const c of Object.values(bb.corners).filter((c) => c.floorId === src.id)) {
          const nc = { ...c, id: uid('c'), floorId: id };
          map.set(c.id, nc.id);
          bb.corners[nc.id] = nc;
        }
        const n = idx + 2;
        for (const w of Object.values(bb.walls).filter((w) => w.floorId === src.id)) {
          const nw = { ...w, id: uid('w'), floorId: id, a: map.get(w.a)!, b: map.get(w.b)!, tags: w.tags.map((t) => t.replace(/^f\d+-/, `f${n}-`)) };
          bb.walls[nw.id] = nw;
        }
        const wallMap = new Map<Id, Id>();
        for (const w of Object.values(bb.walls)) if (w.floorId === id) {
          const src0 = Object.values(bb.walls).find((x) => x.floorId === src.id && map.get(x.a) === w.a && map.get(x.b) === w.b);
          if (src0) wallMap.set(src0.id, w.id);
        }
        for (const o of Object.values(bb.openings)) {
          const nw = wallMap.get(o.wallId);
          if (nw) {
            const no = { ...o, id: uid('o'), wallId: nw, tags: o.tags.map((t) => t.replace(/^f\d+-/, `f${n}-`)) };
            bb.openings[no.id] = no;
          }
        }
        // keep room names; tags move to the new floor number (f1-r2 -> f2-r2)
        for (const r of Object.values(bb.rooms).filter((r) => r.floorId === src.id)) {
          const nr = { ...r, id: uid('r'), floorId: id, key: r.key.split('|').map((c) => map.get(c)!).sort().join('|'), tags: r.tags.map((t) => t.replace(/^f\d+-/, `f${n}-`)) };
          bb.rooms[nr.id] = nr;
        }
      }
    });
    setActiveFloor(id);
  };

  const removeFloor = (id: Id) => {
    if (b.floors.length <= 1) return;
    const f = b.floors.find((x) => x.id === id)!;
    const count = Object.values(b.walls).filter((w) => w.floorId === id).length;
    if (count && !window.confirm(`Delete ${f.name} and its ${count} walls?`)) return;
    const idx = b.floors.indexOf(f);
    commit((bb) => {
      bb.floors = bb.floors.filter((x) => x.id !== id);
      for (const w of Object.values(bb.walls)) if (w.floorId === id) delete bb.walls[w.id];
      for (const c of Object.values(bb.corners)) if (c.floorId === id) delete bb.corners[c.id];
      for (const r of Object.values(bb.rooms)) if (r.floorId === id) delete bb.rooms[r.id];
      for (const o of Object.values(bb.openings)) if (!bb.walls[o.wallId]) delete bb.openings[o.id];
      for (const s of Object.values(bb.stairs)) if (s.floorId === id) delete bb.stairs[s.id];
      for (const r of Object.values(bb.roofs)) if (r.floorId === id) delete bb.roofs[r.id];
      for (const c of Object.values(bb.chimneys)) if (c.floorId === id) delete bb.chimneys[c.id];
    });
    const remaining = b.floors.filter((x) => x.id !== id);
    setActiveFloor(remaining[Math.max(0, idx - 1)].id);
  };

  return (
    <nav className="sidebar">
      <section>
        <h3>Tools</h3>
        <div className="tools">
          {TOOLS.map((t) => (
            <button key={t.id} className={tool === t.id ? 'on' : ''} onClick={() => setTool(t.id)} title={`${t.label} (${t.key})`}>
              {t.label} <kbd>{t.key}</kbd>
            </button>
          ))}
        </div>
      </section>
      <section>
        <h3>Floors</h3>
        <ol className="floors">
          {[...b.floors].reverse().map((f) => {
            const i = b.floors.indexOf(f);
            const rooms = Object.values(b.rooms).filter((r) => r.floorId === f.id).length;
            return (
              <li key={f.id} className={f.id === activeFloorId ? 'on' : ''} onClick={() => setActiveFloor(f.id)}>
                <span className="lvl">f{i + 1}</span>
                <span className="fname">{f.name}</span>
                <span className="meta">{f.height} m · {rooms} room{rooms === 1 ? '' : 's'}</span>
                {b.floors.length > 1 && (
                  <button className="x" title="Delete floor" onClick={(e) => { e.stopPropagation(); removeFloor(f.id); }}>×</button>
                )}
              </li>
            );
          })}
        </ol>
        <div className="presets">
          <button onClick={() => addFloorAbove(false)}>+ Empty floor above</button>
          <button onClick={() => addFloorAbove(true)}>+ Copy floor up</button>
        </div>
        <label className="check">
          <input type="checkbox" checked={showFloorBelow} onChange={toggleFloorBelow} /> Show floor below
        </label>
        <label className="check">
          <input type="checkbox" checked={showRoofs} onChange={toggleRoofs} /> Show roofs
        </label>
      </section>
      <section>
        <h3>Centre</h3>
        <p className="note">The orange crosshair marks the middle of the ground floor on every floor and view.</p>
        <button onClick={() => commit((bb) => recentre(bb, doc.kit.module))} title="Moves everything so the ground-floor centre sits on the world origin">Centre building on origin</button>
      </section>
      <GroupsPanel />
    </nav>
  );
}

function GroupsPanel() {
  const doc = useStore((s) => s.doc);
  const commit = useStore((s) => s.commit);
  const select = useStore((s) => s.select);
  const selection = useStore((s) => s.selection);
  const groups = Object.values(doc.building.groups);
  const b = doc.building;
  const hasSel = Object.values(selection).some((l) => l.length);
  const selectGroup = (members: Id[]) =>
    select({
      walls: members.filter((m) => b.walls[m]),
      rooms: members.filter((m) => b.rooms[m]),
      openings: members.filter((m) => b.openings[m]),
      stairs: members.filter((m) => b.stairs[m]),
      roofs: members.filter((m) => b.roofs[m]),
      chimneys: members.filter((m) => b.chimneys[m]),
      holes: members.filter((m) => b.holes[m]),
    });
  return (
    <section>
      <h3>Groups</h3>
      {!groups.length && <p className="note">Select walls, rooms, stairs or roofs (any floor) and press Ctrl+G to group them.</p>}
      <ul className="groups">
        {groups.map((g) => (
          <li key={g.id} className={g.hidden ? 'off' : ''}>
            <button className="eye" title={g.hidden ? 'Show group' : 'Hide group'} onClick={() => commit((bb) => (bb.groups[g.id].hidden = !g.hidden))}>{g.hidden ? '◌' : '●'}</button>
            <span className="gname" onClick={() => selectGroup(g.members)} onDoubleClick={() => {
              const name = window.prompt('Rename group', g.name);
              if (name) commit((bb) => (bb.groups[g.id].name = name));
            }} title="Click to select, double-click to rename">{g.name}</span>
            <em>{g.members.length}</em>
            <button className="x" title="Add selection to group" disabled={!hasSel} onClick={() => commit((bb) => {
              const add = [...selection.walls, ...selection.rooms, ...selection.openings, ...selection.stairs, ...selection.roofs, ...selection.chimneys, ...selection.holes];
              bb.groups[g.id].members = [...new Set([...bb.groups[g.id].members, ...add])];
            })}>+</button>
            <button className="x" title="Delete group (keeps its members)" onClick={() => commit((bb) => delete bb.groups[g.id])}>×</button>
          </li>
        ))}
      </ul>
      {hasSel && <button onClick={() => groupSelection()}>Group selection</button>}
    </section>
  );
}
