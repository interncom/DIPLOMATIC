import { htob, btoh } from "./shared/lib";
import type { IClientStateStore } from "./types";

const seedKey = "seedHex";
const hostURLKey = "hostURL";
const hostIDKey = "hostID";

class LocalStorageStore implements IClientStateStore {
  async wipe() {
    localStorage.clear();
  }

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
  enqueueUpload = async (sha256: string, cipherOp: Uint8Array) => {
    this.uploadQueue.set(sha256, cipherOp);
  }
  dequeueUpload = async (sha256: string) => {
    this.uploadQueue.delete(sha256);
  }
  peekUpload = async (sha256: string) => {
    return this.uploadQueue.get(sha256);
  };
  listUploads = async () => {
    return Array.from(this.uploadQueue.keys());
  };
  numUploads = async () => {
    return this.uploadQueue.size;
  }

  downloadQueue = new Set<string>();
  enqueueDownload = async (path: string) => {
    this.downloadQueue.add(path);
  }
  dequeueDownload = async (path: string) => {
    this.downloadQueue.delete(path);
  }
  listDownloads = async () => {
    return Array.from(this.downloadQueue.keys());
  }
  numDownloads = async () => {
    return this.downloadQueue.size;
  }
}

export const localStorageStore = new LocalStorageStore();
