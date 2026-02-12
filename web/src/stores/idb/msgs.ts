import { btoh, bytesEqual, htob } from "../../shared/binary";
import { ICrypto } from "../../shared/types";
import { EntityID, Hash } from "../../shared/types";
import { IMessageStore, IStoredMessage, IStoredMessageData, toStoredMessage } from "../../types";
import { MESSAGES_TABLE } from "./store";

export class IDBMessageStore implements IMessageStore {
  db: IDBDatabase;

  constructor(db: IDBDatabase, private crypto: ICrypto) {
    this.db = db;
  }

  async add(key: Hash, data: IStoredMessageData) {
    const tx = this.db.transaction(MESSAGES_TABLE, "readwrite");
    const store = tx.objectStore(MESSAGES_TABLE);
    return new Promise<void>((resolve, reject) => {
      const hex = btoh(key);
      const req = store.put(data, hex);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  async del(keys: Iterable<Hash>) {
    const hashes = [...keys];
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

  async get(key: Hash): Promise<IStoredMessage | undefined> {
    const tx = this.db.transaction(MESSAGES_TABLE, "readonly");
    const store = tx.objectStore(MESSAGES_TABLE);
    return new Promise<IStoredMessage | undefined>((resolve, reject) => {
      const hex = btoh(key);
      const req = store.get(hex);
      req.onsuccess = async () => {
        const data = req.result;
        if (data) {
          resolve(await toStoredMessage(key, data, this.crypto));
        } else {
          resolve(undefined);
        }
      };
      req.onerror = () => reject(req.error);
    });
  }

  async has(key: Hash) {
    const result = await this.get(key);
    return result !== undefined;
  }

  async list(): Promise<Iterable<IStoredMessage>> {
    const tx = this.db.transaction(MESSAGES_TABLE, "readonly");
    const store = tx.objectStore(MESSAGES_TABLE);
    return new Promise<Iterable<IStoredMessage>>((resolve, reject) => {
      const msgs: IStoredMessage[] = [];
      const req = store.openCursor();
      req.onsuccess = async (event) => {
        const cursor = (event.target as IDBRequest).result;
        if (cursor) {
          const key = cursor.key as string;
          const data = cursor.value as IStoredMessageData;
          const hash = htob(key) as Hash;
          const msg = await toStoredMessage(hash, data, this.crypto);
          msgs.push(msg);
          cursor.continue();
        } else {
          resolve(msgs);
        }
      };
      req.onerror = () => reject(req.error);
    });
  }

  // last returns the stored message with given eid, clk and highest ctr/off.
  async last(eid: EntityID): Promise<IStoredMessage | undefined> {
    const tx = this.db.transaction(MESSAGES_TABLE, "readonly");
    const store = tx.objectStore(MESSAGES_TABLE);
    return new Promise<IStoredMessage | undefined>((resolve, reject) => {
      let latest: { key: string; data: IStoredMessageData } | undefined;
      const req = store.openCursor();
      req.onsuccess = async (event) => {
        const cursor = (event.target as IDBRequest).result;
        if (cursor) {
          const key = cursor.key as string;
          const data = cursor.value as IStoredMessageData;
          if (bytesEqual(eid, data.eid)) {
            if (
              !latest || (data.ctr ?? 0) > (latest.data.ctr ?? 0) ||
              ((data.ctr ?? 0) === (latest.data.ctr ?? 0) && (data.off ?? 0) > (latest.data.off ?? 0))
            ) {
              latest = { key, data };
            }
          }
          cursor.continue();
        } else {
          if (latest) {
            const hash = htob(latest.key) as Hash;
            resolve(await toStoredMessage(hash, latest.data, this.crypto));
          } else {
            resolve(undefined);
          }
        }
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
