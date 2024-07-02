import { btoh, htob } from "./shared/lib";
import type { IClientStateStore } from "./types";
import { openDB, type DBSchema } from 'idb';

interface ClientStoreDB extends DBSchema {
  metaKV: {
    key: string;
    value: string;
  },
  uploadQueue: {
    value: {
      cipherOp: Uint8Array;
      sha256: string;
    };
    key: string;
  }
  downloadQueue: {
    value: {
      path: string;
    };
    key: string;
  }
}


const db = await openDB<ClientStoreDB>('client-store-db', 2, {
  upgrade(db) {
    db.createObjectStore('metaKV');
    db.createObjectStore('uploadQueue', {
      keyPath: 'sha256',
    });
    db.createObjectStore('downloadQueue', {
      keyPath: 'path',
    });
  },
});

class IDBStore implements IClientStateStore {
  seed?: Uint8Array;
  hostURL?: string;
  hostID?: string;

  async wipe() {
    await db.clear('metaKV');
    await db.clear('uploadQueue');
    await db.clear('downloadQueue');
  }

  async getSeed() {
    const hex = await db.get('metaKV', 'seed');
    if (!hex) {
      return;
    }
    const bytes = htob(hex);
    return bytes;
  }

  async setSeed(seed: Uint8Array) {
    const hex = btoh(seed);
    await db.put('metaKV', hex, 'seed');
    this.seed = seed;
  }

  async getHostURL() {
    const url = await db.get('metaKV', 'hostURL');
    return url;
  }

  async setHostURL(url: string) {
    db.put('metaKV', url, 'hostURL');
  }

  async getHostID() {
    const id = await db.get('metaKV', 'hostID');
    return id;
  }

  async setHostID(id: string) {
    await db.put('metaKV', id, 'hostID');
  }

  uploadQueue = new Map<string, Uint8Array>();
  enqueueUpload = async (sha256: string, cipherOp: Uint8Array) => {
    await db.put('uploadQueue', { sha256, cipherOp });
  }
  dequeueUpload = async (sha256: string) => {
    await db.delete('uploadQueue', sha256);
  }
  peekUpload = async (sha256: string) => {
    const row = await db.get('uploadQueue', sha256);
    return row?.cipherOp;
  };
  listUploads = async () => {
    const sha256s = await db.getAllKeys('uploadQueue');
    return sha256s;
  };
  numUploads = async () => {
    const num = await db.count('uploadQueue');
    return num;
  }

  downloadQueue = new Set<string>();
  enqueueDownload = async (path: string) => {
    await db.put('downloadQueue', { path });
  }
  dequeueDownload = async (path: string) => {
    await db.delete('downloadQueue', path);
  }
  listDownloads = async () => {
    const paths = await db.getAllKeys('downloadQueue');
    return paths;
  }
  numDownloads = async () => {
    const num = await db.count('downloadQueue');
    return num;
  }
}

export const idbStore = new IDBStore();
