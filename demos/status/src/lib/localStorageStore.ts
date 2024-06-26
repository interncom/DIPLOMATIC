import { htob, btoh } from "../../../../shared/lib";
import type { IClientStateStore } from "./types";

const seedKey = "seedHex";
const hostURLKey = "hostURL";
const hostIDKey = "hostID";

export const localStorageStore: IClientStateStore = {
  async getSeed() {
    const storedSeed = localStorage.getItem(seedKey);
    if (storedSeed) {
      const seed = htob(storedSeed);
      return seed;
    }
  },
  async setSeed(seed: Uint8Array) {
    const seedString = btoh(seed);
    localStorage.setItem(seedKey, seedString);
  },
  async getHostURL() {
    return localStorage.getItem(hostURLKey) ?? undefined;
  },
  async setHostURL(url: string) {
    return localStorage.setItem(hostURLKey, url);
  },
  async getHostID() {
    return localStorage.getItem(hostIDKey) ?? undefined;
  },
  async setHostID(id: string) {
    return localStorage.setItem(hostIDKey, id);
  },
}
