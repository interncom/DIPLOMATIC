// IndexedDB helpers for opening and deleting a database.

// Deletes a database. A missing name resolves.
export function deleteDatabase(name: string): Promise<void> {
  if (name === "" || typeof indexedDB === "undefined") {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onerror = () =>
      reject(
        req.error ?? new Error(`[DIPLOMATIC] deleteDatabase failed (${name})`),
      );
    req.onblocked = () => {
      console.warn(`[DIPLOMATIC] deleteDatabase blocked (${name})`);
    };
  });
}

// Opens a database at `version`, running `upgrade` when the schema is older.
export function openAt(
  name: string,
  version: number,
  upgrade: (db: IDBDatabase, tx: IDBTransaction) => void,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, version);
    req.onupgradeneeded = () => {
      const db = req.result;
      const tx = req.transaction;
      if (tx === null) {
        reject(new Error(`[DIPLOMATIC] missing upgrade transaction (${name})`));
        return;
      }
      try {
        upgrade(db, tx);
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    };
    req.onblocked = () => {
      console.warn(
        `[DIPLOMATIC] IDB upgrade blocked (${name} → v${version})`,
      );
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        db.close();
      };
      resolve(db);
    };
    req.onerror = () => {
      reject(req.error ?? new Error(`[DIPLOMATIC] IDB open failed (${name})`));
    };
  });
}
