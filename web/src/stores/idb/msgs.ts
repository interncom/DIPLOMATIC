import { btoh, bytesEqual } from "../../shared/binary";
import { EntityID, Hash } from "../../shared/types";
import { IMessageStore, IStoredMessage } from "../../types";
import { MESSAGES_TABLE } from "./store";

export class IDBMessageStore implements IMessageStore {
  db: IDBDatabase;

  constructor(db: IDBDatabase) {
    this.db = db;
  }

  async add(msgs: Iterable<IStoredMessage>) {
    const messages = [...msgs];
    if (messages.length === 0) return;
    const tx = this.db.transaction(MESSAGES_TABLE, "readwrite");
    const store = tx.objectStore(MESSAGES_TABLE);
    return new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      for (const msg of messages) {
        const hex = btoh(msg.hash);
        store.put(msg, hex);
      }
    });
  }

  async del(hshs: Iterable<Hash>) {
    const hashes = [...hshs];
    if (hashes.length === 0) return;
    const tx = this.db.transaction(MESSAGES_TABLE, "readwrite");
    const store = tx.objectStore(MESSAGES_TABLE);
    return new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      for (const hash of hashes) {
        const hex = btoh(hash);
        store.delete(hex);
      }
    });
  }

  async get(hash: Hash) {
    const tx = this.db.transaction(MESSAGES_TABLE, "readonly");
    const store = tx.objectStore(MESSAGES_TABLE);
    return new Promise<IStoredMessage>((resolve, reject) => {
      const hex = btoh(hash);
      const req = store.get(hex);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async has(hash: Hash) {
    const result = await this.get(hash);
    return result !== undefined;
  }

  async list() {
    const tx = this.db.transaction(MESSAGES_TABLE, "readonly");
    const store = tx.objectStore(MESSAGES_TABLE);
    return new Promise<IStoredMessage[]>((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  // last returns the stored message with given eid, clk and highest ctr/off.
  async last(eid: EntityID, clk: Date) {
    const tx = this.db.transaction(MESSAGES_TABLE, "readonly");
    const store = tx.objectStore(MESSAGES_TABLE);
    return new Promise<IStoredMessage | undefined>((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => {
        const allMsgs = req.result;
        let latest: IStoredMessage | undefined;
        for (const msg of allMsgs) {
          if (bytesEqual(eid, msg.head.eid) === false || msg.head.clk.getTime() !== clk.getTime()) {
            continue;
          }
          if (!latest || msg.head.ctr > latest.head.ctr ||
              (msg.head.ctr === latest.head.ctr && msg.head.off > latest.head.off)) {
            latest = msg;
          }
        }
        resolve(latest);
      };
      req.onerror = () => reject(req.error);
    });
  }

  async wipe() {
    const tx = this.db.transaction(MESSAGES_TABLE, "readwrite");
    const store = tx.objectStore(MESSAGES_TABLE);
    return new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      store.clear();
    });
  }
}
