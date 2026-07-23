import { b64tob, btob64, bytesEqual } from "../../shared/binary";
import { ICrypto } from "../../shared/types";
import { EntityID, Hash } from "../../shared/types";
import {
  IMessageStore,
  isPendingApply,
  IStorableMessage,
  IStoredMessage,
  IStoredMessageData,
  normalizeStoredMessageData,
  toStoredMessage,
} from "../../types";
import { Status } from "../../shared/consts";

export class MemoryMessageStore implements IMessageStore {
  messages = new Map<string, IStoredMessageData>();

  constructor(private crypto: ICrypto) {}

  async add(messages: IStorableMessage[]): Promise<Status[]> {
    const results: Status[] = [];
    for (const { key, data } of messages) {
      this.messages.set(btob64(key), data);
      results.push(Status.Success);
    }
    return results;
  }

  async del(keys: Iterable<Hash>) {
    for (const key of keys) {
      this.messages.delete(btob64(key));
    }
  }

  async get(key: Hash): Promise<IStoredMessage | undefined> {
    const data = this.messages.get(btob64(key));
    if (data) {
      return await toStoredMessage(key, data, this.crypto);
    }
    return undefined;
  }

  async has(key: Hash) {
    return this.messages.has(btob64(key));
  }

  async list(): Promise<Iterable<IStoredMessage>> {
    const entries = Array.from(this.messages.entries());
    const msgs = await Promise.all(entries.map(([keyStr, data]) => {
      const hash = b64tob(keyStr) as Hash;
      return toStoredMessage(hash, data, this.crypto);
    }));
    return msgs;
  }

  // last returns the stored message with given eid and highest ctr/off.
  async last(eid: EntityID): Promise<IStoredMessage | undefined> {
    let latest: { hash: Hash; data: IStoredMessageData } | undefined;
    for (const [keyStr, data] of this.messages) {
      if (bytesEqual(eid, data.eid) === false) {
        continue;
      }
      const hash = b64tob(keyStr) as Hash;
      if (latest === undefined) {
        latest = { hash, data };
      } else if (
        (data.ctr ?? 0) > (latest.data.ctr ?? 0) ||
        ((data.ctr ?? 0) === (latest.data.ctr ?? 0) &&
          (data.off ?? 0) > (latest.data.off ?? 0))
      ) {
        latest = { hash, data };
      }
    }
    if (latest) {
      return await toStoredMessage(latest.hash, latest.data, this.crypto);
    }
    return undefined;
  }

  async listUnapplied(): Promise<IStoredMessage[]> {
    const out: IStoredMessage[] = [];
    for (const [keyStr, data] of this.messages) {
      if (!isPendingApply(data)) continue;
      const hash = b64tob(keyStr) as Hash;
      out.push(await toStoredMessage(hash, data, this.crypto));
    }
    return out;
  }

  async markApplied(keys: Iterable<Hash>): Promise<void> {
    for (const key of keys) {
      const keyStr = btob64(key);
      const data = this.messages.get(keyStr);
      if (!data) continue;
      this.messages.set(keyStr, {
        ...normalizeStoredMessageData(data),
        apld: true,
      });
    }
  }

  async wipe() {
    this.messages.clear();
  }
}
