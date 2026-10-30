// Minimal IndexedDB key/value store for analysis caches and projects (structured clone, so
// typed arrays are stored natively).

const DB_NAME = 'polish';
const STORE = 'kv';
let dbp: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const req = fn(db.transaction(STORE, mode).objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

export const kv = {
  get: <T>(key: string) => tx<T | undefined>('readonly', (s) => s.get(key)),
  set: (key: string, value: unknown) => tx('readwrite', (s) => s.put(value, key)).then(() => undefined),
  del: (key: string) => tx('readwrite', (s) => s.delete(key)).then(() => undefined),
};
