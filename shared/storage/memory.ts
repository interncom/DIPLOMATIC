import { btoh, concat, htob } from "../binary.ts";
import type { IStorage } from "../types.ts";
import type { IBagPeekItem } from "../codecs/peekItem.ts";
import { Encoder } from "../codec.ts";
import { peekItemHeadCodec } from "../codecs/peekItemHead.ts";

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
  },

  async hasUser(pubKey) {
    const pubKeyHex = btoh(pubKey);
    return this.users.has(pubKeyHex);
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
  },

  async getBody(pubKey, sha256) {
    const pubKeyHex = btoh(pubKey);
    const sha256Hex = btoh(sha256);
    const item = this.bag.get(sha256Hex);
    if (item?.pubKeyHex !== pubKeyHex) {
      return;
    }
    return item.bodyCph;
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
    return list;
  },
};

export default memStorage;
