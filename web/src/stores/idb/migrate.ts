// Opens the catalog and data databases and creates their schema.

import { openAt } from "./idbutil";
import { DATA_DB_VERSION, META_DB_NAME, META_DB_VERSION } from "./names";
import {
  ACCOUNTS_TABLE,
  DOWNLOAD_QUEUE_TABLE,
  HOST_SEQS_TABLE,
  HOSTS_TABLE,
  MESSAGES_APLD_INDEX,
  MESSAGES_RLM_INDEX,
  MESSAGES_TABLE,
  REALMS_TABLE,
  UPLOAD_QUEUE_TABLE,
} from "./store";

// Opens the account catalog.
export function openMetaDB(): Promise<IDBDatabase> {
  return openAt(META_DB_NAME, META_DB_VERSION, (db) => {
    if (!db.objectStoreNames.contains(ACCOUNTS_TABLE)) {
      db.createObjectStore(ACCOUNTS_TABLE, { keyPath: "label" });
    }
  });
}

// Opens one account's protocol database.
export function openDataDB(name: string): Promise<IDBDatabase> {
  return openAt(name, DATA_DB_VERSION, upgradeData);
}

// Creates the current stores when they are missing.
function upgradeData(db: IDBDatabase, tx: IDBTransaction): void {
  if (!db.objectStoreNames.contains(HOSTS_TABLE)) {
    db.createObjectStore(HOSTS_TABLE, { keyPath: "label" });
  }
  if (!db.objectStoreNames.contains(UPLOAD_QUEUE_TABLE)) {
    db.createObjectStore(UPLOAD_QUEUE_TABLE, { keyPath: ["host", "hash"] });
  }
  if (!db.objectStoreNames.contains(DOWNLOAD_QUEUE_TABLE)) {
    db.createObjectStore(DOWNLOAD_QUEUE_TABLE);
  }
  let msgStore: IDBObjectStore;
  if (!db.objectStoreNames.contains(MESSAGES_TABLE)) {
    msgStore = db.createObjectStore(MESSAGES_TABLE);
  } else {
    msgStore = tx.objectStore(MESSAGES_TABLE);
  }
  if (!msgStore.indexNames.contains(MESSAGES_APLD_INDEX)) {
    msgStore.createIndex(MESSAGES_APLD_INDEX, "apld", { unique: false });
  }
  if (!msgStore.indexNames.contains(MESSAGES_RLM_INDEX)) {
    msgStore.createIndex(MESSAGES_RLM_INDEX, "rlm", { unique: false });
  }
  if (!db.objectStoreNames.contains(REALMS_TABLE)) {
    db.createObjectStore(REALMS_TABLE, { keyPath: "label" });
  }
  if (!db.objectStoreNames.contains(HOST_SEQS_TABLE)) {
    const seqs = db.createObjectStore(HOST_SEQS_TABLE, {
      keyPath: ["host", "label", "index"],
    });
    seqs.createIndex("host", "host", { unique: false });
  }
}
