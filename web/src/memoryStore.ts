import type { IClientStateStore } from "./types";

class MemoryStore implements IClientStateStore {
  seed?: Uint8Array;
  hostURL?: string;
  hostID?: string;

  async wipe() {
    this.seed = undefined;
    this.hostID = undefined;
    this.hostURL = undefined;
    this.uploadQueue = new Map<string, Uint8Array>();
    this.downloadQueue = new Set<string>();
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

export const memoryStore = new MemoryStore();
