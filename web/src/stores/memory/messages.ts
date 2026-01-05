import { Hash } from "../../shared/types";
import { IMessageStore, IStoredMessage } from "../../types";

export class MemoryMessageStore implements IMessageStore {
  messages = new Map<Hash, IStoredMessage>();

  async init() { }

  async add(msgs: Iterable<IStoredMessage>) {
    for (const msg of msgs) {
      this.messages.set(msg.hash, msg);
    }
  }

  async del(hshs: Iterable<Hash>) {
    for (const hash of hshs) {
      this.messages.delete(hash);
    }
  }

  async has(hash: Hash) {
    return this.messages.has(hash);
  }

  async list() {
    return this.messages.values();
  }
}
