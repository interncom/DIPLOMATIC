import { htob, btoh } from "./shared/lib";
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
  enqueueUpload: (sha256: Uint8Array, cipherOp: Uint8Array) => Promise<void> = async (sha256, cipherOp) => {
    const hex = btoh(sha256);
    this.uploadQueue.set(hex, cipherOp);
  }

  dequeueUpload: (sha256: Uint8Array) => Promise<void> = async (sha256) => {
    const hex = btoh(sha256);
    this.uploadQueue.delete(hex);
  }

  peekUpload: (sha256: Uint8Array) => Promise<Uint8Array | undefined> = async (sha256) => {
    const hex = btoh(sha256);
    return this.uploadQueue.get(hex);
  }

  async listUploadQueue() {
    return Array.from(this.uploadQueue.keys());
  }
  downloadQueue = new Set<string>();
  enqueueDownload: (path: string) => Promise<void> = async (path) => {
    this.downloadQueue.add(path);
  }
  dequeueDownload: (path: string) => Promise<void> = async (path) => {
    this.downloadQueue.delete(path);
  }
}

export const localStorageStore = new LocalStorageStore();
