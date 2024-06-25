import type { IStorage } from "../../../shared/types.ts";

interface IMemoryStorage extends IStorage {
  users: Set<string>;
  ops: Map<string, Uint8Array>;
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

  async setOp(pubKeyHex, path, op) {
    const fullPath = [pubKeyHex, path].join('/');
    this.ops.set(fullPath, op);
  },

  async getOp(pubKeyHex, path) {
    const fullPath = [pubKeyHex, path].join('/');
    return this.ops.get(fullPath);
  },

  async listOps(pubKeyHex, begin, end) {
    const paths: string[] = [];
    for (const [key, _] of this.ops) {
      const [pkh, ts] = key.split('/');
      if (pkh === pubKeyHex && ts >= begin && ts < end) {
        paths.push(ts);
      }
    }
    return paths;
  },
}

export default memStorage;
