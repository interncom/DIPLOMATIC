import { HostHandle } from "../../shared/types";
import { IStore } from "../../types";
import { IDBDownloadQueue } from "./dnlds";
import { IDBHostStore } from "./hosts";
import { IDBMessageStore } from "./msgs";
import { IDBSeedStore } from "./seed";
import { IDBUploadQueue } from "./uplds";
import { type DBSchema, type IDBPDatabase, openDB } from "idb";
import type { IHostRow, IStoredMessage } from "../../types";
import { IDownloadMessage } from "../../types";

export const SEED_META_TABLE = "seedMeta";
export const HOSTS_TABLE = "hosts";
export const UPLOAD_QUEUE_TABLE = "uploadQueue";
export const DOWNLOAD_QUEUE_TABLE = "downloadQueue";
export const MESSAGES_TABLE = "messages";

interface DiplomaticStoreDB extends DBSchema {
  [SEED_META_TABLE]: {
    key: string;
    value: string;
  };
  [HOSTS_TABLE]: {
    key: string;
    value: IHostRow<any>;
  };
  [UPLOAD_QUEUE_TABLE]: {
    key: string;
    value: null;
  };
  [DOWNLOAD_QUEUE_TABLE]: {
    key: string;
    value: IDownloadMessage;
  };
  [MESSAGES_TABLE]: {
    key: string;
    value: IStoredMessage;
  };
}

export class IDBStore<Handle extends HostHandle> implements IStore<Handle> {
  seed: IDBSeedStore;
  hosts: IDBHostStore<Handle>;
  uploads: IDBUploadQueue;
  downloads: IDBDownloadQueue;
  messages: IDBMessageStore;
  db: IDBPDatabase<DiplomaticStoreDB>;

  constructor(db: IDBPDatabase<DiplomaticStoreDB>) {
    this.db = db;
    this.seed = new IDBSeedStore(this.db as IDBPDatabase<any>);
    this.hosts = new IDBHostStore<Handle>(this.db as IDBPDatabase<any>);
    this.uploads = new IDBUploadQueue(this.db as IDBPDatabase<any>);
    this.downloads = new IDBDownloadQueue(this.db as IDBPDatabase<any>);
    this.messages = new IDBMessageStore(this.db as IDBPDatabase<any>);
  }

  async wipe() {
    await this.seed.wipe();
    await this.hosts.wipe();
    await this.uploads.wipe();
    await this.downloads.wipe();
    await this.messages.wipe();
  }
}

export async function openIDBStore(): Promise<IDBPDatabase<DiplomaticStoreDB>> {
  return openDB<DiplomaticStoreDB>("diplomatic-store-db", 1, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(SEED_META_TABLE)) {
        db.createObjectStore(SEED_META_TABLE);
      }
      if (!db.objectStoreNames.contains(HOSTS_TABLE)) {
        db.createObjectStore(HOSTS_TABLE, {
          keyPath: "label",
        });
      }
      if (!db.objectStoreNames.contains(UPLOAD_QUEUE_TABLE)) {
        db.createObjectStore(UPLOAD_QUEUE_TABLE);
      }
      if (!db.objectStoreNames.contains(DOWNLOAD_QUEUE_TABLE)) {
        db.createObjectStore(DOWNLOAD_QUEUE_TABLE);
      }
      if (!db.objectStoreNames.contains(MESSAGES_TABLE)) {
        db.createObjectStore(MESSAGES_TABLE);
      }
    },
  });
}
