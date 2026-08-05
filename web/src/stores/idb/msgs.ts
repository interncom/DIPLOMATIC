import { b64tob, btob64, bytesEqual } from "../../shared/binary";
import { Status } from "../../shared/consts";
import { ICrypto } from "../../shared/types";
import { EntityID, Hash } from "../../shared/types";
import {
  APLD_APPLIED,
  APLD_ERROR,
  ApldState,
  IMessageStore,
  IStorableMessage,
  IStoredMessage,
  IStoredMessageData,
  setApld,
  toStoredMessage,
} from "../../types";
import { MESSAGES_APLD_INDEX, MESSAGES_TABLE } from "./store";

export class IDBMessageStore implements IMessageStore {
  db: IDBDatabase;

  constructor(db: IDBDatabase, private crypto: ICrypto) {
    this.db = db;
  }

  async add(messages: IStorableMessage[]): Promise<Status[]> {
    const tx = this.db.transaction(MESSAGES_TABLE, "readwrite");
    const store = tx.objectStore(MESSAGES_TABLE);
    return new Promise<Status[]>((resolve) => {
      if (messages.length === 0) {
        resolve([]);
        return;
      }
      const results: Status[] = new Array(messages.length).fill(Status.Success);
      tx.oncomplete = () => resolve(results);
      tx.onerror = () => {
        // TODO: set the function return type to ValStat<Status[]> and return an overall failure here with status list undefined.
        for (let i = 0; i < results.length; i++) {
          results[i] = Status.DatabaseError;
        }
        resolve(results);
      };
      for (let i = 0; i < messages.length; i++) {
        const { key, data } = messages[i];
        const keyB64 = btob64(key);
        // Put caller data as-is (omit optional fields at write time).
        const req = store.put(data, keyB64);
        // We skip req.onsuccess because we default results to Success.
        req.onerror = (evt) => {
          // preventDefault allows continuation if a single insert fails.
          evt.preventDefault();
          results[i] = Status.DatabaseError;
        };
      }
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
        const b64 = btob64(hash);
        store.delete(b64);
      }
    });
  }

  async get(key: Hash): Promise<IStoredMessage | undefined> {
    const tx = this.db.transaction(MESSAGES_TABLE, "readonly");
    const store = tx.objectStore(MESSAGES_TABLE);
    return new Promise<IStoredMessage | undefined>((resolve, reject) => {
      const b64 = btob64(key);
      const req = store.get(b64);
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

  async list(apld?: ApldState): Promise<IStoredMessage[]> {
    const tx = this.db.transaction(MESSAGES_TABLE, "readonly");
    const store = tx.objectStore(MESSAGES_TABLE);
    return new Promise<IStoredMessage[]>((resolve, reject) => {
      const pending: { hash: Hash; data: IStoredMessageData }[] = [];
      const req = apld === undefined
        ? store.openCursor()
        : store.index(MESSAGES_APLD_INDEX).openCursor(IDBKeyRange.only(apld));
      req.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest).result;
        if (cursor) {
          // Out-of-line primary key is the b64 hash.
          const key =
            (apld === undefined ? cursor.key : cursor.primaryKey) as string;
          const data = cursor.value as IStoredMessageData;
          pending.push({ hash: b64tob(key) as Hash, data });
          cursor.continue();
        } else {
          Promise.all(
            pending.map(({ hash, data }) =>
              toStoredMessage(hash, data, this.crypto)
            ),
          ).then(resolve).catch(reject);
        }
      };
      req.onerror = () => reject(req.error);
    });
  }

  async listKeys(): Promise<Hash[]> {
    const tx = this.db.transaction(MESSAGES_TABLE, "readonly");
    const store = tx.objectStore(MESSAGES_TABLE);
    return new Promise<Hash[]>((resolve, reject) => {
      const keys: Hash[] = [];
      // Keys only — no body decode.
      const req = store.openKeyCursor();
      req.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest).result;
        if (cursor) {
          keys.push(b64tob(cursor.key as string) as Hash);
          cursor.continue();
        } else {
          resolve(keys);
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
          // TODO: convert eid to b64 and use an indexed lookup.
          if (bytesEqual(eid, data.eid)) {
            if (
              !latest || (data.ctr ?? 0) > (latest.data.ctr ?? 0) ||
              ((data.ctr ?? 0) === (latest.data.ctr ?? 0) &&
                (data.off ?? 0) > (latest.data.off ?? 0))
            ) {
              latest = { key, data };
            }
          }
          cursor.continue();
        } else {
          if (latest) {
            const hash = b64tob(latest.key) as Hash;
            resolve(await toStoredMessage(hash, latest.data, this.crypto));
          } else {
            resolve(undefined);
          }
        }
      };
      req.onerror = () => reject(req.error);
    });
  }

  async markApplied(keys: Iterable<Hash>): Promise<void> {
    const hashes = [...keys];
    if (hashes.length === 0) return;
    const tx = this.db.transaction(MESSAGES_TABLE, "readwrite");
    const store = tx.objectStore(MESSAGES_TABLE);
    return new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      for (const hash of hashes) {
        const b64 = btob64(hash);
        const getReq = store.get(b64);
        getReq.onsuccess = () => {
          const data = getReq.result as IStoredMessageData | undefined;
          if (!data) return;
          setApld(data, APLD_APPLIED);
          store.put(data, b64);
        };
        getReq.onerror = (evt) => {
          evt.preventDefault();
        };
      }
    });
  }

  async markFailed(
    entries: Iterable<{ key: Hash; err: Status }>,
  ): Promise<void> {
    const list = [...entries];
    if (list.length === 0) return;
    const tx = this.db.transaction(MESSAGES_TABLE, "readwrite");
    const store = tx.objectStore(MESSAGES_TABLE);
    return new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      for (const { key, err } of list) {
        const b64 = btob64(key);
        const getReq = store.get(b64);
        getReq.onsuccess = () => {
          const data = getReq.result as IStoredMessageData | undefined;
          if (!data) return;
          setApld(data, APLD_ERROR, err);
          store.put(data, b64);
        };
        getReq.onerror = (evt) => {
          evt.preventDefault();
        };
      }
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
