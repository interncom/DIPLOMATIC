import { htob, btoh } from "../../../../shared/lib";
import type { IClientStateStore } from "./types";

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

  uploadQueue = new Map<string, Uint8Array>();
  async enqueueUpload(sha256, cipherOp) {
    const hex = btoh(sha256);
    this.uploadQueue.set(hex, cipherOp);
  }
  async dequeueUpload(sha256) {
    const hex = btoh(sha256);
    this.uploadQueue.delete(hex);
  }
  async peekUpload(sha256) {
    const hex = btoh(sha256);
    return this.uploadQueue.get(hex);
  }
  async listUploadQueue() {
    return Array.from(this.uploadQueue.keys());
  }
  downloadQueue = new Set<string>();
  async enqueueDownload(path) {
    this.downloadQueue.add(path);
  }
  async dequeueDownload(path) {
    this.downloadQueue.delete(path);
  }
}

export const localStorageStore = new LocalStorageStore();
