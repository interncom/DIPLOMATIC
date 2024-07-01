import { Queue } from "./queue";
import type { IClientStateStore, IQueue } from "./types";

class MemoryStore implements IClientStateStore {
  seed?: Uint8Array;
  hostURL?: string;
  hostID?: string;

  async getSeed() {
    return this.seed;
  }

  async setSeed(seed: Uint8Array) {
    this.seed = seed;
  }

  async getHostURL() {
    return this.hostURL;
  }

  async setHostURL(url: string) {
    this.hostURL = url;
  }

  async getHostID() {
    return this.hostID;
  }

  async setHostID(id: string) {
    this.hostID = id;
  }

  pushQueue = new Queue<string, Uint8Array>();
  pullQueue = new Queue<string, null>();
}

export const memoryStore = new MemoryStore();
