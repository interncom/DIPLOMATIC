import { btoh } from "../binary.ts";
import { Encoder } from "../codec.ts";
import type { IBagPeekItem } from "../codecs/peekItem.ts";
import { peekItemHeadCodec } from "../codecs/peekItemHead.ts";
import { Status } from "../consts.ts";
import { type IStorage, nullSubMeta } from "../types.ts";
import { err, ok } from "../valstat.ts";

interface IMemoryStorage extends IStorage {
  users: Set<string>;
  bag: Map<
    string,
    Map<number, {
      headCph: Uint8Array;
      bodyCph: Uint8Array;
    }>
  >;
}
const memStorage: IMemoryStorage = {
  users: new Set<string>(), // Set of user pubkeys in hex.
  bag: new Map(), // pubKeyHex => seq => bag parts.

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

  async setBag(pubKey, bag) {
    // Get user's bags.
    const pubKeyHex = btoh(pubKey);
    let userBags = this.bag.get(pubKeyHex);
    if (!userBags) {
      userBags = new Map();
      this.bag.set(pubKeyHex, userBags);
    }

    // Compute seq for bag.
    let maxSeq = 0;
    for (const seq of userBags.keys()) {
      if (seq > maxSeq) {
        maxSeq = seq;
      }
    }
    const seq = maxSeq + 1;

    // Encode bag.
    const enc = new Encoder();
    const status = enc.writeStruct(peekItemHeadCodec, bag);
    if (status !== Status.Success) {
      return err(status);
    }
    const headCph = enc.result();
    const bodyCph = bag.bodyCph;

    // Store bag.
    userBags.set(seq, {
      headCph,
      bodyCph,
    });
    return ok(seq);
  },

  async getBody(pubKey, seq) {
    const pubKeyHex = btoh(pubKey);
    const userBags = this.bag.get(pubKeyHex);
    if (!userBags) {
      return ok(undefined);
    }
    const item = userBags.get(seq);
    return ok(item?.bodyCph);
  },

  async listHeads(pubKey, minSeq) {
    const pubKeyHex = btoh(pubKey);
    const list: IBagPeekItem[] = [];
    const userBags = this.bag.get(pubKeyHex);
    if (userBags) {
      for (const [seq, item] of userBags.entries()) {
        if (seq > minSeq) {
          list.push({
            seq,
            headCph: item.headCph,
          });
        }
      }
    }
    list.sort((a, b) => a.seq - b.seq);
    return ok(list);
  },
};

export default memStorage;
