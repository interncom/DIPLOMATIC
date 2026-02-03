import { btoh, htob } from "../binary.ts";
import { Encoder } from "../codec.ts";
import type { IBagPeekItem } from "../codecs/peekItem.ts";
import { peekItemHeadCodec } from "../codecs/peekItemHead.ts";
import { type IStorage, nullSubMeta } from "../types.ts";
import { ok } from "../valstat.ts";

interface IMemoryStorage extends IStorage {
  users: Set<string>;
  seqCounters: Map<string, number>;
  bag: Map<
    string,
    {
      headCph: Uint8Array;
      bodyCph: Uint8Array;
      recordedAt: Date;
      pubKeyHex: string;
      seq: number;
    }
  >;
}
const memStorage: IMemoryStorage = {
  users: new Set<string>(), // Set of user pubkeys in hex.
  seqCounters: new Map<string, number>(),
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
    const seq = (this.seqCounters.get(pubKeyHex) || 0) + 1;
    this.seqCounters.set(pubKeyHex, seq);
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
      seq,
    });
    return ok(seq);
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

  async listHeads(pubKey, minSeq) {
    const pubKeyHex = btoh(pubKey);
    const list: IBagPeekItem[] = [];
    for (const [key, item] of this.bag.entries()) {
      if (item.pubKeyHex === pubKeyHex && item.seq > minSeq) {
        const sha256 = htob(key);
        list.push({
          seq: item.seq,
          hash: sha256,
          headCph: item.headCph,
        });
      }
    }
    list.sort((a, b) => a.seq - b.seq);
    return ok(list);
  },
};

export default memStorage;
