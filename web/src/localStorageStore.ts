import { htob, btoh } from "./shared/lib";
import type { IClientStateStore } from "./types";

const seedKey = "seedHex";
const hostURLKey = "hostURL";
const hostIDKey = "hostID";
const lastFetchedAtKey = "lastFetchedAt";

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

  async getLastFetchedAt() {
    const res = localStorage.getItem(lastFetchedAtKey);
    if (!res) {
      return;
    }
    return new Date(res);
  }

  async setLastFetchedAt(ts: Date) {
    const str = ts.toISOString();
    localStorage.setItem(lastFetchedAtKey, str);
  }

  uploadQueue = new Map<string, Uint8Array>();
  enqueueUpload = async (sha256: Uint8Array, cipherOp: Uint8Array) => {
    const hex = btoh(sha256);
    this.uploadQueue.set(hex, cipherOp);
  }
  dequeueUpload = async (sha256: Uint8Array) => {
    const hex = btoh(sha256);
    this.uploadQueue.delete(hex);
  }
  peekUpload = async (sha256: Uint8Array) => {
    const hex = btoh(sha256);
    return this.uploadQueue.get(hex);
  };
  listUploads = async () => {
    const hexes = Array.from(this.uploadQueue.keys());
    return hexes.map(htob);
  };
  numUploads = async () => {
    return this.uploadQueue.size;
  }

  downloadQueue = new Map<string, Date>();
  enqueueDownload = async (sha256: Uint8Array, recordedAt: Date) => {
    const hex = btoh(sha256);
    this.downloadQueue.set(hex, recordedAt);
  }
  dequeueDownload = async (sha256: Uint8Array) => {
    const hex = btoh(sha256);
    this.downloadQueue.delete(hex);
  }
  listDownloads = async () => {
    const list = Array.from(this.downloadQueue.entries());
    return list.map(([hex, recordedAt]) => {
      return { sha256: htob(hex), recordedAt };
    });
  }
  numDownloads = async () => {
    return this.downloadQueue.size;
  }

  ops = new Map<string, Uint8Array>();
  storeOp = async (sha256: Uint8Array, cipherOp: Uint8Array) => {
    const hex = btoh(sha256);
    this.ops.set(hex, cipherOp);
  }
  clearOp = async (sha256: Uint8Array) => {
    const hex = btoh(sha256);
    this.ops.delete(hex);
  }
  listOps = async () => {
    const list = Array.from(this.ops.entries());
    return list.map(([hex, cipherOp]) => {
      return { sha256: hex, cipherOp };
    });
  }
  hasOp = async (sha256: Uint8Array) => {
    const hex = btoh(sha256);
    return this.ops.has(hex);
  }
}

export const localStorageStore = new LocalStorageStore();
