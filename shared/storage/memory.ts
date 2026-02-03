import { btoh, htob } from "../binary.ts";
import { Encoder } from "../codec.ts";
import type { IBagPeekItem } from "../codecs/peekItem.ts";
import { peekItemHeadCodec } from "../codecs/peekItemHead.ts";
import { type IStorage, nullSubMeta } from "../types.ts";
import { ok } from "../valstat.ts";

interface IMemoryStorage extends IStorage {
  users: Set<string>;
  bag: Map<
    string,
    {
      headCph: Uint8Array;
      bodyCph: Uint8Array;
      recordedAt: Date;
      pubKeyHex: string;
    }
  >;
}
const memStorage: IMemoryStorage = {
  users: new Set<string>(), // Set of user pubkeys in hex.
  bag: new Map(), // Sha256Hex => bag parts.

  async addUser(pubKey) {
    const pubKeyHex = btoh(pubKey);
    this.users.add(pubKeyHex);
    return ok(undefined);
  },

  async hasUser(pubKey) {
    const pubKeyHex = btoh(pubKey);
    return ok(this.users.has(pubKeyHex));
  },

  async subMeta(pubKey) {
    // TODO: actually compute this.
    const meta = nullSubMeta;
    return ok(meta);
  },

  async setBag(pubKey, recordedAt, bag, sha256) {
    const pubKeyHex = btoh(pubKey);
    const storageKey = btoh(sha256);
    const enc = new Encoder();
    enc.writeStruct(peekItemHeadCodec, bag);
    const headCph = enc.result();
    const bodyCph = bag.bodyCph;
    this.bag.set(storageKey, {
      pubKeyHex,
      headCph,
      bodyCph,
      recordedAt,
    });
    return ok(undefined);
  },

  async getBody(pubKey, sha256) {
    const pubKeyHex = btoh(pubKey);
    const sha256Hex = btoh(sha256);
    const item = this.bag.get(sha256Hex);
    if (item?.pubKeyHex !== pubKeyHex) {
      return ok(undefined);
    }
    return ok(item.bodyCph);
  },

  async listHeads(pubKey, begin, end) {
    const pubKeyHex = btoh(pubKey);
    const list: IBagPeekItem[] = [];
    for (const [key, item] of this.bag.entries()) {
      const ts = item.recordedAt.toISOString();
      if (item.pubKeyHex === pubKeyHex && ts >= begin && ts <= end) {
        const sha256 = htob(key);
        list.push({
          hash: sha256,
          recordedAt: item.recordedAt,
          headCph: item.headCph,
        });
      }
    }
    return ok(list);
  },
};

export default memStorage;
