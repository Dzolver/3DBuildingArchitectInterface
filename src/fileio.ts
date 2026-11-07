import { buildExport } from './model/export';
import { migrate } from './model/migrate';
import { newDoc, useStore } from './store';

// Minimal typings for the File System Access API (Chrome / Edge).
type Handle = { name: string; createWritable: () => Promise<{ write: (d: Blob) => Promise<void>; close: () => Promise<void> }> };
type PickerWindow = Window & {
  showSaveFilePicker?: (o: unknown) => Promise<Handle>;
};

let currentHandle: Handle | null = null;

const slug = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'building';

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** mode: 'save' reuses the open file, 'saveAs' asks and remembers, 'export' asks and forgets. */
async function writeWithPicker(suggested: string, text: string, mode: 'save' | 'saveAs' | 'export'): Promise<string | null> {
  const w = window as PickerWindow;
  if (!w.showSaveFilePicker) {
    download(suggested, text);
    return suggested;
  }
  try {
    const handle = mode === 'save' && currentHandle ? currentHandle : await w.showSaveFilePicker({
      suggestedName: suggested,
      types: [{ description: 'Building Architect JSON', accept: { 'application/json': ['.json'] } }],
    });
    const out = await handle.createWritable();
    await out.write(new Blob([text], { type: 'application/json' }));
    await out.close();
    if (mode !== 'export') currentHandle = handle;
    return handle.name;
  } catch (e) {
    if ((e as DOMException)?.name === 'AbortError') return null;
    throw e;
  }
}

export async function saveProject(saveAs = false) {
  const { doc } = useStore.getState();
  const name = await writeWithPicker(`${slug(doc.building.name)}.bpa.json`, JSON.stringify(doc, null, 2), saveAs ? 'saveAs' : 'save');
  if (name) useStore.getState().markSaved(name);
}

export async function exportForUnreal() {
  const { doc } = useStore.getState();
  await writeWithPicker(`${slug(doc.building.name)}.export.json`, JSON.stringify(buildExport(doc), null, 2), 'export');
}

export function openProject() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const doc = migrate(JSON.parse(await file.text()));
      currentHandle = null;
      useStore.getState().load(doc, file.name);
    } catch (e) {
      window.alert(`Could not open ${file.name}: ${(e as Error).message}`);
    }
  };
  input.click();
}

export function newProject() {
  const s = useStore.getState();
  if (s.dirty && !window.confirm('Start a new building? Unsaved changes will be lost.')) return;
  currentHandle = null;
  s.load(newDoc(), null);
  s.setScreen('editor');
}
