import { btoh, htob } from "./shared/lib";
import type { IClientStateStore } from "./types";
import { openDB, type DBSchema } from 'idb';

interface ClientStoreDB extends DBSchema {
  metaKV: {
    key: string;
    value: string;
  },
  ops: {
    value: {
      cipherOp: Uint8Array;
      sha256: string;
    };
    key: string;
  }
  uploadQueue: {
    value: {
      cipherOp: Uint8Array;
      sha256: string;
    };
    key: string;
  }
  downloadQueue: {
    value: {
      sha256: string;
      recordedAt: Date;
    };
    key: string;
  }
}


const db = await openDB<ClientStoreDB>('client-store-db', 5, {
  upgrade(db) {
    db.createObjectStore('metaKV');
    db.createObjectStore('ops', {
      keyPath: 'sha256',
    });
    db.createObjectStore('uploadQueue', {
      keyPath: 'sha256',
    });
    db.createObjectStore('downloadQueue', {
      keyPath: 'sha256',
    });
  },
});

class IDBStore implements IClientStateStore {
  seed?: Uint8Array;
  hostURL?: string;
  hostID?: string;
  lastFetchedAt?: Date;

  async wipe() {
    await db.clear('metaKV');
    await db.clear('uploadQueue');
    await db.clear('downloadQueue');
    await db.clear('ops');
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

  async getLastFetchedAt() {
    const res = await db.get('metaKV', 'lastFetchedAt');
    if (!res) {
      return;
    }
    return new Date(res);
  }

  async setLastFetchedAt(ts: Date) {
    const str = ts.toISOString();
    await db.put('metaKV', str, 'lastFetchedAt');
  }

  enqueueUpload = async (sha256: Uint8Array, cipherOp: Uint8Array) => {
    const hex = btoh(sha256);
    await db.put('uploadQueue', { sha256: hex, cipherOp });
  }
  dequeueUpload = async (sha256: Uint8Array) => {
    const hex = btoh(sha256);
    await db.delete('uploadQueue', hex);
  }
  peekUpload = async (sha256: Uint8Array) => {
    const hex = btoh(sha256);
    const row = await db.get('uploadQueue', hex);
    return row?.cipherOp;
  };
  listUploads = async () => {
    const hexes = await db.getAllKeys('uploadQueue');
    return hexes.map(htob);
  };
  numUploads = async () => {
    const num = await db.count('uploadQueue');
    return num;
  }

  downloadQueue = new Set<string>();
  enqueueDownload = async (sha256: Uint8Array, recordedAt: Date) => {
    const hex = btoh(sha256);
    await db.put('downloadQueue', { sha256: hex, recordedAt });
  }
  dequeueDownload = async (sha256: Uint8Array) => {
    const hex = btoh(sha256);
    await db.delete('downloadQueue', hex);
  }
  listDownloads = async () => {
    const list = await db.getAll('downloadQueue');
    return list.map(item => ({ sha256: htob(item.sha256), recordedAt: item.recordedAt }));
  }
  numDownloads = async () => {
    const num = await db.count('downloadQueue');
    return num;
  }

  storeOp = async (sha256: Uint8Array, cipherOp: Uint8Array) => {
    const hex = btoh(sha256);
    await db.put('ops', { sha256: hex, cipherOp });
  }
  clearOp = async (sha256: Uint8Array) => {
    const hex = btoh(sha256);
    await db.delete('ops', hex);
  }
  listOps = async () => {
    const list = await db.getAll('ops');
    return list.map(item => ({ sha256: item.sha256, cipherOp: item.cipherOp }));
  }
  hasOp = async (sha256: Uint8Array) => {
    const hex = btoh(sha256);
    const op = await db.get('ops', hex);
    return op !== undefined;
  }
}

export const idbStore = new IDBStore();
