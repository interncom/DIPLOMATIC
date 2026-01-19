import libsodiumCrypto from "../../crypto";
import { Enclave } from "../../shared/enclave";
import { MasterSeed } from "../../shared/types";
import { ISeedStore } from "../../types";
import { btoh, htob } from "../../shared/binary";
import { SEED_META_TABLE } from "./store";

export class IDBSeedStore implements ISeedStore {
  enclave?: Enclave;
  db: IDBDatabase;

  constructor(db: IDBDatabase) {
    this.db = db;
  }

  async save(seed: MasterSeed) {
    const hex = btoh(seed);
    const tx = this.db.transaction(SEED_META_TABLE, "readwrite");
    const store = tx.objectStore(SEED_META_TABLE);
    return new Promise<Enclave>((resolve, reject) => {
      tx.oncomplete = () => {
        this.enclave = new Enclave(seed, libsodiumCrypto);
        resolve(this.enclave);
      };
      tx.onerror = () => reject(tx.error);
      store.put(hex, "seed");
    });
  }

  async load() {
    if (this.enclave) {
      return this.enclave;
    }
    const tx = this.db.transaction(SEED_META_TABLE, "readonly");
    const store = tx.objectStore(SEED_META_TABLE);
    return new Promise<Enclave | undefined>((resolve, reject) => {
      const req = store.get("seed");
      req.onsuccess = () => {
        const hex = req.result;
        if (!hex) {
          resolve(undefined);
        } else {
          const seed = htob(hex) as MasterSeed;
          this.enclave = new Enclave(seed, libsodiumCrypto);
          resolve(this.enclave);
        }
      };
      req.onerror = () => reject(req.error);
    });
  }

  async wipe() {
    this.enclave = undefined;
    const tx = this.db.transaction(SEED_META_TABLE, "readwrite");
    const store = tx.objectStore(SEED_META_TABLE);
    return new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      store.delete("seed");
    });
  }
}
