import libsodiumCrypto from "../../crypto";
import { Enclave } from "../../shared/enclave";
import { MasterSeed } from "../../shared/types";
import { ISeedStore } from "../../types";
import { type IDBPDatabase } from "idb";
import { btoh, htob } from "../../shared/binary";

export class IDBSeedStore implements ISeedStore {
  enclave?: Enclave;
  db: IDBPDatabase<any>;

  constructor(db: IDBPDatabase) {
    this.db = db;
  }

  async save(seed: MasterSeed) {
    const hex = btoh(seed);
    await this.db.put("seedMeta", hex, "seed");
    this.enclave = new Enclave(seed, libsodiumCrypto);
    return this.enclave;
  }

  async load() {
    if (this.enclave) {
      return this.enclave;
    }
    const hex = await this.db.get("seedMeta", "seed");
    if (!hex) {
      return;
    }
    const seed = htob(hex) as MasterSeed;
    this.enclave = new Enclave(seed, libsodiumCrypto);
    return this.enclave;
  }

  async wipe() {
    this.enclave = undefined;
    await this.db.delete("seedMeta", "seed");
  }
}
