import { htob, btoh } from "../../../shared/lib.ts";
import type { IDeltaListItem, IStorage } from "../../../shared/types.ts";
import libsodiumCrypto from "../crypto.ts";

interface IMemoryStorage extends IStorage {
  users: Set<string>;
  envelopes: Map<
    string,
    {
      headCry: Uint8Array;
      bodyCry: Uint8Array;
      recordedAt: Date;
      pubKeyHex: string;
    }
  >;
}
const memStorage: IMemoryStorage = {
  users: new Set<string>(), // Set of user pubkeys in hex.
  envelopes: new Map(), // Sha256Hex => envelope parts.

  async addUser(pubKeyHex) {
    this.users.add(pubKeyHex);
  },

  async hasUser(pubKeyHex) {
    return this.users.has(pubKeyHex);
  },

  async setEnvelope(pubKeyHex, recordedAt, headCry, bodyCry, storageKey) {
    this.envelopes.set(storageKey, {
      pubKeyHex,
      headCry,
      bodyCry,
      recordedAt,
    });
  },

  async getBody(pubKeyHex, sha256Hex) {
    const item = this.envelopes.get(sha256Hex);
    if (item?.pubKeyHex !== pubKeyHex) {
      return;
    }
    return item.bodyCry;
  },

  async listHeads(pubKeyHex, begin, end) {
    const list: IDeltaListItem[] = [];
    for (const [key, item] of this.envelopes.entries()) {
      const ts = item.recordedAt.toISOString();
      if (item.pubKeyHex === pubKeyHex && ts >= begin && ts < end) {
        const sha256 = htob(key);
        list.push({
          sha256,
          recordedAt: item.recordedAt,
          headCry: item.headCry,
        });
      }
    }
    return list;
  },
};

export default memStorage;
