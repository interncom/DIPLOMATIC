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

  async subMeta(_pubKey) {
    // TODO: actually compute this.
    const meta = nullSubMeta;
    return ok(meta);
  },

  async setBags(pubKey, bags) {
    if (bags.length < 1) return ok([]);

    // No await in the critical section: one turn of the event loop owns
    // maxSeq assignment + inserts (in-process mutex).
    const pubKeyHex = btoh(pubKey);
    let userBags = this.bag.get(pubKeyHex);
    if (!userBags) {
      userBags = new Map();
      this.bag.set(pubKeyHex, userBags);
    }

    let maxSeq = 0;
    for (const seq of userBags.keys()) {
      if (seq > maxSeq) maxSeq = seq;
    }

    const seqs: number[] = [];
    for (const bag of bags) {
      maxSeq += 1;
      const enc = new Encoder();
      const status = enc.writeStruct(peekItemHeadCodec, bag);
      if (status !== Status.Success) {
        return err(status);
      }
      userBags.set(maxSeq, {
        headCph: enc.result(),
        bodyCph: bag.bodyCph,
      });
      seqs.push(maxSeq);
    }
    return ok(seqs);
  },

  async getBodies(pubKey, seqs) {
    if (seqs.length < 1) return ok([]);
    const pubKeyHex = btoh(pubKey);
    const userBags = this.bag.get(pubKeyHex);
    if (!userBags) return ok([]);
    const out: { seq: number; bodyCph: Uint8Array }[] = [];
    for (const seq of seqs) {
      const item = userBags.get(seq);
      if (item?.bodyCph) {
        out.push({ seq, bodyCph: item.bodyCph });
      }
    }
    return ok(out);
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
