import { htob, btoh } from "../../../cli/src/lib";
import { IClientStateStore } from "./client";

const seedKey = "seedHex";

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
  }
}
