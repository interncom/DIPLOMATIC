import { btoh } from "../../../shared/lib.ts";
import type { IDeltaListItem, IStorage } from "../../../shared/types.ts";
import libsodiumCrypto from "../crypto.ts";

interface IMemoryStorage extends IStorage {
  users: Set<string>;
  ops: Map<string, { cipherOp: Uint8Array, recordedAt: Date, pubKeyHex: string }>;
}
const memStorage: IMemoryStorage = {
  users: new Set<string>(), // Set of user pubkeys in hex.
  ops: new Map(), // Path => op binary.

  async addUser(pubKeyHex) {
    this.users.add(pubKeyHex);
  },

  async hasUser(pubKeyHex) {
    return this.users.has(pubKeyHex);
  },

  async setOp(pubKeyHex, recordedAt, op) {
    const sha256 = await libsodiumCrypto.sha256Hash(op);
    const hex = btoh(sha256);
    this.ops.set(hex, { pubKeyHex, cipherOp: op, recordedAt });
  },

  async getOp(pubKeyHex, sha256Hex) {
    const op = this.ops.get(sha256Hex);
    if (op?.pubKeyHex !== pubKeyHex) {
      return;
    }
    return op.cipherOp;
  },

  async listOps(pubKeyHex, begin, end) {
    const list: IDeltaListItem[] = [];
    for (const op of this.ops.values()) {
      const ts = op.recordedAt.toISOString();
      if (op.pubKeyHex === pubKeyHex && ts >= begin && ts < end) {
        const sha256 = await libsodiumCrypto.sha256Hash(op.cipherOp);
        list.push({ sha256, recordedAt: op.recordedAt });
      }
    }
    return list;
  },
}

export default memStorage;
