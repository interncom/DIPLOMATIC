import { Status } from "../../shared/consts";
import { IHostConnectionInfo, IHostMetadata } from "../../shared/types";
import type { HostStatsUpdate, IHostRow, IHostStore } from "../../types";
import { HOSTS_TABLE } from "./store";

// deno-lint-ignore no-explicit-any
function idbRowToHostRow(row: any): IHostRow<URL> {
  const host: IHostRow<URL> = {
    label: row.label,
    handle: new URL(row.handle),
    idx: row.idx,
    lastSeq: row.lastSeq || 0,
    clockOffset: row.clockOffset,
    subscription: row.subscription,
  };
  return host;
}

function mergeStatsOntoRow(
  // deno-lint-ignore no-explicit-any
  row: any,
  u: HostStatsUpdate,
  // deno-lint-ignore no-explicit-any
): any {
  const next = { ...row };
  if (u.setLastSeq !== undefined) {
    next.lastSeq = u.setLastSeq;
  } else if (u.lastSeq !== undefined) {
    const prev = next.lastSeq || 0;
    if (u.lastSeq > prev) next.lastSeq = u.lastSeq;
  }
  // Drop legacy bag-tally fields if present (no longer used).
  delete next.numBags;
  delete next.numDupes;
  return next;
}

export class IDBHostStore implements IHostStore<URL> {
  db: IDBDatabase;

  constructor(db: IDBDatabase) {
    this.db = db;
  }

  /**
   * Upsert connection info. Same label + same handle/idx keeps lastSeq and
   * host meta (safe re-link). Changing handle/idx resets the peek cursor.
   */
  async add(info: IHostConnectionInfo<URL>) {
    const prev = await this.get(info.label);
    const same =
      prev !== undefined &&
      prev.handle.href === info.handle.href &&
      (prev.idx ?? 0) === (info.idx ?? 0);
    return this.put({
      ...info,
      lastSeq: same ? prev.lastSeq : 0,
      clockOffset: same ? prev.clockOffset : undefined,
      subscription: same ? prev.subscription : undefined,
    });
  }

  private async put(
    info: Omit<IHostRow<URL>, "lastSeq"> & { lastSeq?: number },
  ) {
    const host = {
      ...info,
      handle: info.handle.toString(),
      lastSeq: info.lastSeq ?? 0,
    };
    const tx = this.db.transaction(HOSTS_TABLE, "readwrite");
    const store = tx.objectStore(HOSTS_TABLE);
    return new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      store.put(host);
    });
  }

  // lastSeq only advances. Concurrent peek/push/notif must not regress the cursor.
  // Check and put run in one transaction so the compare is not stale vs other writers.
  async touch(label: string, seq: number) {
    return this.recordStats(label, { lastSeq: seq });
  }

  async recordStats(label: string, u: HostStatsUpdate) {
    const tx = this.db.transaction(HOSTS_TABLE, "readwrite");
    const store = tx.objectStore(HOSTS_TABLE);
    return new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      const getReq = store.get(label);
      getReq.onsuccess = () => {
        const row = getReq.result;
        if (!row) return;
        store.put(mergeStatsOntoRow(row, u));
      };
    });
  }

  async get(label: string) {
    const tx = this.db.transaction(HOSTS_TABLE, "readonly");
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

  async set(label: string, meta: IHostMetadata) {
    const row = await this.get(label);
    if (!row) {
      return Status.NotFound;
    }
    try {
      await this.put({ ...row, ...meta });
      return Status.Success;
    } catch {
      return Status.DatabaseError;
    }
  }

  async del(label: string) {
    const tx = this.db.transaction(HOSTS_TABLE, "readwrite");
    const store = tx.objectStore(HOSTS_TABLE);
    return new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      store.delete(label);
    });
  }

  async list() {
    const tx = this.db.transaction(HOSTS_TABLE, "readonly");
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
    const tx = this.db.transaction(HOSTS_TABLE, "readwrite");
    const store = tx.objectStore(HOSTS_TABLE);
    return new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      store.clear();
    });
  }
}
