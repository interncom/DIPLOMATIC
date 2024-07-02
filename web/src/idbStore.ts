import { btoh, htob } from "./shared/lib";
import type { IClientStateStore } from "./types";
import { openDB, type DBSchema } from 'idb';

interface ClientStoreDB extends DBSchema {
  metaKV: {
    key: string;
    value: string;
  },
}

const dbPromise = openDB<ClientStoreDB>('client-store-db', 1, {
  upgrade(db) {
    db.createObjectStore('metaKV');
  },
});

class IDBStore implements IClientStateStore {
  seed?: Uint8Array;
  hostURL?: string;
  hostID?: string;

  async getSeed() {
    const hex = await (await dbPromise).get('metaKV', 'seed');
    if (!hex) {
      return;
    }
    const bytes = htob(hex);
    return bytes;
  }

  async setSeed(seed: Uint8Array) {
    const hex = btoh(seed);
    (await dbPromise).put('metaKV', hex, 'seed');
    this.seed = seed;
  }

  async getHostURL() {
    const url = await (await dbPromise).get('metaKV', 'hostURL');
    return url;
  }

  async setHostURL(url: string) {
    (await dbPromise).put('metaKV', url, 'hostURL');
  }

  async getHostID() {
    const id = await (await dbPromise).get('metaKV', 'hostID');
    return id;
  }

  async setHostID(id: string) {
    (await dbPromise).put('metaKV', id, 'hostID');
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
}

export const idbStore = new IDBStore();
