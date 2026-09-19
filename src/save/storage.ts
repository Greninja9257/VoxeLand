// IndexedDB persistence: worlds list, chunks, player + world state.
import type { ChunkData } from '../world/chunk';

const DB_NAME = 'voxeland';
const DB_VERSION = 1;

export interface WorldMeta {
  id: string; name: string; seed: number; created: number; lastPlayed: number; gameMode: 'survival' | 'creative' | 'adventure' | 'spectator'; difficulty: number; cheats: boolean; version: string;
}

let dbPromise: Promise<IDBDatabase> | null = null;
function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('worlds')) db.createObjectStore('worlds', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('chunks')) db.createObjectStore('chunks');
      if (!db.objectStoreNames.contains('state')) db.createObjectStore('state');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T> {
  return openDb().then((db) => new Promise<T>((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    const r = fn(s);
    t.oncomplete = () => resolve(r ? (r as IDBRequest<T>).result : (undefined as T));
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

export const storage = {
  async listWorlds(): Promise<WorldMeta[]> {
    const all = await tx<WorldMeta[]>('worlds', 'readonly', (s) => s.getAll());
    return (all ?? []).sort((a, b) => b.lastPlayed - a.lastPlayed);
  },
  saveWorldMeta(meta: WorldMeta): Promise<void> { return tx('worlds', 'readwrite', (s) => { s.put(meta); }); },
  async deleteWorld(id: string): Promise<void> {
    await tx('worlds', 'readwrite', (s) => { s.delete(id); });
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction(['chunks', 'state'], 'readwrite');
      const cs = t.objectStore('chunks');
      const range = IDBKeyRange.bound(id + ':', id + ':￿');
      cs.delete(range);
      t.objectStore('state').delete(range);
      t.oncomplete = () => resolve(); t.onerror = () => reject(t.error);
    });
  },
  loadChunk(worldId: string, dim: string, cx: number, cz: number): Promise<ChunkData | undefined> {
    return tx<ChunkData | undefined>('chunks', 'readonly', (s) => s.get(`${worldId}:${dim}:${cx},${cz}`));
  },
  saveChunks(worldId: string, dim: string, chunks: ChunkData[]): Promise<void> {
    if (!chunks.length) return Promise.resolve();
    return tx('chunks', 'readwrite', (s) => { for (const c of chunks) s.put(c, `${worldId}:${dim}:${c.cx},${c.cz}`); });
  },
  loadState<T>(worldId: string, key: string): Promise<T | undefined> { return tx<T | undefined>('state', 'readonly', (s) => s.get(`${worldId}:${key}`)); },
  saveState(worldId: string, key: string, value: any): Promise<void> { return tx('state', 'readwrite', (s) => { s.put(value, `${worldId}:${key}`); }); },
  deleteState(worldId: string, key: string): Promise<void> { return tx('state', 'readwrite', (s) => { s.delete(`${worldId}:${key}`); }); },
  loadOptions<T>(): Promise<T | undefined> { return tx<T | undefined>('state', 'readonly', (s) => s.get('options')); },
  saveOptions(value: any): Promise<void> { return tx('state', 'readwrite', (s) => { s.put(value, 'options'); }); },
};
