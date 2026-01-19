import { btoh, htob } from "../../shared/binary";
import { Hash } from "../../shared/types";
import { IUploadQueue } from "../../types";
import { UPLOAD_QUEUE_TABLE } from "./store";

export class IDBUploadQueue implements IUploadQueue {
  db: IDBDatabase;

  constructor(db: IDBDatabase) {
    this.db = db;
  }

  async enq(hshs: Iterable<Hash>) {
    const hashes = [...hshs];
    if (hashes.length === 0) return;
    const tx = this.db.transaction(UPLOAD_QUEUE_TABLE, "readwrite");
    const store = tx.objectStore(UPLOAD_QUEUE_TABLE);
    return new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      for (const hash of hashes) {
        const hex = btoh(hash);
        store.put(null, hex);
      }
    });
  }

  async deq(hshs: Iterable<Hash>) {
    const hashes = [...hshs];
    if (hashes.length === 0) return;
    const tx = this.db.transaction(UPLOAD_QUEUE_TABLE, "readwrite");
    const store = tx.objectStore(UPLOAD_QUEUE_TABLE);
    return new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      for (const hash of hashes) {
        const hex = btoh(hash);
        store.delete(hex);
      }
    });
  }

  async list() {
    const tx = this.db.transaction(UPLOAD_QUEUE_TABLE, "readonly");
    const store = tx.objectStore(UPLOAD_QUEUE_TABLE);
    return new Promise<Hash[]>((resolve, reject) => {
      const req = store.getAllKeys();
      req.onsuccess = () => {
        const hexes = req.result as string[];
        resolve(hexes.map((hex) => htob(hex)) as Hash[]);
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
