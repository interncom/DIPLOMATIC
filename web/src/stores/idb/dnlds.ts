import { btoh, htob } from "../../shared/binary";
import { Hash } from "../../shared/types";
import { IDownloadMessage, IDownloadQueue } from "../../types";
import { type IDBPDatabase } from "idb";
import { DOWNLOAD_QUEUE_TABLE } from "./store";

export class IDBDownloadQueue implements IDownloadQueue {
  db: IDBPDatabase<any>;

  constructor(db: IDBPDatabase) {
    this.db = db;
  }
  async enq(msgs: Iterable<IDownloadMessage>) {
    for (const msg of msgs) {
      const hex = btoh(msg.hash);
      await this.db.put(DOWNLOAD_QUEUE_TABLE, msg, hex);
    }
  }

  async deq(hshs: Iterable<Hash>) {
    for (const hash of hshs) {
      const hex = btoh(hash);
      await this.db.delete(DOWNLOAD_QUEUE_TABLE, hex);
    }
  }

  async list() {
    return await this.db.getAll(DOWNLOAD_QUEUE_TABLE);
  }

  async count() {
    return await this.db.count(DOWNLOAD_QUEUE_TABLE);
  }

  async wipe() {
    return this.db.clear(DOWNLOAD_QUEUE_TABLE);
  }
}
