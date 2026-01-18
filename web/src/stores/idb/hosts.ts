import { IHostConnectionInfo } from "../../shared/types";
import type { IHostRow, IHostStore } from "../../types";
import { HOSTS_TABLE } from "./store";

function idbRowToHostRow(row: any): IHostRow<URL> {
  const host: IHostRow<URL> = {
    label: row.label,
    handle: new URL(row.handle),
    idx: row.idx,
    lastSyncedAt: row.lastSyncedAt,
  };
  return host;
}

export class IDBHostStore implements IHostStore<URL> {
  db: IDBDatabase;

  constructor(db: IDBDatabase) {
    this.db = db;
  }

  async add(info: IHostConnectionInfo<URL>) {
    const host = {
      ...info,
      handle: info.handle.toString(),
      lastSyncedAt: new Date(0),
    };
    const tx = this.db.transaction(HOSTS_TABLE, 'readwrite');
    const store = tx.objectStore(HOSTS_TABLE);
    return new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      store.put(host);
    });
  }

  async touch(label: string, now: Date) {
    const tx = this.db.transaction(HOSTS_TABLE, 'readwrite');
    const store = tx.objectStore(HOSTS_TABLE);
    return new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      const getReq = store.get(label);
      getReq.onsuccess = () => {
        const row = getReq.result;
        if (row) {
          const next = {
            ...row,
            lastSyncedAt: now,
          };
          store.put(next);
        }
      };
    });
  }

  async get(label: string) {
    const tx = this.db.transaction(HOSTS_TABLE, 'readonly');
    const store = tx.objectStore(HOSTS_TABLE);
    return new Promise<IHostRow<URL> | undefined>((resolve, reject) => {
      const req = store.get(label);
      req.onsuccess = () => {
        const row = req.result;
        if (!row) {
          resolve(undefined);
        } else {
          resolve(idbRowToHostRow(row));
        }
      };
      req.onerror = () => reject(req.error);
    });
  }

  async del(label: string) {
    const tx = this.db.transaction(HOSTS_TABLE, 'readwrite');
    const store = tx.objectStore(HOSTS_TABLE);
    return new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      store.delete(label);
    });
  }

  async list() {
    const tx = this.db.transaction(HOSTS_TABLE, 'readonly');
    const store = tx.objectStore(HOSTS_TABLE);
    return new Promise<IHostRow<URL>[]>((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => {
        const rows = req.result;
        resolve(rows.map(idbRowToHostRow));
      };
      req.onerror = () => reject(req.error);
    });
  }

  async wipe() {
    const tx = this.db.transaction(HOSTS_TABLE, 'readwrite');
    const store = tx.objectStore(HOSTS_TABLE);
    return new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      store.clear();
    });
  }
}
