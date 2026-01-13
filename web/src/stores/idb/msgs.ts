import { btoh, uint8ArraysEqual } from "../../shared/binary";
import { EntityID, Hash } from "../../shared/types";
import { IMessageStore, IStoredMessage } from "../../types";
import { type IDBPDatabase } from "idb";

export class IDBMessageStore implements IMessageStore {
  db: IDBPDatabase<any>;

  constructor(db: IDBPDatabase) {
    this.db = db;
  }

  async add(msgs: Iterable<IStoredMessage>) {
    for (const msg of msgs) {
      const hex = btoh(msg.hash);
      await this.db.put("messages", msg, hex);
    }
  }

  async del(hshs: Iterable<Hash>) {
    for (const hash of hshs) {
      const hex = btoh(hash);
      await this.db.delete("messages", hex);
    }
  }

  async get(hash: Hash) {
    const hex = btoh(hash);
    return await this.db.get("messages", hex);
  }

  async has(hash: Hash) {
    const hex = btoh(hash);
    const msg = await this.db.get("messages", hex);
    return msg !== undefined;
  }

  async list() {
    return await this.db.getAll("messages");
  }

  // last returns the stored message with given eid and highest ctr.
  async last(eid: EntityID) {
    let latest: IStoredMessage | undefined;
    const allMsgs = await this.db.getAll("messages");
    for (const msg of allMsgs) {
      if (uint8ArraysEqual(eid, msg.head.eid) === false) {
        continue;
      }
      if (!latest || msg.head.ctr > latest.head.ctr) {
        latest = msg;
      }
    }
    return latest;
  }
}
