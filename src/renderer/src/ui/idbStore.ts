// A small key-value store in IndexedDB, for what must survive a reload (unsent messages and drafts, with their files).
// Best effort: where storage is blocked (a private window) reads come back empty and writes are dropped.

const DB_NAME = 'chattypop';
const STORE = 'kv';
const DB_VERSION = 1;

let db: Promise<IDBDatabase> | null = null;
/** Writes still on their way; a reload waits for them (whenWritten). */
const pending = new Set<Promise<void>>();

function open(): Promise<IDBDatabase> {
  db ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return db;
}

function run<T>(mode: IDBTransactionMode, act: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (d) =>
      new Promise<T>((resolve, reject) => {
        const tx = d.transaction(STORE, mode);
        const req = act(tx.objectStore(STORE));
        // Resolved once committed, so a reload after whenWritten() finds it.
        tx.oncomplete = () => resolve(req.result);
        tx.onerror = tx.onabort = () => reject(tx.error);
      }),
  );
}

export function idbGet<T>(key: string): Promise<T | undefined> {
  return run<T | undefined>('readonly', (s) => s.get(key) as IDBRequest<T | undefined>).catch(() => undefined);
}

/** Every key starting with `prefix`, with its value. */
export function idbEntries<T>(prefix: string): Promise<[string, T][]> {
  return open()
    .then(
      (d) =>
        new Promise<[string, T][]>((resolve, reject) => {
          const tx = d.transaction(STORE, 'readonly');
          const found: [string, T][] = [];
          const req = tx.objectStore(STORE).openCursor(IDBKeyRange.bound(prefix, `${prefix}￿`));
          req.onsuccess = () => {
            const c = req.result;
            if (!c) return;
            found.push([String(c.key), c.value as T]);
            c.continue();
          };
          tx.oncomplete = () => resolve(found);
          tx.onerror = tx.onabort = () => reject(tx.error);
        }),
    )
    .catch(() => []);
}

/** Stores `value` (structured-cloned: Files and byte arrays included); undefined deletes the key. */
export function idbSet(key: string, value: unknown): void {
  const stored: Promise<unknown> = value === undefined ? run('readwrite', (s) => s.delete(key)) : run('readwrite', (s) => s.put(value, key));
  const write = stored.then(
    () => undefined,
    (err: unknown) => console.warn(`Couldn't keep ${key}:`, err),
  );
  pending.add(write);
  void write.finally(() => pending.delete(write));
}

/** Settles once every write started so far has committed (or failed). */
export const whenWritten = (): Promise<void> => Promise.all([...pending]).then(() => undefined);
