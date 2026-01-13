import { btoh, htob } from "../../shared/binary";
import { Hash } from "../../shared/types";
import { IUploadQueue } from "../../types";
import { type IDBPDatabase } from "idb";

export class IDBUploadQueue implements IUploadQueue {
  db: IDBPDatabase<any>;

  constructor(db: IDBPDatabase) {
    this.db = db;
  }

  async enq(hshs: Iterable<Hash>) {
    for (const hash of hshs) {
      const hex = btoh(hash);
      await this.db.put("uploadQueue", null, hex);
    }
  }

  async deq(hshs: Iterable<Hash>) {
    for (const hash of hshs) {
      const hex = btoh(hash);
      await this.db.delete("uploadQueue", hex);
    }
  }

  async list() {
    const hexes = await this.db.getAllKeys("uploadQueue");
    return hexes.map((hex) => htob(hex as string)) as Hash[];
  }

  async count() {
    return await this.db.count("uploadQueue");
  }

  async wipe() {
    return this.db.clear("uploadQueue");
  }
}
