import { btoh, htob } from "../../shared/binary";
import { Hash } from "../../shared/types";
import { IDownloadMessage, IDownloadQueue } from "../../types";
import { type IDBPDatabase } from "idb";

export class IDBDownloadQueue implements IDownloadQueue {
  db: IDBPDatabase<any>;

  constructor(db: IDBPDatabase) {
    this.db = db;
  }
  async enq(msgs: Iterable<IDownloadMessage>) {
    for (const msg of msgs) {
      const hex = btoh(msg.hash);
      await this.db.put("downloadQueue", msg, hex);
    }
  }

  async deq(hshs: Iterable<Hash>) {
    for (const hash of hshs) {
      const hex = btoh(hash);
      await this.db.delete("downloadQueue", hex);
    }
  }

  async list() {
    return await this.db.getAll("downloadQueue");
  }

  async count() {
    return await this.db.count("downloadQueue");
  }

  async wipe() {
    return this.db.clear("downloadQueue");
  }
}
