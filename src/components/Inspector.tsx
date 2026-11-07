import { Fragment, useEffect, useState } from 'react';
import { useStore, type Selection } from '../store';
import { deleteWalls, mergeWalls, mergeableCount, setWallLength } from '../model/ops';
import { roofRidgeZ } from '../model/roof';
import { chimneyTop, polygonArea3, resolvedRoofs, roofParts } from '../model/solids';
import { stairLayout } from '../model/stairs';
import { bbox, clipToConvex, faceKey, findFaces, isConvex, pointInPolygon, roomInterior, rotRect, signedArea, uid, wallLength } from '../model/geometry';
import type { Building, Chimney, FloorHole, Id, Opening, OpeningType, Quarter, Roof, RoofType, Stair, StairShape, WallKind } from '../model/types';
import { fmt } from '../format';

/** A number input that commits on Enter or blur. Values in metres. */
export function NumberField({ label, value, onCommit, step = 0.125, min, suffix = 'm' }: {
  label: string;
  value: number | '';
  onCommit: (v: number) => void;
  step?: number;
  min?: number;
  suffix?: string;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(value === '' ? '' : String(Math.round(Number(value) * 1000) / 1000)), [value]);
  const commit = () => {
    const v = Number(text);
    if (text.trim() !== '' && Number.isFinite(v) && (min === undefined || v >= min) && v !== value) onCommit(v);
    else setText(value === '' ? '' : String(value));
  };
  return (
    <label className="field">
      <span>{label}</span>
      <span className="input-wrap">
        <input type="number" step={step} value={text} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
        <em>{suffix}</em>
      </span>
    </label>
  );
}

function TextField({ label, value, onCommit }: { label: string; value: string; onCommit: (v: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <label className="field">
      <span>{label}</span>
      <input value={text} onChange={(e) => setText(e.target.value)} onBlur={() => text.trim() && text !== value && onCommit(text.trim())} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
    </label>
  );
}

/** Tag chips. `tagLists` are the tag lists of every selected item; a chip shows if any item has it. */
function TagEditor({ tagLists, onAdd, onRemove }: { tagLists: string[][]; onAdd: (t: string[]) => void; onRemove: (t: string) => void }) {
  const [text, setText] = useState('');
  const all = [...new Set(tagLists.flat())];
  const add = () => {
    const tags = text.split(/[,\s]+/).map((t) => t.trim()).filter(Boolean);
    if (tags.length) onAdd(tags);
    setText('');
  };
  return (
    <div className="tags">
      <div className="chips">
        {all.map((t) => {
          const partial = tagLists.some((l) => !l.includes(t));
          return (
            <span key={t} className={`chip ${partial ? 'partial' : ''}`} title={partial ? 'Only some of the selection has this tag' : ''}>
              {t}
              <button onClick={() => onRemove(t)} aria-label={`Remove tag ${t}`}>×</button>
            </span>
          );
        })}
      </div>
      <input placeholder="Add tag (e.g. f1-r1), Enter" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} onBlur={() => text && add()} />
    </div>
  );
}

function roomGeometry(b: Building, roomId: Id) {
  const r = b.rooms[roomId];
  const face = findFaces(b, r.floorId).find((f) => faceKey(f.cornerIds) === r.key);
  if (!face) return null;
  const inner = roomInterior(b, face);
  const bb = bbox(inner);
  // floor openings inside this room (clipped to the room when it is convex)
  let holes = 0;
  for (const h of Object.values(b.holes)) {
    if (h.floorId !== r.floorId) continue;
    const poly = rotRect(h);
    const c = { x: h.x + h.w / 2, y: h.y + h.d / 2 };
    if (isConvex(inner)) holes += Math.abs(signedArea(clipToConvex(poly, inner)));
    else if (pointInPolygon(c, inner)) holes += h.w * h.d;
  }
  return { clearX: bb.maxX - bb.minX, clearY: bb.maxY - bb.minY, area: signedArea(inner), walls: face.wallIds.length, holes };
}

type Taggable = { tags: string[]; hidden?: boolean };
const TAG_KEYS = ['walls', 'rooms', 'openings', 'stairs', 'roofs', 'chimneys', 'holes'] as const;

function selectedItems(bb: Building, sel: Selection): Taggable[] {
  return TAG_KEYS.flatMap((k) => sel[k].map((id) => (bb[k] as Record<Id, Taggable>)[id]).filter(Boolean));
}

export function Inspector() {
  const doc = useStore((s) => s.doc);
  const sel = useStore((s) => s.selection);
  const commit = useStore((s) => s.commit);
  const b = doc.building;
  const walls = sel.walls.map((id) => b.walls[id]).filter(Boolean);
  const rooms = sel.rooms.map((id) => b.rooms[id]).filter(Boolean);
  const openings = sel.openings.map((id) => b.openings[id]).filter(Boolean);
  const stairs = sel.stairs.map((id) => b.stairs[id]).filter(Boolean);
  const roofs = sel.roofs.map((id) => b.roofs[id]).filter(Boolean);
  const chimneys = sel.chimneys.map((id) => b.chimneys[id]).filter(Boolean);
  const holes = sel.holes.map((id) => b.holes[id]).filter(Boolean);
  const items = selectedItems(b, sel);
  const nothing = !items.length && !sel.corners.length;
  const hideable = walls.length + openings.length + stairs.length + roofs.length + chimneys.length + holes.length;
  const mergeable = mergeableCount(b, sel.walls);

  const editWalls = (fn: (w: Building['walls'][string]) => void) => commit((bb) => sel.walls.forEach((id) => bb.walls[id] && fn(bb.walls[id])));
  const editRooms = (fn: (r: Building['rooms'][string]) => void) => commit((bb) => sel.rooms.forEach((id) => bb.rooms[id] && fn(bb.rooms[id])));
  const editOpenings = (fn: (o: Opening) => void) => commit((bb) => sel.openings.forEach((id) => bb.openings[id] && fn(bb.openings[id])));
  const editStairs = (fn: (o: Stair) => void) => commit((bb) => sel.stairs.forEach((id) => bb.stairs[id] && fn(bb.stairs[id])));
  const editRoofs = (fn: (o: Roof) => void) => commit((bb) => sel.roofs.forEach((id) => bb.roofs[id] && fn(bb.roofs[id])));
  const editHoles = (fn: (o: FloorHole) => void) => commit((bb) => sel.holes.forEach((id) => bb.holes[id] && fn(bb.holes[id])));
  const editChimneys = (fn: (o: Chimney) => void) => commit((bb) => sel.chimneys.forEach((id) => bb.chimneys[id] && fn(bb.chimneys[id])));

  return (
    <aside className="inspector">
      {nothing && <BuildingPanel />}

      {walls.length === 1 && (() => {
        const w = walls[0];
        const len = wallLength(b, w);
        const floor = b.floors.find((f) => f.id === w.floorId)!;
        const mods = len / doc.kit.module;
        const onGrid = Math.abs(mods - Math.round(mods)) < 1e-3;
        const ops = Object.values(b.openings).filter((o) => o.wallId === w.id);
        return (
          <section>
            <h3>Wall <small>{w.tags.join(', ')}</small></h3>
            <NumberField label="Length" value={Math.round(len * 1000) / 1000} min={0.01} onCommit={(v) => commit((bb) => setWallLength(bb, w.id, v))} />
            <p className={`note ${onGrid ? '' : 'warn'}`}>{onGrid ? `${Math.round(mods)} × ${doc.kit.module} m module${Math.round(mods) === 1 ? '' : 's'}` : `${mods.toFixed(3)} modules — not a whole number of ${doc.kit.module} m modules`}</p>
            <NumberField label="Thickness" value={w.thickness} min={0.01} onCommit={(v) => editWalls((x) => (x.thickness = v))} />
            <NumberField label="Height" value={w.height ?? floor.height} min={0.01} onCommit={(v) => editWalls((x) => (x.height = v === floor.height ? null : v))} />
            <KindPicker value={w.kind} onChange={(k) => editWalls((x) => (x.kind = k))} />
            {ops.length > 0 && <p className="note">{ops.length} opening{ops.length === 1 ? '' : 's'}: {ops.map((o) => `${o.type} ${fmt(o.width)}`).join(', ')}</p>}
            <div className="presets">
              <button onClick={() => useStore.getState().setTool('door')}>+ Door <kbd>D</kbd></button>
              <button onClick={() => useStore.getState().setTool('window')}>+ Window <kbd>N</kbd></button>
              <button onClick={() => useStore.getState().setTool('arch')}>+ Arch</button>
            </div>
          </section>
        );
      })()}

      {walls.length > 1 && (
        <section>
          <h3>{walls.length} walls</h3>
          <p className="note">Total length {fmt(walls.reduce((s, w) => s + wallLength(b, w), 0))}</p>
          <NumberField label="Thickness (all)" value={walls.every((w) => w.thickness === walls[0].thickness) ? walls[0].thickness : ''} min={0.01} onCommit={(v) => editWalls((x) => (x.thickness = v))} />
          <KindPicker value={walls.every((w) => w.kind === walls[0].kind) ? walls[0].kind : null} onChange={(k) => editWalls((x) => (x.kind = k))} />
        </section>
      )}

      {walls.length > 1 && (
        <section>
          <button disabled={!mergeable} onClick={mergeSelection} title="Joins walls that meet end to end in a straight line, where no other wall meets them">
            Merge {mergeable ? `${mergeable} joint${mergeable === 1 ? '' : 's'}` : 'walls'} <kbd>J</kbd>
          </button>
          {!mergeable && <p className="note">Only connected walls in a straight line, with no third wall at the joint, can merge.</p>}
        </section>
      )}

      {openings.length === 1 && (() => {
        const o = openings[0];
        const w = b.walls[o.wallId];
        const len = w ? wallLength(b, w) : 0;
        return (
          <section>
            <h3>{o.type} <small>{o.tags.join(', ')}</small></h3>
            <div className="field">
              <span>Type</span>
              <div className="seg">
                {(['door', 'window', 'arch'] as OpeningType[]).map((t) => (
                  <button key={t} className={o.type === t ? 'on' : ''} onClick={() => editOpenings((x) => {
                    x.type = t;
                    if (t === 'door' || t === 'arch') x.sill = 0;
                    if (t === 'window' && x.sill === 0) x.sill = doc.kit.window.sill;
                  })}>{t}</button>
                ))}
              </div>
            </div>
            <NumberField label="Width" value={o.width} min={0.125} onCommit={(v) => editOpenings((x) => (x.width = v))} />
            <NumberField label="Height" value={o.height} min={0.125} onCommit={(v) => editOpenings((x) => (x.height = v))} />
            <NumberField label="Sill" value={o.sill} min={0} onCommit={(v) => editOpenings((x) => (x.sill = v))} />
            <NumberField label="From start" value={Math.round((o.offset - o.width / 2) * 1000) / 1000} min={0} onCommit={(v) => editOpenings((x) => (x.offset = v + x.width / 2))} />
            <NumberField label="From end" value={Math.round((len - o.offset - o.width / 2) * 1000) / 1000} min={0} onCommit={(v) => editOpenings((x) => (x.offset = len - v - x.width / 2))} />
            <p className="note">Head at {fmt(o.sill + o.height)} · wall {w?.tags[0] ?? ''} is {fmt(len)} long. Drag the opening to slide it along the wall.</p>
          </section>
        );
      })()}

      {openings.length > 1 && (
        <section>
          <h3>{openings.length} openings</h3>
          <NumberField label="Width (all)" value={openings.every((o) => o.width === openings[0].width) ? openings[0].width : ''} min={0.125} onCommit={(v) => editOpenings((x) => (x.width = v))} />
          <NumberField label="Height (all)" value={openings.every((o) => o.height === openings[0].height) ? openings[0].height : ''} min={0.125} onCommit={(v) => editOpenings((x) => (x.height = v))} />
          <NumberField label="Sill (all)" value={openings.every((o) => o.sill === openings[0].sill) ? openings[0].sill : ''} min={0} onCommit={(v) => editOpenings((x) => (x.sill = v))} />
        </section>
      )}

      {stairs.length === 1 && <StairPanel s={stairs[0]} edit={editStairs} />}
      {stairs.length > 1 && (
        <section>
          <h3>{stairs.length} stairs</h3>
          <RotateField label="Rotation (all)" value={stairs.every((x) => x.angle === stairs[0].angle) ? stairs[0].angle : ''} onCommit={(v) => editStairs((x) => (x.angle = v))} onNudge={(d) => editStairs((x) => (x.angle = normAngle(x.angle + d)))} />
        </section>
      )}

      {roofs.length === 1 && <RoofPanel roof={roofs[0]} edit={editRoofs} />}

      {roofs.length > 1 && (
        <section>
          <h3>{roofs.length} roofs</h3>
          <RotateField label="Rotation (all)" value={roofs.every((r) => r.angle === roofs[0].angle) ? roofs[0].angle : ''} onCommit={(v) => editRoofs((x) => (x.angle = v))} onNudge={(d) => editRoofs((x) => (x.angle = normAngle(x.angle + d)))} />
          <NumberField label="Pitch (all)" value={roofs.every((r) => r.pitch === roofs[0].pitch) ? roofs[0].pitch : ''} min={1} step={1} suffix="°" onCommit={(v) => editRoofs((x) => (x.pitch = Math.min(80, v)))} />
          <NumberField label="Overhang (all)" value={roofs.every((r) => r.overhang === roofs[0].overhang) ? roofs[0].overhang : ''} min={0} onCommit={(v) => editRoofs((x) => (x.overhang = v))} />
        </section>
      )}

      {holes.length === 1 && <HolePanel h={holes[0]} edit={editHoles} />}
      {holes.length > 1 && (
        <section>
          <h3>{holes.length} floor openings</h3>
          <p className="note">Total {holes.reduce((a, h) => a + h.w * h.d, 0).toFixed(2)} m²</p>
        </section>
      )}

      {chimneys.length === 1 && <ChimneyPanel c={chimneys[0]} edit={editChimneys} />}
      {chimneys.length > 1 && (
        <section>
          <h3>{chimneys.length} chimneys</h3>
          <NumberField label="Clearance (all)" value={chimneys.every((c) => c.clearance === chimneys[0].clearance) ? chimneys[0].clearance : ''} min={0} onCommit={(v) => editChimneys((x) => (x.clearance = v))} />
        </section>
      )}

      {rooms.length === 1 && (() => {
        const r = rooms[0];
        const g = roomGeometry(b, r.id);
        return (
          <section>
            <h3>Room</h3>
            <TextField label="Name" value={r.name} onCommit={(v) => editRooms((x) => (x.name = v))} />
            {g && (
              <dl className="facts">
                <dt>Clear size</dt><dd>{fmt(g.clearX)} × {fmt(g.clearY)}</dd>
                <dt>Floor area</dt><dd>{g.area.toFixed(2)} m²</dd>
                {g.holes > 0 && <><dt>Openings</dt><dd>−{g.holes.toFixed(2)} m² · net {(g.area - g.holes).toFixed(2)} m²</dd></>}
                <dt>Walls</dt><dd>{g.walls}</dd>
              </dl>
            )}
          </section>
        );
      })()}

      {rooms.length > 1 && (
        <section>
          <h3>{rooms.length} rooms</h3>
          <p className="note">Total area {rooms.reduce((s, r) => s + (roomGeometry(b, r.id)?.area ?? 0), 0).toFixed(2)} m²</p>
        </section>
      )}

      {(rooms.length > 0 || walls.length > 0) && roofs.length === 0 && (
        <section>
          <button onClick={roofOverSelection}>Roof over selection</button>
          <p className="note">Adds a gable roof covering the selected rooms and walls, on top of their floor.</p>
        </section>
      )}

      {items.length > 0 && (
        <section>
          <h3>Tags</h3>
          <TagEditor
            tagLists={items.map((it) => it.tags)}
            onAdd={(tags) => commit((bb) => {
              for (const it of selectedItems(bb, sel)) for (const t of tags) if (!it.tags.includes(t)) it.tags.push(t);
            })}
            onRemove={(t) => commit((bb) => {
              for (const it of selectedItems(bb, sel)) it.tags = it.tags.filter((x) => x !== t);
            })}
          />
        </section>
      )}

      {!nothing && (
        <section className="actions">
          {items.length > 0 && <button onClick={() => groupSelection()}>Group selection <kbd>Ctrl+G</kbd></button>}
          {hideable > 0 && <button onClick={toggleHiddenSelection}>Hide / show <kbd>H</kbd></button>}
          <button className="danger" onClick={() => deleteSelection()}>Delete selection <kbd>Del</kbd></button>
        </section>
      )}
    </aside>
  );
}

function RoofPanel({ roof: r, edit }: { roof: Roof; edit: (fn: (r: Roof) => void) => void }) {
  const doc = useStore((s) => s.doc);
  const b = doc.building;
  const pieces = roofParts(b, r);
  const trimmedBy = resolvedRoofs(b).get(r.id)?.trimmedBy ?? [];
  const floor = b.floors.find((f) => f.id === r.floorId);
  const ridge = roofRidgeZ(b, r);
  const types: RoofType[] = ['gable', 'hip', 'shed', 'gambrel', 'flat'];
  const dirs: [Quarter, string][] = r.type === 'shed' ? [[0, 'high +y'], [90, 'high −x'], [180, 'high −y'], [270, 'high +x']] : [[0, 'ridge ↔ x'], [90, 'ridge ↕ y']];
  return (
    <section>
      <h3>Roof <small>{r.tags.join(', ')}</small></h3>
      <TextField label="Name" value={r.name} onCommit={(v) => edit((x) => (x.name = v))} />
      <div className="field">
        <span>Type</span>
        <div className="seg wrap">
          {types.map((t) => (
            <button key={t} className={r.type === t ? 'on' : ''} onClick={() => edit((x) => { x.type = t; x.hiddenPieces = []; if (t !== 'shed' && (x.dir === 180 || x.dir === 270)) x.dir = x.dir === 180 ? 0 : 90; })}>{t}</button>
          ))}
        </div>
      </div>
      <div className="field">
        <span>Direction</span>
        <div className="seg wrap">
          {dirs.map(([d, l]) => (
            <button key={d} className={r.dir === d ? 'on' : ''} onClick={() => edit((x) => (x.dir = d))}>{l}</button>
          ))}
        </div>
      </div>
      <RotateField label="Rotation" value={r.angle ?? 0} onCommit={(v) => edit((x) => (x.angle = v))} onNudge={(d) => edit((x) => (x.angle = normAngle((x.angle ?? 0) + d)))} />
      {r.type !== 'flat' && <NumberField label="Pitch" value={r.pitch} min={1} step={1} suffix="°" onCommit={(v) => edit((x) => (x.pitch = Math.min(80, v)))} />}
      <NumberField label="Overhang" value={r.overhang} min={0} onCommit={(v) => edit((x) => (x.overhang = v))} />
      <NumberField label="Thickness" value={r.thickness} min={0.01} onCommit={(v) => edit((x) => (x.thickness = v))} />
      {r.type === 'flat' && <NumberField label="Parapet" value={r.parapet} min={0} onCommit={(v) => edit((x) => (x.parapet = v))} />}
      <NumberField label="Footprint x" value={r.w} min={0.5} onCommit={(v) => edit((x) => (x.w = v))} />
      <NumberField label="Footprint y" value={r.d} min={0.5} onCommit={(v) => edit((x) => (x.d = v))} />
      <NumberField label="Base height" value={r.base ?? floor?.height ?? 0} min={0} onCommit={(v) => edit((x) => (x.base = v === floor?.height ? null : v))} />
      <dl className="facts">
        <dt>Sits on</dt><dd>{floor?.name}</dd>
        <dt>Ridge</dt><dd>{fmt(ridge)} above ground</dd>
      </dl>
      <label className="check">
        <input type="checkbox" checked={r.trim !== false} onChange={(e) => edit((x) => (x.trim = e.target.checked))} />
        <span>Cut where other roofs and chimneys run into it</span>
      </label>
      {r.trim !== false && (
        <p className="note trimmed-note">
          {trimmedBy.length
            ? `Trimmed by ${trimmedBy.map((id) => b.roofs[id]?.name ?? b.chimneys[id]?.name ?? id).join(', ')} (valleys are cut automatically).`
            : 'Not touching any other roof or chimney.'}
        </p>
      )}
      <h3 style={{ marginTop: 14 }}>Pieces</h3>
      <ul className="pieces">
        {pieces.map((p) => {
          const hidden = r.hiddenPieces.includes(p.key);
          return (
            <li key={p.key} className={hidden ? 'off' : ''}>
              <button className="eye" title={hidden ? 'Show piece' : 'Hide piece'} onClick={() => edit((x) => (x.hiddenPieces = hidden ? x.hiddenPieces.filter((k) => k !== p.key) : [...x.hiddenPieces, p.key]))}>
                {hidden ? '◌' : '●'}
              </button>
              <span>{p.label}</span>
              <em>{(() => {
                const full = polygonArea3(p.polygon);
                const left = (p.parts ?? [p.polygon]).reduce((a, q) => a + polygonArea3(q), 0);
                return left < 1e-6 ? 'buried' : full - left > 1e-3 ? `trimmed ${Math.round((left / full) * 100)}%` : p.kind;
              })()}</em>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

const normAngle = (a: number) => Math.round(((((a % 360) + 540) % 360) - 180) * 10) / 10;

function RotateField({ label, value, onCommit, onNudge }: { label: string; value: number | ''; onCommit: (v: number) => void; onNudge: (d: number) => void }) {
  return (
    <>
      <NumberField label={label} value={value} step={1} suffix="°" onCommit={(v) => onCommit(normAngle(v))} />
      <div className="presets">
        {[-90, -15, 15, 90].map((d) => (
          <button key={d} onClick={() => onNudge(d)} title={`Rotate ${d > 0 ? 'counter-clockwise' : 'clockwise'} ${Math.abs(d)}°`}>{d > 0 ? `⟲ ${d}°` : `⟳ ${-d}°`}</button>
        ))}
        <button onClick={() => onCommit(0)}>0°</button>
      </div>
    </>
  );
}

const SHAPES: [StairShape, string, string][] = [
  ['straight', 'straight', 'One flight'],
  ['landing', 'mid landing', 'Two flights in a line with a platform between'],
  ['l', 'L turn', 'Quarter turn at a corner landing'],
  ['u', 'U turn', 'Half turn at a full-width landing, flights side by side'],
];

function StairPanel({ s, edit }: { s: Stair; edit: (fn: (o: Stair) => void) => void }) {
  const doc = useStore((st) => st.doc);
  const b = doc.building;
  const lay = stairLayout(b, s);
  const tight = lay.flights.some((f) => f.tread > 0 && f.tread < 0.22);
  const ok = lay.riser <= 0.22 && !tight;
  const twoFlights = lay.flights.length > 1;
  return (
    <section>
      <h3>Stair <small>{s.tags.join(', ')}</small></h3>
      <TextField label="Name" value={s.name} onCommit={(v) => edit((x) => (x.name = v))} />
      <div className="field">
        <span>Shape</span>
        <div className="seg wrap">
          {SHAPES.map(([k, l, t]) => (
            <button key={k} title={t} className={s.shape === k ? 'on' : ''} onClick={() => edit((x) => (x.shape = k))}>{l}</button>
          ))}
        </div>
      </div>
      {(s.shape === 'l' || s.shape === 'u') && (
        <div className="field">
          <span>Turns</span>
          <div className="seg">
            {(['left', 'right'] as const).map((t) => (
              <button key={t} className={s.turn === t ? 'on' : ''} onClick={() => edit((x) => (x.turn = t))}>{t === 'left' ? '↰ left' : '↱ right'}</button>
            ))}
          </div>
        </div>
      )}
      <NumberField label="Width (x)" value={s.w} min={0.25} onCommit={(v) => edit((x) => (x.w = v))} />
      <NumberField label="Depth (y)" value={s.d} min={0.25} onCommit={(v) => edit((x) => (x.d = v))} />
      {(s.shape === 'l' || s.shape === 'u') && <NumberField label="Flight width" value={s.flightWidth} min={0.5} onCommit={(v) => edit((x) => (x.flightWidth = v))} />}
      {(s.shape === 'landing' || s.shape === 'u') && <NumberField label="Landing depth" value={s.landing} min={0.5} onCommit={(v) => edit((x) => (x.landing = v))} />}
      {twoFlights && (
        <NumberField label="Risers to landing" value={lay.flights[0].risers} min={1} step={1} suffix="" onCommit={(v) => edit((x) => (x.split = Math.max(1, Math.min(lay.steps - 1, Math.round(v))) / lay.steps))} />
      )}
      <NumberField label="Target riser" value={s.riser} min={0.05} step={0.01} onCommit={(v) => edit((x) => (x.riser = v))} />
      <div className="field">
        <span>Starts going</span>
        <div className="seg">
          {([[0, '→ +x'], [90, '↑ +y'], [180, '← −x'], [270, '↓ −y']] as [Quarter, string][]).map(([d, l]) => (
            <button key={d} className={s.dir === d ? 'on' : ''} onClick={() => edit((x) => (x.dir = d))}>{l}</button>
          ))}
        </div>
      </div>
      <RotateField label="Rotation" value={s.angle} onCommit={(v) => edit((x) => (x.angle = v))} onNudge={(d) => edit((x) => (x.angle = normAngle(x.angle + d)))} />
      <dl className="facts">
        <dt>Rise</dt><dd>{fmt(lay.rise)} to {lay.toFloor ? lay.toFloor.name : 'roof level'}</dd>
        <dt>Risers</dt><dd>{lay.steps} × {fmt(lay.riser)}</dd>
        {lay.flights.map((f, i) => (
          <Fragment key={i}>
            <dt>{twoFlights ? `Flight ${i + 1}` : 'Flight'}</dt>
            <dd className={f.tread > 0 && f.tread < 0.22 ? 'warn' : ''}>{f.risers} risers · tread {fmt(f.tread)} · {fmt(f.width)} wide</dd>
          </Fragment>
        ))}
        {lay.landing && (<><dt>Landing</dt><dd>{fmt(lay.landing.w)} × {fmt(lay.landing.d)} at +{fmt(lay.landing.height)}</dd></>)}
        <dt>Pitch</dt><dd>{lay.pitchDeg.toFixed(1)}°</dd>
      </dl>
      {!ok && <p className="note warn">Steep: aim for risers ≤ 0.22 m and treads ≥ 0.22 m (make the area bigger, move the landing split, or raise the riser).</p>}
      {s.shape === 'u' && s.flightWidth * 2 > (s.dir % 180 === 0 ? s.d : s.w) && <p className="note">The two flights are wider than the stair, so each is squeezed to half the width.</p>}
      <label className="check">
        <input type="checkbox" checked={s.opening !== false} onChange={(e) => edit((x) => (x.opening = e.target.checked))} />
        <span>Cut an opening in the floor above</span>
      </label>
      {s.opening !== false && lay.toFloor && (() => {
        const h = Object.values(b.holes).find((x) => x.stairId === s.id);
        const headroom = lay.rise - (lay.toFloor?.slab ?? 0);
        return (
          <>
            <NumberField label="Opening margin" value={s.openingMargin} min={0} onCommit={(v) => edit((x) => (x.openingMargin = v))} />
            {h && (
              <p className="note">
                Opening {fmt(h.w)} × {fmt(h.d)} on {lay.toFloor.name}{h.auto ? ', follows the stair' : ', sized by hand'} · {fmt(headroom)} clear under the slab edge.
                {!h.auto && <> <button className="link" onClick={() => useStore.getState().commit((bb) => { if (bb.holes[h.id]) bb.holes[h.id].auto = true; })}>Fit to stair again</button></>}
              </p>
            )}
          </>
        );
      })()}
      {!lay.toFloor && <p className="note">There is no floor above yet; add one and the stair cuts its opening there.</p>}
    </section>
  );
}

function HolePanel({ h, edit }: { h: FloorHole; edit: (fn: (o: FloorHole) => void) => void }) {
  const doc = useStore((st) => st.doc);
  const b = doc.building;
  const floor = b.floors.find((f) => f.id === h.floorId);
  const stair = h.stairId ? b.stairs[h.stairId] : null;
  const manual = (fn: (o: FloorHole) => void) => edit((x) => { fn(x); x.auto = false; });
  return (
    <section>
      <h3>Floor opening <small>{h.tags.join(', ')}</small></h3>
      <TextField label="Name" value={h.name} onCommit={(v) => edit((x) => (x.name = v))} />
      <NumberField label="Width (x)" value={h.w} min={0.25} onCommit={(v) => manual((x) => (x.w = v))} />
      <NumberField label="Depth (y)" value={h.d} min={0.25} onCommit={(v) => manual((x) => (x.d = v))} />
      <NumberField label="Min x" value={h.x} onCommit={(v) => manual((x) => (x.x = v))} />
      <NumberField label="Min y" value={h.y} onCommit={(v) => manual((x) => (x.y = v))} />
      <RotateField label="Rotation" value={h.angle} onCommit={(v) => manual((x) => (x.angle = v))} onNudge={(d) => manual((x) => (x.angle = normAngle(x.angle + d)))} />
      <dl className="facts">
        <dt>Floor</dt><dd>{floor?.name} (slab {fmt(floor?.slab ?? 0)})</dd>
        <dt>Area</dt><dd>{(h.w * h.d).toFixed(2)} m²</dd>
        {stair && <><dt>Stair</dt><dd>{stair.name} · {h.auto ? 'follows the stair' : 'sized by hand'}</dd></>}
      </dl>
      {stair && !h.auto && <button onClick={() => edit((x) => (x.auto = true))}>Fit to stair again</button>}
      <p className="note">Drag the corner squares in the plan to resize (module snap, Shift fine, Alt free).</p>
    </section>
  );
}

function ChimneyPanel({ c, edit }: { c: Chimney; edit: (fn: (c: Chimney) => void) => void }) {
  const doc = useStore((s) => s.doc);
  const b = doc.building;
  const top = chimneyTop(b, c);
  const floor = b.floors.find((f) => f.id === c.floorId);
  const auto = c.top === null;
  const cutting = [...resolvedRoofs(b).values()].filter((r) => r.trimmedBy.includes(c.id)).map((r) => r.roof.name);
  return (
    <section>
      <h3>Chimney <small>{c.tags.join(', ')}</small></h3>
      <TextField label="Name" value={c.name} onCommit={(v) => edit((x) => (x.name = v))} />
      <NumberField label="Width (x)" value={c.w} min={0.2} onCommit={(v) => edit((x) => (x.w = v))} />
      <NumberField label="Depth (y)" value={c.d} min={0.2} onCommit={(v) => edit((x) => (x.d = v))} />
      <NumberField label="Centre x" value={c.x} onCommit={(v) => edit((x) => (x.x = v))} />
      <NumberField label="Centre y" value={c.y} onCommit={(v) => edit((x) => (x.y = v))} />
      <RotateField label="Rotation" value={c.angle} onCommit={(v) => edit((x) => (x.angle = v))} onNudge={(d) => edit((x) => (x.angle = normAngle(x.angle + d)))} />
      <div className="field">
        <span>Starts on</span>
        <select value={c.floorId} onChange={(e) => edit((x) => (x.floorId = e.target.value))}>
          {b.floors.map((f, i) => <option key={f.id} value={f.id}>f{i + 1} {f.name}</option>)}
        </select>
      </div>
      <div className="field">
        <span>Top</span>
        <div className="seg">
          <button className={auto ? 'on' : ''} onClick={() => edit((x) => (x.top = null))}>auto</button>
          <button className={!auto ? 'on' : ''} onClick={() => edit((x) => (x.top = Math.round(top * 1000) / 1000))}>fixed</button>
        </div>
      </div>
      {auto
        ? <NumberField label="Above roof" value={c.clearance} min={0} onCommit={(v) => edit((x) => (x.clearance = v))} />
        : <NumberField label="Top height" value={c.top ?? top} min={(floor?.elevation ?? 0) + 0.2} onCommit={(v) => edit((x) => (x.top = v))} />}
      <label className="check">
        <input type="checkbox" checked={c.crown} onChange={(e) => edit((x) => (x.crown = e.target.checked))} />
        <span>Crown (wider cap course)</span>
      </label>
      <dl className="facts">
        <dt>Base</dt><dd>{fmt(floor?.elevation ?? 0)} ({floor?.name})</dd>
        <dt>Top</dt><dd>{fmt(top)} above ground</dd>
        <dt>Stack height</dt><dd>{fmt(top - (floor?.elevation ?? 0))}</dd>
        <dt>Cuts</dt><dd>{cutting.length ? cutting.join(', ') : 'no roofs'}</dd>
      </dl>
      {auto && <p className="note">Auto top follows the 3-2-10 rule: at least the clearance above where it leaves the roof, and 0.6 m above any roof within 3 m.</p>}
    </section>
  );
}

function KindPicker({ value, onChange }: { value: WallKind | null; onChange: (k: WallKind) => void }) {
  return (
    <div className="field">
      <span>Kind</span>
      <div className="seg">
        {(['exterior', 'interior'] as WallKind[]).map((k) => (
          <button key={k} className={value === k ? 'on' : ''} onClick={() => onChange(k)}>{k}</button>
        ))}
      </div>
    </div>
  );
}

function BuildingPanel() {
  const doc = useStore((s) => s.doc);
  const commit = useStore((s) => s.commit);
  const floorId = useStore((s) => s.activeFloorId);
  const b = doc.building;
  const floor = b.floors.find((f) => f.id === floorId)!;
  const fIdx = b.floors.indexOf(floor);
  return (
    <>
      <section>
        <h3>Building</h3>
        <TextField label="Name" value={b.name} onCommit={(v) => commit((bb) => (bb.name = v))} />
        <dl className="facts">
          <dt>Floors</dt><dd>{b.floors.length}</dd>
          <dt>Walls</dt><dd>{Object.keys(b.walls).length}</dd>
          <dt>Rooms</dt><dd>{Object.keys(b.rooms).length}</dd>
        </dl>
      </section>
      <section>
        <h3>Floor <small>f{fIdx + 1}</small></h3>
        <TextField label="Name" value={floor.name} onCommit={(v) => commit((bb) => (bb.floors[fIdx].name = v))} />
        <NumberField label="Story height" value={floor.height} min={0.5} onCommit={(v) => commit((bb) => (bb.floors[fIdx].height = v))} />
        <div className="presets">
          <button onClick={() => commit((bb) => (bb.floors[fIdx].height = doc.kit.storyHeight))}>{doc.kit.storyHeight} m standard</button>
          <button onClick={() => commit((bb) => (bb.floors[fIdx].height = 2.5))}>2.5 m PQ cottage</button>
        </div>
        <NumberField label="Slab" value={floor.slab} min={0} onCommit={(v) => commit((bb) => (bb.floors[fIdx].slab = v))} />
        <dl className="facts">
          <dt>Elevation</dt><dd>{fmt(floor.elevation)}</dd>
        </dl>
      </section>
      <section>
        <h3>Kit</h3>
        <NumberField label="Wall module" value={doc.kit.module} min={0.125} onCommit={(v) => commit((_bb, d) => (d.kit.module = v))} />
        <NumberField label="Fine grid" value={doc.kit.fineGrid} min={0.01} onCommit={(v) => commit((_bb, d) => (d.kit.fineGrid = v))} />
        <NumberField label="New wall thickness" value={doc.kit.wallThickness} min={0.01} onCommit={(v) => commit((_bb, d) => (d.kit.wallThickness = v))} />
        <NumberField label="Default story" value={doc.kit.storyHeight} min={0.5} onCommit={(v) => commit((_bb, d) => (d.kit.storyHeight = v))} />
        <NumberField label="Texture density" value={doc.kit.pxPerMetre} min={1} step={1} suffix="px/m" onCommit={(v) => commit((_bb, d) => (d.kit.pxPerMetre = v))} />
      </section>
    </>
  );
}

/** Delete selected walls, plus walls that belong only to selected rooms. */
export function deleteSelection() {
  const { selection, doc, commit, clearSelection } = useStore.getState();
  const b = doc.building;
  const ids = new Set(selection.walls);
  // a room's wall goes only if no unselected room also uses it
  const selectedKeys = new Set(selection.rooms.map((id) => b.rooms[id]?.key).filter(Boolean));
  for (const rid of selection.rooms) {
    const r = b.rooms[rid];
    if (!r) continue;
    const faces = findFaces(b, r.floorId);
    const face = faces.find((f) => faceKey(f.cornerIds) === r.key);
    if (!face) continue;
    for (const wid of face.wallIds) {
      const keptByOther = faces.some((f) => f.wallIds.includes(wid) && !selectedKeys.has(faceKey(f.cornerIds)));
      if (!keptByOther) ids.add(wid);
    }
  }
  for (const cid of selection.corners) {
    Object.values(b.walls).forEach((w) => (w.a === cid || w.b === cid) && ids.add(w.id));
  }
  const extra = selection.openings.length + selection.stairs.length + selection.roofs.length + selection.chimneys.length + selection.holes.length;
  if (!ids.size && !extra) return;
  commit((bb) => {
    for (const id of selection.openings) delete bb.openings[id];
    for (const id of selection.stairs) delete bb.stairs[id];
    for (const id of selection.roofs) delete bb.roofs[id];
    for (const id of selection.chimneys) delete bb.chimneys[id];
    for (const id of selection.holes) {
      // deleting a stair's opening switches that stair's automatic opening off
      const st = bb.holes[id]?.stairId;
      if (st && bb.stairs[st]) bb.stairs[st].opening = false;
      delete bb.holes[id];
    }
    deleteWalls(bb, [...ids]);
  });
  clearSelection();
}

export function mergeSelection() {
  const { selection, commit, select } = useStore.getState();
  if (selection.walls.length < 2) return;
  let kept: Id[] = [];
  commit((bb) => {
    kept = mergeWalls(bb, selection.walls);
  });
  select({ walls: kept });
}

export function toggleHiddenSelection() {
  const { selection, commit, doc } = useStore.getState();
  const b = doc.building;
  const list = [
    ...selection.walls.map((id) => b.walls[id]),
    ...selection.openings.map((id) => b.openings[id]),
    ...selection.stairs.map((id) => b.stairs[id]),
    ...selection.roofs.map((id) => b.roofs[id]),
    ...selection.chimneys.map((id) => b.chimneys[id]),
    ...selection.holes.map((id) => b.holes[id]),
  ].filter(Boolean);
  if (!list.length) return;
  const hide = list.some((x) => !x.hidden);
  commit((bb) => {
    for (const k of ['walls', 'openings', 'stairs', 'roofs', 'chimneys', 'holes'] as const) {
      for (const id of selection[k]) {
        const item = (bb[k] as Record<Id, { hidden?: boolean }>)[id];
        if (item) item.hidden = hide;
      }
    }
  });
}

export function groupSelection(name?: string) {
  const { selection, commit } = useStore.getState();
  const members = [...selection.walls, ...selection.rooms, ...selection.openings, ...selection.stairs, ...selection.roofs, ...selection.chimneys, ...selection.holes];
  if (!members.length) return;
  const id = uid('g');
  commit((bb) => {
    const n = Object.keys(bb.groups).length + 1;
    bb.groups[id] = { id, name: name ?? `Group ${n}`, members, tags: [] };
  });
  return id;
}

/** Add a gable roof over the bounding box of the selected rooms/walls (centrelines). */
export function roofOverSelection() {
  const { selection, commit, doc, select, activeFloorId } = useStore.getState();
  const b = doc.building;
  const cornerIds = new Set<Id>();
  for (const id of selection.walls) {
    cornerIds.add(b.walls[id].a);
    cornerIds.add(b.walls[id].b);
  }
  for (const id of selection.rooms) b.rooms[id]?.key.split('|').forEach((c) => cornerIds.add(c));
  const cs = [...cornerIds].map((id) => b.corners[id]).filter(Boolean);
  if (!cs.length) return;
  const floorId = cs[0].floorId ?? activeFloorId;
  const fit = alignedRect(b, cornerIds);
  const id = uid('rf');
  commit((bb) => {
    const n = Object.keys(bb.roofs).length + 1;
    bb.roofs[id] = { id, floorId, name: `Roof ${n}`, type: 'gable', ...fit, dir: fit.w >= fit.d ? 0 : 90, pitch: 35, overhang: 0.4, thickness: 0.2, parapet: 0.5, base: null, hiddenPieces: [], tags: [`roof-${n}`], trim: true };
  });
  useStore.setState({ showRoofs: true });
  select({ roofs: [id] });
}

/**
 * Smallest rectangle around a set of corners, turned to line up with the walls between them
 * (the angle carried by most wall length, folded into -45..45 degrees).
 */
export function alignedRect(b: Building, cornerIds: Set<Id>) {
  const cs = [...cornerIds].map((id) => b.corners[id]).filter(Boolean);
  const weight = new Map<number, number>();
  for (const w of Object.values(b.walls)) {
    if (!cornerIds.has(w.a) || !cornerIds.has(w.b)) continue;
    const A = b.corners[w.a];
    const B = b.corners[w.b];
    const len = Math.hypot(B.x - A.x, B.y - A.y);
    let a = (Math.atan2(B.y - A.y, B.x - A.x) * 180) / Math.PI;
    a = ((a % 90) + 90) % 90;
    if (a > 45) a -= 90;
    const k = Math.round(a * 10) / 10;
    weight.set(k, (weight.get(k) ?? 0) + len);
  }
  let angle = 0;
  let best = -1;
  for (const [a, wt] of weight) if (wt > best + 1e-9 || (Math.abs(wt - best) < 1e-9 && Math.abs(a) < Math.abs(angle))) [angle, best] = [a, wt];
  const rad = (angle * Math.PI) / 180;
  const ca = Math.cos(rad);
  const sa = Math.sin(rad);
  // into the rotated frame, take the box, and bring its centre back
  const local = cs.map((p) => ({ x: p.x * ca + p.y * sa, y: -p.x * sa + p.y * ca }));
  const bb0 = bbox(local);
  const w = Math.round((bb0.maxX - bb0.minX) * 1000) / 1000;
  const d = Math.round((bb0.maxY - bb0.minY) * 1000) / 1000;
  const lc = { x: (bb0.minX + bb0.maxX) / 2, y: (bb0.minY + bb0.maxY) / 2 };
  const c = { x: lc.x * ca - lc.y * sa, y: lc.x * sa + lc.y * ca };
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  return { x: r3(c.x - w / 2), y: r3(c.y - d / 2), w, d, angle };
}

/** Turn the selected roofs, stairs and chimneys by `delta` degrees (counter-clockwise). */
export function rotateSelection(delta: number) {
  const { selection, commit } = useStore.getState();
  if (!selection.roofs.length && !selection.chimneys.length && !selection.stairs.length && !selection.holes.length) return false;
  commit((bb) => {
    for (const id of selection.holes) if (bb.holes[id]) Object.assign(bb.holes[id], { angle: normAngle(bb.holes[id].angle + delta), auto: false });
    for (const id of selection.stairs) if (bb.stairs[id]) bb.stairs[id].angle = normAngle((bb.stairs[id].angle ?? 0) + delta);
    for (const id of selection.roofs) if (bb.roofs[id]) bb.roofs[id].angle = normAngle((bb.roofs[id].angle ?? 0) + delta);
    for (const id of selection.chimneys) if (bb.chimneys[id]) bb.chimneys[id].angle = normAngle(bb.chimneys[id].angle + delta);
  });
  return true;
}
