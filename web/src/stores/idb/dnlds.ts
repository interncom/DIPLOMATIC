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
    const tx = this.db.transaction(DOWNLOAD_QUEUE_TABLE, "readwrite");
    const store = tx.objectStore(DOWNLOAD_QUEUE_TABLE);
    return new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      for (const msg of messages) {
        const key = `${msg.host}:${msg.seq}`;
        store.put(msg, key);
      }
    });
  }

  async deq(host: string, seqs: Iterable<number>) {
    const seqArray = [...seqs];
    if (seqArray.length === 0) return;
    const tx = this.db.transaction(DOWNLOAD_QUEUE_TABLE, "readwrite");
    const store = tx.objectStore(DOWNLOAD_QUEUE_TABLE);
    return new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      for (const seq of seqArray) {
        const key = `${host}:${seq}`;
        store.delete(key);
      }
    });
  }

  async list() {
    const tx = this.db.transaction(DOWNLOAD_QUEUE_TABLE, "readonly");
    const store = tx.objectStore(DOWNLOAD_QUEUE_TABLE);
    return new Promise<IDownloadMessage[]>((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async count() {
    const tx = this.db.transaction(DOWNLOAD_QUEUE_TABLE, "readonly");
    const store = tx.objectStore(DOWNLOAD_QUEUE_TABLE);
    return new Promise<number>((resolve, reject) => {
      const req = store.count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async wipe() {
    const tx = this.db.transaction(DOWNLOAD_QUEUE_TABLE, "readwrite");
    const store = tx.objectStore(DOWNLOAD_QUEUE_TABLE);
    return new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      store.clear();
    });
  }
}
