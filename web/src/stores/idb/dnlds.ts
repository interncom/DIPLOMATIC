import { btoh, htob } from "../../shared/binary";
import { Hash } from "../../shared/types";
import { IDownloadMessage, IDownloadQueue } from "../../types";
import { DOWNLOAD_QUEUE_TABLE } from "./store";

export class IDBDownloadQueue implements IDownloadQueue {
  db: IDBDatabase;

  constructor(db: IDBDatabase) {
    this.db = db;
  }

  async enq(msgs: Iterable<IDownloadMessage>) {
    const messages = [...msgs];
    if (messages.length === 0) return;
    const tx = this.db.transaction(DOWNLOAD_QUEUE_TABLE, 'readwrite');
    const store = tx.objectStore(DOWNLOAD_QUEUE_TABLE);
    return new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      for (const msg of messages) {
        const hex = btoh(msg.hash);
        store.put(msg, hex);
      }
    });
  }

  async deq(hshs: Iterable<Hash>) {
    const hashes = [...hshs];
    if (hashes.length === 0) return;
    const tx = this.db.transaction(DOWNLOAD_QUEUE_TABLE, 'readwrite');
    const store = tx.objectStore(DOWNLOAD_QUEUE_TABLE);
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
    const tx = this.db.transaction(DOWNLOAD_QUEUE_TABLE, 'readonly');
    const store = tx.objectStore(DOWNLOAD_QUEUE_TABLE);
    return new Promise<IDownloadMessage[]>((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async count() {
    const tx = this.db.transaction(DOWNLOAD_QUEUE_TABLE, 'readonly');
    const store = tx.objectStore(DOWNLOAD_QUEUE_TABLE);
    return new Promise<number>((resolve, reject) => {
      const req = store.count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async wipe() {
    const tx = this.db.transaction(DOWNLOAD_QUEUE_TABLE, 'readwrite');
    const store = tx.objectStore(DOWNLOAD_QUEUE_TABLE);
    return new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      store.clear();
    });
  }
}
