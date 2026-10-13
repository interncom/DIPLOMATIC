// IndexedDB realm counters for one account.

import { Status } from "../../shared/consts";
import {
  advanceRealm,
  decodeRealm,
  type IRealm,
  type IRealmStore,
} from "../realm";
import { REALMS_TABLE } from "./store";

/** Realm counters for the open account. The database is that account. */
export class IDBRealmStore implements IRealmStore {
  constructor(private db: IDBDatabase) {}

  async list(): Promise<IRealm[]> {
    const tx = this.db.transaction(REALMS_TABLE, "readonly");
    const store = tx.objectStore(REALMS_TABLE);
    return new Promise((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => {
        const raw = req.result;
        const out: IRealm[] = [];
        if (Array.isArray(raw)) {
          for (const item of raw) {
            const realm = decodeRealm(item);
            if (realm !== undefined) out.push(realm);
          }
        }
        resolve(out);
      };
      req.onerror = () => reject(req.error);
    });
  }

  async get(label: string): Promise<IRealm | undefined> {
    const tx = this.db.transaction(REALMS_TABLE, "readonly");
    const store = tx.objectStore(REALMS_TABLE);
    return new Promise((resolve, reject) => {
      const req = store.get(label);
      req.onsuccess = () => resolve(decodeRealm(req.result));
      req.onerror = () => reject(req.error);
    });
  }

  async put(label: string, index: number): Promise<Status> {
    const tx = this.db.transaction(REALMS_TABLE, "readwrite");
    const store = tx.objectStore(REALMS_TABLE);
    return new Promise((resolve, reject) => {
      let status = Status.Success;
      tx.oncomplete = () => resolve(status);
      tx.onerror = () => reject(tx.error);
      const req = store.get(label);
      req.onsuccess = () => {
        const [next, st] = advanceRealm(label, decodeRealm(req.result), index);
        if (st !== Status.Success) {
          status = st;
          return;
        }
        store.put(next);
      };
    });
  }

  async wipe() {
    const tx = this.db.transaction(REALMS_TABLE, "readwrite");
    const store = tx.objectStore(REALMS_TABLE);
    return new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      store.clear();
    });
  }
}
