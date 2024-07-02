import { btoh, htob } from "./shared/lib";
import type { IClientStateStore } from "./types";
import { openDB, deleteDB, type DBSchema } from 'idb';

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

const dbPromise = openDB<ClientStoreDB>('client-store-db', 1, {
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
    await deleteDB('client-store-db');
  }

  async getSeed() {
    const db = await dbPromise;
    const hex = await db.get('metaKV', 'seed');
    if (!hex) {
      return;
    }
    const bytes = htob(hex);
    return bytes;
  }

  async setSeed(seed: Uint8Array) {
    const hex = btoh(seed);
    const db = await dbPromise;
    await db.put('metaKV', hex, 'seed');
    this.seed = seed;
  }

  async getHostURL() {
    const db = await dbPromise;
    const url = await db.get('metaKV', 'hostURL');
    return url;
  }

  async setHostURL(url: string) {
    const db = await dbPromise;
    db.put('metaKV', url, 'hostURL');
  }

  async getHostID() {
    const db = await dbPromise;
    const id = await db.get('metaKV', 'hostID');
    return id;
  }

  async setHostID(id: string) {
    const db = await dbPromise;
    await db.put('metaKV', id, 'hostID');
  }

  uploadQueue = new Map<string, Uint8Array>();
  enqueueUpload = async (sha256: string, cipherOp: Uint8Array) => {
    const db = await dbPromise;
    await db.put('uploadQueue', { sha256, cipherOp });
  }
  dequeueUpload = async (sha256: string) => {
    const db = await dbPromise;
    await db.delete('uploadQueue', sha256);
  }
  peekUpload = async (sha256: string) => {
    const db = await dbPromise;
    const row = await db.get('uploadQueue', sha256);
    return row?.cipherOp;
  };
  listUploads = async () => {
    const db = await dbPromise;
    const sha256s = await db.getAllKeys('uploadQueue');
    return sha256s;
  };

  downloadQueue = new Set<string>();
  enqueueDownload = async (path: string) => {
    const db = await dbPromise;
    await db.put('downloadQueue', { path });
  }
  dequeueDownload = async (path: string) => {
    const db = await dbPromise;
    await db.delete('downloadQueue', path);
  }
  listDownloads = async () => {
    const db = await dbPromise;
    const paths = await db.getAllKeys('downloadQueue');
    return paths;
  }
}

export const idbStore = new IDBStore();
