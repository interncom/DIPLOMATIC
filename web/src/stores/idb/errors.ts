// Failed bags for one account. Keyed like a download: host, realm, and seq.

import type { IKDM } from "../../shared/codecs/kdm";
import { IErrorPut, IErrorRow, IErrorStore } from "../../types";
import { downloadKey } from "../cursor";
import { ERRORS_TABLE } from "./store";

function priorCount(v: unknown): number {
  if (v === null || typeof v !== "object") return 0;
  if (!("failureCount" in v)) return 0;
  const n = v.failureCount;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1) return 0;
  return n;
}

export class IDBErrorStore implements IErrorStore {
  constructor(private db: IDBDatabase) {}

  // put records failures. A repeat of the same bag bumps failureCount.
  async put(rows: Iterable<IErrorPut>) {
    const list = [...rows];
    if (list.length === 0) return;
    const tx = this.db.transaction(ERRORS_TABLE, "readwrite");
    const store = tx.objectStore(ERRORS_TABLE);
    return new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);

      // One bag at a time so a repeat in this batch sees the new count.
      let i = 0;
      const next = () => {
        if (i >= list.length) return;
        const row = list[i];
        i += 1;
        const key = downloadKey(row.host, row.seq, row.realm);
        const req = store.get(key);
        req.onsuccess = () => {
          const stored: IErrorRow = {
            ...row,
            lastFailedAt: Date.now(),
            failureCount: priorCount(req.result) + 1,
          };
          store.put(stored, key);
          next();
        };
      };
      next();
    });
  }

  async deq(host: string, seqs: Iterable<number>, realm?: IKDM) {
    const seqArray = [...seqs];
    if (seqArray.length === 0) return;
    const tx = this.db.transaction(ERRORS_TABLE, "readwrite");
    const store = tx.objectStore(ERRORS_TABLE);
    return new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      for (const seq of seqArray) {
        store.delete(downloadKey(host, seq, realm));
      }
    });
  }

  async list() {
    const tx = this.db.transaction(ERRORS_TABLE, "readonly");
    const store = tx.objectStore(ERRORS_TABLE);
    return new Promise<IErrorRow[]>((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async count() {
    const tx = this.db.transaction(ERRORS_TABLE, "readonly");
    const store = tx.objectStore(ERRORS_TABLE);
    return new Promise<number>((resolve, reject) => {
      const req = store.count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async wipe() {
    const tx = this.db.transaction(ERRORS_TABLE, "readwrite");
    const store = tx.objectStore(ERRORS_TABLE);
    return new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      store.clear();
    });
  }
}
