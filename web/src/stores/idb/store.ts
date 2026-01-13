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

interface DiplomaticStoreDB extends DBSchema {
  seedMeta: {
    key: string;
    value: string;
  };
  hosts: {
    key: string;
    value: IHostRow<any>;
  };
  uploadQueue: {
    key: string;
    value: null;
  };
  downloadQueue: {
    key: string;
    value: IDownloadMessage;
  };
  messages: {
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
      if (!db.objectStoreNames.contains("seedMeta")) {
        db.createObjectStore("seedMeta");
      }
      if (!db.objectStoreNames.contains("hosts")) {
        db.createObjectStore("hosts", {
          keyPath: "label",
        });
      }
      if (!db.objectStoreNames.contains("uploadQueue")) {
        db.createObjectStore("uploadQueue");
      }
      if (!db.objectStoreNames.contains("downloadQueue")) {
        db.createObjectStore("downloadQueue");
      }
      if (!db.objectStoreNames.contains("messages")) {
        db.createObjectStore("messages");
      }
    },
  });
}
