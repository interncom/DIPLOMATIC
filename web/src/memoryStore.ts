import { btoh, htob } from "./shared/lib";
import type { IClientStateStore } from "./types";

class MemoryStore implements IClientStateStore {
  seed?: Uint8Array;
  hostURL?: string;
  hostID?: string;
  lastFetchedAt?: Date;

  async wipe() {
    this.seed = undefined;
    this.hostID = undefined;
    this.hostURL = undefined;
    this.uploadQueue = new Map<string, Uint8Array>();
    this.downloadQueue = new Map<string, Date>();
  }

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

  async getLastFetchedAt() {
    return this.lastFetchedAt;
  }

  async setLastFetchedAt(ts: Date) {
    this.lastFetchedAt = ts;
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

export const memoryStore = new MemoryStore();
