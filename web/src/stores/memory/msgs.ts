import { btoh, uint8ArraysEqual } from "../../shared/binary";
import { EntityID, Hash } from "../../shared/types";
import { IMessageStore, IStoredMessage } from "../../types";

export class MemoryMessageStore implements IMessageStore {
  messages = new Map<string, IStoredMessage>();

  async add(msgs: Iterable<IStoredMessage>) {
    for (const msg of msgs) {
      this.messages.set(btoh(msg.hash), msg);
    }
  }

  async del(hshs: Iterable<Hash>) {
    for (const hash of hshs) {
      this.messages.delete(btoh(hash));
    }
  }

  async get(hash: Hash) {
    return this.messages.get(btoh(hash));
  }

  async has(hash: Hash) {
    return this.messages.has(btoh(hash));
  }

  async list() {
    return this.messages.values();
  }

  // last returns the stored message with given eid and highest ctr.
  async last(eid: EntityID) {
    let latest: IStoredMessage | undefined;
    for (const [, msg] of this.messages) {
      if (uint8ArraysEqual(eid, msg.head.eid) === false) {
        continue;
      }
      if (latest === undefined) {
        latest = msg;
      }
      if (msg.head.ctr > latest.head.ctr) {
        latest = msg;
      }
    }
    return latest;
  }

  async wipe() {
    this.messages.clear();
  }
}
