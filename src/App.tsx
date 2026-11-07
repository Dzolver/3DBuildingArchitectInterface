import { useEffect } from 'react';
import { useStore, type ViewMode } from './store';
import { PlanView } from './components/PlanView';
import { View3D } from './components/View3D';
import { ElevationView } from './components/ElevationView';
import { Sidebar } from './components/Sidebar';
import { Library } from './components/Library';
import { Inspector, deleteSelection, groupSelection, mergeSelection, rotateSelection, toggleHiddenSelection } from './components/Inspector';
import { exportForUnreal, newProject, openProject, saveProject } from './fileio';

const VIEWS: { id: ViewMode; label: string; key: string }[] = [
  { id: 'plan', label: 'Plan', key: '1' },
  { id: 'front', label: 'Front', key: '2' },
  { id: 'back', label: 'Back', key: '3' },
  { id: 'left', label: 'Left', key: '4' },
  { id: 'right', label: 'Right', key: '5' },
  { id: '3d', label: '3D', key: '6' },
];

const TOOL_KEYS: Record<string, Parameters<ReturnType<typeof useStore.getState>['setTool']>[0]> = {
  v: 'select', w: 'wall', r: 'rect', d: 'door', n: 'window', a: 'arch', s: 'stair', f: 'roof', c: 'chimney', o: 'hole',
};

export function App() {
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const fileName = useStore((s) => s.fileName);
  const dirty = useStore((s) => s.dirty);
  const canUndo = useStore((s) => s.past.length > 0);
  const canRedo = useStore((s) => s.future.length > 0);
  const name = useStore((s) => s.doc.building.name);
  const screen = useStore((s) => s.screen);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return;
      const s = useStore.getState();
      if (s.screen !== 'editor') return;
      const ctrl = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (ctrl && k === 'z') { e.preventDefault(); e.shiftKey ? s.redo() : s.undo(); }
      else if (ctrl && k === 'y') { e.preventDefault(); s.redo(); }
      else if (ctrl && k === 's') { e.preventDefault(); void saveProject(e.shiftKey); }
      else if (ctrl && k === 'o') { e.preventDefault(); openProject(); }
      else if (ctrl && k === 'e') { e.preventDefault(); void exportForUnreal(); }
      else if (ctrl && k === 'g') { e.preventDefault(); groupSelection(); }
      else if (ctrl && k === 'a') {
        e.preventDefault();
        const b = s.doc.building;
        const f = s.activeFloorId;
        const walls = Object.values(b.walls).filter((w) => w.floorId === f).map((w) => w.id);
        s.select({
          walls,
          rooms: Object.values(b.rooms).filter((r) => r.floorId === f).map((r) => r.id),
          openings: Object.values(b.openings).filter((o) => walls.includes(o.wallId)).map((o) => o.id),
          stairs: Object.values(b.stairs).filter((x) => x.floorId === f).map((x) => x.id),
          roofs: Object.values(b.roofs).filter((x) => x.floorId === f).map((x) => x.id),
          chimneys: Object.values(b.chimneys).filter((x) => x.floorId === f).map((x) => x.id),
          holes: Object.values(b.holes).filter((x) => x.floorId === f).map((x) => x.id),
        });
      }
      else if (ctrl) return;
      else if (TOOL_KEYS[k]) { s.setTool(TOOL_KEYS[k]); if (s.view !== 'plan') s.setView('plan'); }
      else if (e.code === 'BracketLeft' || e.code === 'BracketRight') {
        if (rotateSelection((e.code === 'BracketLeft' ? 1 : -1) * (e.shiftKey ? 1 : 15))) e.preventDefault();
      }
      else if (k === 'j') mergeSelection();
      else if (k === 'h') toggleHiddenSelection();
      else if (k === 'l') s.setScreen('library');
      else if (VIEWS.some((v) => v.key === e.key)) s.setView(VIEWS.find((v) => v.key === e.key)!.id);
      else if (e.key === 'Tab') { e.preventDefault(); s.setView(s.view === 'plan' ? '3d' : 'plan'); }
      else if (e.key === 'Delete' || e.key === 'Backspace') deleteSelection();
      else if (e.key === 'Escape') s.clearSelection();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    document.title = `${dirty ? '• ' : ''}${fileName ?? name} — Building Architect`;
  }, [dirty, fileName, name]);

  return (
    <div className={`app ${screen === 'library' ? 'lib-mode' : ''}`}>
      <header className="topbar">
        <strong className="brand">Building Architect</strong>
        <div className="group seg">
          <button className={screen === 'library' ? 'on' : ''} onClick={() => useStore.getState().setScreen('library')} title="L">Library</button>
          <button className={screen === 'editor' ? 'on' : ''} onClick={() => useStore.getState().setScreen('editor')}>Editor</button>
        </div>
        {screen === 'editor' && (
          <>
            <div className="group">
              <button onClick={newProject}>New</button>
              <button onClick={openProject} title="Ctrl+O">Open</button>
              <button onClick={() => void saveProject()} title="Ctrl+S">Save</button>
              <button onClick={() => void saveProject(true)} title="Ctrl+Shift+S">Save as</button>
              <button className="primary" onClick={() => void exportForUnreal()} title="Ctrl+E">Export for UE / Blender</button>
            </div>
            <div className="group">
              <button disabled={!canUndo} onClick={() => useStore.getState().undo()} title="Ctrl+Z">Undo</button>
              <button disabled={!canRedo} onClick={() => useStore.getState().redo()} title="Ctrl+Shift+Z">Redo</button>
            </div>
            <div className="group seg">
              {VIEWS.map((v) => (
                <button key={v.id} className={view === v.id ? 'on' : ''} onClick={() => setView(v.id)} title={`${v.label} view (${v.key})`}>{v.label}</button>
              ))}
            </div>
          </>
        )}
        <span className="file">{name}{fileName ? ` · ${fileName}` : ''}{dirty ? ' •' : ''}</span>
      </header>
      {screen === 'library' ? (
        <Library />
      ) : (
        <>
          <Sidebar />
          <main className="canvas">
            {view === 'plan' ? <PlanView /> : view === '3d' ? <View3D /> : <ElevationView side={view} />}
          </main>
          <Inspector />
        </>
      )}
    </div>
  );
}
