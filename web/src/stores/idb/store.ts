import { ICrypto } from "../../shared/types";
import { IStore } from "../../types";
import { IDBDownloadQueue } from "./dnlds";
import { IDBHostStore } from "./hosts";
import { IDBMessageStore } from "./msgs";
import { accountFromSeedMeta, decodeAccount, IDBAccountStore } from "./account";
import { IDBUploadQueue } from "./uplds";

export const ACCOUNTS_TABLE = "accounts";
/** TODO(accounts-sunset): seedMeta store name. Delete with adoptSeedMeta. */
const LEGACY_SEED_META = "seedMeta";
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

/** Schema version: v5 keys each account by a unique label. */
export const DIPLOMATIC_STORE_DB_VERSION = 5;

/** TODO(accounts-sunset): seedMeta had no label. That row is the default account. */
const ADOPTED_ACCOUNT_LABEL = "";

export const DIPLOMATIC_STORE_DB_NAME = "diplomatic-store-db";

export class IDBStore implements IStore<URL> {
  account: IDBAccountStore;
  hosts: IDBHostStore;
  uploads: IDBUploadQueue;
  downloads: IDBDownloadQueue;
  messages: IDBMessageStore;
  db: IDBDatabase;

  constructor(db: IDBDatabase, crypto: ICrypto) {
    this.db = db;
    this.account = new IDBAccountStore(db, crypto);
    this.hosts = new IDBHostStore(db);
    this.uploads = new IDBUploadQueue(db);
    this.downloads = new IDBDownloadQueue(db);
    this.messages = new IDBMessageStore(db, crypto);
  }

  /**
   * Clear protocol tables only (not seed). Seed is wiped only via
   * {@link IAccountStore.wipe} when client.wipe({ seed: true }).
   */
  async wipe() {
    await this.hosts.wipe();
    await this.uploads.wipe();
    await this.downloads.wipe();
    await this.messages.wipe();
  }
}

// Creates the accounts store when this database does not have one yet.
function ensureAccounts(db: IDBDatabase, tx: IDBTransaction): void {
  if (!db.objectStoreNames.contains(ACCOUNTS_TABLE)) {
    db.createObjectStore(ACCOUNTS_TABLE, { keyPath: "label" });
    return;
  }
  const store = tx.objectStore(ACCOUNTS_TABLE);
  if (store.keyPath === "label") return;
  // TODO(accounts-sunset): v4 keyPath was `id`.
  // Delete this rebuild once those DBs have opened v5.
  const req = store.getAll();
  req.onsuccess = () => {
    const rows = req.result;
    db.deleteObjectStore(ACCOUNTS_TABLE);
    const next = db.createObjectStore(ACCOUNTS_TABLE, { keyPath: "label" });
    if (!Array.isArray(rows)) return;
    for (const item of rows) {
      const acct = decodeAccount(item);
      if (acct !== undefined) next.put(acct);
    }
  };
}

// TODO(accounts-sunset): copy seedMeta into one accounts row, then drop it.
function adoptSeedMeta(db: IDBDatabase, tx: IDBTransaction): void {
  const meta = tx.objectStore(LEGACY_SEED_META);
  // TODO(accounts-sunset): seedMeta stored the key tag under "idPin".
  const tagReq = meta.get("idPin");
  const ringReq = meta.get("keyring");
  let tag: unknown;
  let ring: unknown;
  let left = 2;
  const finish = () => {
    left -= 1;
    if (left > 0) return;
    const row = accountFromSeedMeta(ADOPTED_ACCOUNT_LABEL, tag, ring);
    if (row !== undefined) tx.objectStore(ACCOUNTS_TABLE).put(row);
    db.deleteObjectStore(LEGACY_SEED_META);
  };
  tagReq.onsuccess = () => {
    tag = tagReq.result;
    finish();
  };
  ringReq.onsuccess = () => {
    ring = ringReq.result;
    finish();
  };
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
      if (!tx) throw new Error("missing upgrade transaction for accounts");
      ensureAccounts(db, tx);
      // TODO(accounts-sunset): remove with adoptSeedMeta.
      if (db.objectStoreNames.contains(LEGACY_SEED_META)) {
        adoptSeedMeta(db, tx);
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
