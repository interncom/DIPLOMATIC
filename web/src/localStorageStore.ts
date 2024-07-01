import { Queue } from "./queue";
import { htob, btoh } from "./shared/lib";
import type { IClientStateStore, IQueue } from "./types";

const seedKey = "seedHex";
const hostURLKey = "hostURL";
const hostIDKey = "hostID";

class LocalStorageStore implements IClientStateStore {
  async getSeed() {
    const storedSeed = localStorage.getItem(seedKey);
    if (storedSeed) {
      const seed = htob(storedSeed);
      return seed;
    }
  }

  async setSeed(seed: Uint8Array) {
    const seedString = btoh(seed);
    localStorage.setItem(seedKey, seedString);
  }

  async getHostURL() {
    return localStorage.getItem(hostURLKey) ?? undefined;
  }

  async setHostURL(url: string) {
    return localStorage.setItem(hostURLKey, url);
  }

  async getHostID() {
    return localStorage.getItem(hostIDKey) ?? undefined;
  }

  async setHostID(id: string) {
    return localStorage.setItem(hostIDKey, id);
  }

  pushQueue = new Queue<string, Uint8Array>();
  pullQueue = new Queue<string, null>();
}

export const localStorageStore = new LocalStorageStore();
