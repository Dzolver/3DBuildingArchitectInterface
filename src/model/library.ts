// Blueprint library stored in the browser's IndexedDB. Each record holds a full project.
import type { Id, ProjectDoc } from './types';
import { migrate } from './migrate';

/** Older records may predate newer fields; bring them up to date on read. */
function fix(rec: BlueprintRecord): BlueprintRecord | null {
  try {
    return { ...rec, doc: migrate(rec.doc) };
  } catch {
    return null;
  }
}

export interface BlueprintRecord {
  id: Id;
  name: string;
  updatedAt: number;
  createdAt: number;
  doc: ProjectDoc;
}

const DB = 'building-architect';
const STORE = 'blueprints';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise<T>((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function listBlueprints(): Promise<BlueprintRecord[]> {
  try {
    const all = await tx<BlueprintRecord[]>('readonly', (s) => s.getAll() as IDBRequest<BlueprintRecord[]>);
    return all.map(fix).filter((r): r is BlueprintRecord => !!r).sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

export async function getBlueprint(id: Id): Promise<BlueprintRecord | undefined> {
  try {
    const rec = await tx<BlueprintRecord | undefined>('readonly', (s) => s.get(id) as IDBRequest<BlueprintRecord | undefined>);
    return rec ? fix(rec) ?? undefined : undefined;
  } catch {
    return undefined;
  }
}

export async function saveBlueprint(doc: ProjectDoc): Promise<void> {
  const prev = await getBlueprint(doc.id);
  const now = Date.now();
  const rec: BlueprintRecord = { id: doc.id, name: doc.building.name, updatedAt: now, createdAt: prev?.createdAt ?? now, doc: structuredClone(doc) };
  await tx('readwrite', (s) => s.put(rec));
}

export async function deleteBlueprint(id: Id): Promise<void> {
  await tx('readwrite', (s) => s.delete(id));
}
