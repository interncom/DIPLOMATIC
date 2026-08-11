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
/**
 * Index on messages.apld ({@link APLD_PENDING} / {@link APLD_APPLIED} /
 * {@link APLD_ERROR}). Booleans are not valid IndexedDB keys; single-char
 * strings keep keys compact.
 */
export const MESSAGES_APLD_INDEX = "apld";

/** Schema version: v3 adds messages.apld index for the apply queue. */
export const DIPLOMATIC_STORE_DB_VERSION = 3;

export const DIPLOMATIC_STORE_DB_NAME = "diplomatic-store-db";

export class IDBStore implements IStore<URL> {
  seed: IDBSeedStore;
  hosts: IDBHostStore;
  uploads: IDBUploadQueue;
  downloads: IDBDownloadQueue;
  messages: IDBMessageStore;
  db: IDBDatabase;

  constructor(db: IDBDatabase, crypto: ICrypto) {
    this.db = db;
    this.seed = new IDBSeedStore(db, crypto);
    this.hosts = new IDBHostStore(db);
    this.uploads = new IDBUploadQueue(db);
    this.downloads = new IDBDownloadQueue(db);
    this.messages = new IDBMessageStore(db, crypto);
  }

  /**
   * Clear protocol tables only (not seed). Seed is wiped only via
   * {@link ISeedStore.wipe} when client.wipe({ seed: true }).
   */
  async wipe() {
    await this.hosts.wipe();
    await this.uploads.wipe();
    await this.downloads.wipe();
    await this.messages.wipe();
  }
}

export async function openIDBStoreDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(
      DIPLOMATIC_STORE_DB_NAME,
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
        msgStore.createIndex(MESSAGES_APLD_INDEX, "apld", { unique: false });
      }
    };
    req.onblocked = () => {
      console.warn(
        "[DIPLOMATIC] protocol store IDB upgrade blocked " +
          `(${DIPLOMATIC_STORE_DB_NAME} → v${DIPLOMATIC_STORE_DB_VERSION}); ` +
          "waiting for other connections to close",
      );
    };
    req.onsuccess = () => {
      const db = req.result;
      // Main + worker share this DB. Close on versionchange so a peer upgrade
      // is not blocked (same multi-connection rule as EntDB).
      db.onversionchange = () => {
        db.close();
      };
      resolve(db);
    };
    req.onerror = () =>
      reject(req.error ?? new Error("protocol store IndexedDB open failed"));
  });
}

export async function openIDBStore(crypto: ICrypto) {
  const db = await openIDBStoreDB();
  // persist() can be slow or unavailable in workers; never block worker ready.
  if (typeof navigator !== "undefined" && navigator.storage?.persist) {
    try {
      await Promise.race([
        navigator.storage.persist(),
        new Promise<boolean>((resolve) => {
          setTimeout(() => resolve(false), 2_000);
        }),
      ]);
    } catch {
      // Non-fatal: durable storage request is best-effort.
    }
  }
  return new IDBStore(db, crypto);
}
