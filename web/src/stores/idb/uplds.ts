import { btoh, htob } from "../../shared/binary";
import { Hash } from "../../shared/types";
import { IUploadEntry, IUploadQueue } from "../../types";
import { UPLOAD_QUEUE_TABLE } from "./store";

export class IDBUploadQueue implements IUploadQueue {
  db: IDBDatabase;

  constructor(db: IDBDatabase) {
    this.db = db;
  }

  async enq(host: string, entries: Iterable<IUploadEntry>) {
    const list = [...entries];
    if (list.length === 0) return;
    const tx = this.db.transaction(UPLOAD_QUEUE_TABLE, "readwrite");
    const store = tx.objectStore(UPLOAD_QUEUE_TABLE);
    return new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      for (const e of list) {
        const hex = btoh(e.hash);
        store.put({ host, hash: hex, bodyLen: e.bodyLen });
      }
    });
  }

  async deq(host: string, hshs: Iterable<Hash>) {
    const hashes = [...hshs];
    if (hashes.length === 0) return;
    const tx = this.db.transaction(UPLOAD_QUEUE_TABLE, "readwrite");
    const store = tx.objectStore(UPLOAD_QUEUE_TABLE);
    return new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      for (const hash of hashes) {
        const hex = btoh(hash);
        store.delete([host, hex]);
      }
    });
  }

  async list(host: string): Promise<IUploadEntry[]> {
    const tx = this.db.transaction(UPLOAD_QUEUE_TABLE, "readonly");
    const store = tx.objectStore(UPLOAD_QUEUE_TABLE);
    return new Promise<IUploadEntry[]>((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => {
        const items = req.result as {
          host: string;
          hash: string;
          bodyLen?: number;
        }[];
        const out: IUploadEntry[] = [];
        for (const item of items) {
          if (item.host !== host) continue;
          out.push({
            hash: htob(item.hash) as Hash,
            bodyLen: item.bodyLen ?? 0,
          });
        }
        resolve(out);
      };
      req.onerror = () => reject(req.error);
    });
  }

  async count() {
    const tx = this.db.transaction(UPLOAD_QUEUE_TABLE, "readonly");
    const store = tx.objectStore(UPLOAD_QUEUE_TABLE);
    return new Promise<number>((resolve, reject) => {
      const req = store.count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async wipe() {
    const tx = this.db.transaction(UPLOAD_QUEUE_TABLE, "readwrite");
    const store = tx.objectStore(UPLOAD_QUEUE_TABLE);
    return new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      store.clear();
    });
  }
}
