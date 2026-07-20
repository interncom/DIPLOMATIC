import { ICrypto } from "../../shared/types";
import { IStore } from "../../types";
import { IDBDownloadQueue } from "./dnlds";
import { IDBHostStore } from "./hosts";
import { IDBMessageStore } from "./msgs";
import { IDBSeedStore } from "./seed";
import { IDBUploadQueue } from "./uplds";

export const SEED_META_TABLE = "seedMeta";
export const HOSTS_TABLE = "hosts";
export const UPLOAD_QUEUE_TABLE = "uploadQueue";
export const DOWNLOAD_QUEUE_TABLE = "downloadQueue";
export const MESSAGES_TABLE = "messages";
/** Index on messages.apld — pending apply is apld === false. */
export const MESSAGES_APLD_INDEX = "apld";

/** Schema version: v3 adds messages.apld index for the apply queue. */
export const DIPLOMATIC_STORE_DB_VERSION = 3;

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

export async function openIDBStoreDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(
      "diplomatic-store-db",
      DIPLOMATIC_STORE_DB_VERSION,
    );
    req.onupgradeneeded = () => {
      const db = req.result;
      const tx = req.transaction;
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

      let msgStore: IDBObjectStore;
      if (!db.objectStoreNames.contains(MESSAGES_TABLE)) {
        msgStore = db.createObjectStore(MESSAGES_TABLE);
      } else {
        // Upgrade path: existing store (tx is non-null during onupgradeneeded).
        if (!tx) {
          throw new Error("missing upgrade transaction for messages store");
        }
        msgStore = tx.objectStore(MESSAGES_TABLE);
      }
      if (!msgStore.indexNames.contains(MESSAGES_APLD_INDEX)) {
        // Only rows with apld set are indexed; false = not yet applied.
        msgStore.createIndex(MESSAGES_APLD_INDEX, "apld", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function openIDBStore(crypto: ICrypto) {
  const db = await openIDBStoreDB();
  if (navigator.storage && navigator.storage.persist) {
    await navigator.storage.persist();
  }
  return new IDBStore(db, crypto);
}
