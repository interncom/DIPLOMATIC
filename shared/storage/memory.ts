import { btoh } from "../binary.ts";
import { Encoder } from "../codec.ts";
import type { IBagPeekItem } from "../codecs/peekItem.ts";
import { peekItemHeadCodec } from "../codecs/peekItemHead.ts";
import { hashBytes, Status } from "../consts.ts";
import { type ISetBagResult, type IStorage, nullSubMeta } from "../types.ts";
import { err, ok } from "../valstat.ts";

interface IMemoryStorage extends IStorage {
  users: Set<string>;
  bag: Map<
    string,
    Map<
      string,
      Map<number, {
        headCph: Uint8Array;
        bodyCph: Uint8Array;
      }>
    >
  >;
}

/** Fresh in-memory host storage (isolated bag/user maps). */
export function createMemoryStorage(): IMemoryStorage {
  const storage: IMemoryStorage = {
    users: new Set<string>(),
    bag: new Map(),

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
      // per-rlm seq assignment + inserts (in-process mutex).
      const pubKeyHex = btoh(pubKey);
      let userBags = this.bag.get(pubKeyHex);
      if (!userBags) {
        userBags = new Map();
        this.bag.set(pubKeyHex, userBags);
      }

      const out: ISetBagResult[] = [];
      const maxBy = new Map<string, number>();
      for (const bag of bags) {
        if (bag.rlm.byteLength !== hashBytes) {
          out.push({ status: Status.InvalidParam });
          continue;
        }
        const rlmHex = btoh(bag.rlm);
        let realm = userBags.get(rlmHex);
        if (!realm) {
          realm = new Map();
          userBags.set(rlmHex, realm);
        }
        let max = maxBy.get(rlmHex);
        if (max === undefined) {
          max = 0;
          for (const seq of realm.keys()) {
            if (seq > max) max = seq;
          }
        }
        max += 1;
        maxBy.set(rlmHex, max);
        const enc = new Encoder();
        const status = enc.writeStruct(peekItemHeadCodec, bag);
        if (status !== Status.Success) return err(status);
        realm.set(max, {
          headCph: enc.result(),
          bodyCph: bag.bodyCph,
        });
        out.push({ status: Status.Success, seq: max });
      }
      return ok(out);
    },

    async getBodies(pubKey, rlm, seqs) {
      if (rlm.byteLength !== hashBytes) return err(Status.InvalidParam);
      if (seqs.length < 1) return ok([]);
      const realm = this.bag.get(btoh(pubKey))?.get(btoh(rlm));
      if (!realm) return ok([]);
      const out: { seq: number; bodyCph: Uint8Array }[] = [];
      for (const seq of seqs) {
        const item = realm.get(seq);
        if (item?.bodyCph) out.push({ seq, bodyCph: item.bodyCph });
      }
      return ok(out);
    },

    async listHeads(pubKey, rlm, minSeq) {
      if (rlm.byteLength !== hashBytes) return err(Status.InvalidParam);
      const list: IBagPeekItem[] = [];
      const realm = this.bag.get(btoh(pubKey))?.get(btoh(rlm));
      if (realm) {
        for (const [seq, item] of realm.entries()) {
          if (seq > minSeq) {
            list.push({ seq, headCph: item.headCph });
          }
        }
      }
      list.sort((a, b) => a.seq - b.seq);
      return ok(list);
    },
  };
  return storage;
}

/** Shared singleton (legacy tests). Prefer createMemoryStorage() for isolation. */
const memStorage = createMemoryStorage();
export default memStorage;
