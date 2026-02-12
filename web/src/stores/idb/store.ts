import { ICrypto } from "../../shared/types";
import { IStore } from "../../types";
import { IDBDownloadQueue } from "./dnlds";
import { IDBHostStore } from "./hosts";
import { IDBMessageStore } from "./msgs";
import { IDBSeedStore } from "./seed";
import { IDBUploadQueue } from "./uplds";
import type { IHostRow, IStoredMessage } from "../../types";
import { IDownloadMessage } from "../../types";

export const SEED_META_TABLE = "seedMeta";
export const HOSTS_TABLE = "hosts";
export const UPLOAD_QUEUE_TABLE = "uploadQueue";
export const DOWNLOAD_QUEUE_TABLE = "downloadQueue";
export const MESSAGES_TABLE = "messages";

export class IDBStore implements IStore<URL> {
  seed: IDBSeedStore;
  hosts: IDBHostStore;
  uploads: IDBUploadQueue;
  downloads: IDBDownloadQueue;
  messages: IDBMessageStore;
  db: IDBDatabase;

  constructor(db: IDBDatabase, crypto: ICrypto) {
    this.db = db;
    this.seed = new IDBSeedStore(db);
    this.hosts = new IDBHostStore(db);
    this.uploads = new IDBUploadQueue(db);
    this.downloads = new IDBDownloadQueue(db);
    this.messages = new IDBMessageStore(db, crypto);
  }

  async wipe() {
    await this.seed.wipe();
    await this.hosts.wipe();
    await this.uploads.wipe();
    await this.downloads.wipe();
    await this.messages.wipe();
  }
}

export async function openIDBStore(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("diplomatic-store-db", 2);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      if (!db.objectStoreNames.contains(SEED_META_TABLE)) {
        db.createObjectStore(SEED_META_TABLE);
      }
      if (!db.objectStoreNames.contains(HOSTS_TABLE)) {
        db.createObjectStore(HOSTS_TABLE, {
          keyPath: "label",
        });
      }
      if (!db.objectStoreNames.contains(UPLOAD_QUEUE_TABLE)) {
        db.createObjectStore(UPLOAD_QUEUE_TABLE, {
          keyPath: ["host", "hash"],
        });
      }
      if (!db.objectStoreNames.contains(DOWNLOAD_QUEUE_TABLE)) {
        db.createObjectStore(DOWNLOAD_QUEUE_TABLE);
      }
      if (!db.objectStoreNames.contains(MESSAGES_TABLE)) {
        db.createObjectStore(MESSAGES_TABLE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
