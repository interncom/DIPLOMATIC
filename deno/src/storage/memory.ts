import { htob, btoh, concat } from "../../../shared/lib.ts";
import type { IEnvelope, IStorage, PublicKey } from "../../../shared/types.ts";
import libsodiumCrypto from "../crypto.ts";
import type { IEnvelopePeekItem } from "../../../shared/codecs/peekItem.ts";

interface IMemoryStorage extends IStorage {
  users: Set<string>;
  envelopes: Map<
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
  envelopes: new Map(), // Sha256Hex => envelope parts.

  async addUser(pubKey) {
    const pubKeyHex = btoh(pubKey);
    this.users.add(pubKeyHex);
  },

  async hasUser(pubKey) {
    const pubKeyHex = btoh(pubKey);
    return this.users.has(pubKeyHex);
  },

  async setEnvelope(pubKey, recordedAt, env, sha256) {
    const pubKeyHex = btoh(pubKey);
    const storageKey = btoh(sha256);
    const headCph = concat(concat(env.sig, env.kdm), env.headCph);
    const bodyCph = env.bodyCph;
    this.envelopes.set(storageKey, {
      pubKeyHex,
      headCph,
      bodyCph,
      recordedAt,
    });
  },

  async getBody(pubKey, sha256) {
    const pubKeyHex = btoh(pubKey);
    const sha256Hex = btoh(sha256);
    const item = this.envelopes.get(sha256Hex);
    if (item?.pubKeyHex !== pubKeyHex) {
      return;
    }
    return item.bodyCph;
  },

  async listHeads(pubKey, begin, end) {
    const pubKeyHex = btoh(pubKey);
    const list: IEnvelopePeekItem[] = [];
    for (const [key, item] of this.envelopes.entries()) {
      const ts = item.recordedAt.toISOString();
      if (item.pubKeyHex === pubKeyHex && ts >= begin && ts < end) {
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
