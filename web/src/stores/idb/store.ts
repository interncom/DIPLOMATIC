import { Status } from "../../shared/consts";
import { ICrypto } from "../../shared/types";
import { err, ok, type ValStat } from "../../shared/valstat";
import {
  IAccountStore,
  IDownloadQueue,
  IHostStore,
  IMessageStore,
  IStore,
  IUploadQueue,
} from "../../types";
import type { IRealmStore } from "../realm";
import { IDBAccountStore } from "./account";
import { IDBDownloadQueue } from "./dnlds";
import { IDBHostStore } from "./hosts";
import { openDataDB, openMetaDB } from "./migrate";
import { IDBMessageStore } from "./msgs";
import { IDBRealmStore } from "./realms";
import { IDBUploadQueue } from "./uplds";
export const ACCOUNTS_TABLE = "accounts";
export const HOSTS_TABLE = "hosts";
/** Host-realm cursors. Key is host, realm label, realm index. */
export const HOST_SEQS_TABLE = "host_seqs";
export const UPLOAD_QUEUE_TABLE = "uploadQueue";
export const DOWNLOAD_QUEUE_TABLE = "downloadQueue";
export const MESSAGES_TABLE = "messages";
/**
 * Index on messages.apld ({@link APLD_PENDING} / {@link APLD_APPLIED} /
 * {@link APLD_ERROR}). Booleans are not valid IndexedDB keys; single-char
 * strings keep keys compact.
 */
export const MESSAGES_APLD_INDEX = "apld";
/** Realm label. Default-realm rows omit rlm and are not in this index. */
export const MESSAGES_RLM_INDEX = "rlm";
export const REALMS_TABLE = "realms";

type Tables = {
  realms: IRealmStore;
  hosts: IHostStore<URL>;
  uploads: IUploadQueue;
  downloads: IDownloadQueue;
  messages: IMessageStore;
};

// Protocol stores for one open data database.
function openTables(db: IDBDatabase, crypto: ICrypto): Tables {
  return {
    realms: new IDBRealmStore(db),
    hosts: new IDBHostStore(db),
    uploads: new IDBUploadQueue(db),
    downloads: new IDBDownloadQueue(db),
    messages: new IDBMessageStore(db, crypto),
  };
}

// Protocol stores before a data database is open. Reads are empty.
function idleTables(): Tables {
  return {
    realms: {
      async list() {
        return [];
      },
      async get() {
        return undefined;
      },
      async put() {
        return Status.NotFound;
      },
      async wipe() {},
    },
    hosts: {
      async add() {},
      async get() {
        return undefined;
      },
      async del() {},
      async set() {
        return Status.NotFound;
      },
      async list() {
        return [];
      },
      async wipe() {},
      async touch() {},
      async recordSeqs() {},
    },
    uploads: {
      async enq() {},
      async deq() {},
      async list() {
        return [];
      },
      async count() {
        return 0;
      },
      async wipe() {},
    },
    downloads: {
      async enq() {},
      async deq() {},
      async list() {
        return [];
      },
      async count() {
        return 0;
      },
      async wipe() {},
    },
    messages: {
      async add(rows) {
        return rows.map(() => Status.DatabaseError);
      },
      async get() {
        return undefined;
      },
      async has() {
        return false;
      },
      async del() {},
      async list() {
        return [];
      },
      async count() {
        return 0;
      },
      async listKeys() {
        return [];
      },
      async last() {
        return undefined;
      },
      async markApplied() {},
      async markFailed() {},
      async wipe() {},
    },
  };
}

export class IDBStore implements IStore<URL> {
  account: IAccountStore;
  realms: IRealmStore;
  hosts: IHostStore<URL>;
  uploads: IUploadQueue;
  downloads: IDownloadQueue;
  messages: IMessageStore;
  #db: IDBDatabase | undefined;
  #crypto: ICrypto;
  #lookup: ((label: string) => Promise<string | undefined>) | undefined;

  constructor(
    account: IAccountStore,
    crypto: ICrypto,
    lookup?: (label: string) => Promise<string | undefined>,
    db?: IDBDatabase,
  ) {
    this.account = account;
    this.#crypto = crypto;
    this.#lookup = lookup;
    const idle = idleTables();
    this.realms = idle.realms;
    this.hosts = idle.hosts;
    this.uploads = idle.uploads;
    this.downloads = idle.downloads;
    this.messages = idle.messages;
    if (db !== undefined) this.#mount(db);
  }

  // Points the protocol stores at `db` and closes the previous connection.
  #mount(db: IDBDatabase) {
    const prev = this.#db;
    this.#db = db;
    db.onversionchange = () => {
      if (this.#db !== db) return;
      this.#drop();
    };
    this.#use(openTables(db, this.#crypto));
    if (prev !== undefined && prev !== db) prev.close();
  }

  // Closes the open data database and serves empty protocol stores.
  #drop() {
    const db = this.#db;
    this.#db = undefined;
    this.#use(idleTables());
    if (db !== undefined) db.close();
  }

  // Installs one set of protocol stores.
  #use(tables: Tables) {
    this.realms = tables.realms;
    this.hosts = tables.hosts;
    this.uploads = tables.uploads;
    this.downloads = tables.downloads;
    this.messages = tables.messages;
  }

  // Opens this account's protocol database. A worker store is already open.
  async bind(label: string): Promise<Status> {
    if (this.#lookup === undefined) {
      return this.#db === undefined ? Status.NotFound : Status.Success;
    }
    const data = await this.#lookup(label);
    if (data === undefined) return Status.NotFound;
    if (this.#db !== undefined && this.#db.name === data) return Status.Success;
    const db = await openDataDB(data);
    this.#mount(db);
    return Status.Success;
  }

  // Data and ents names the worker should open. Does not open ents here.
  async prepareWorker(
    label: string,
  ): Promise<ValStat<{ data: string; ents: string }>> {
    const data = await this.#lookup?.(label);
    if (data === undefined) return err(Status.NotFound);
    if (!(this.account instanceof IDBAccountStore)) {
      return err(Status.InvalidParam);
    }
    const ents = await this.account.ensureEnts(label);
    return ok({ data, ents });
  }

  close() {
    this.#drop();
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

// Opens the catalog and, when the default account already has one, its data.
export async function openIDBStore(crypto: ICrypto) {
  await persistBestEffort();
  const meta = await openMetaDB();
  const account = new IDBAccountStore(meta, crypto);
  const store = new IDBStore(
    account,
    crypto,
    (label) => account.dataName(label),
  );
  account.setCloser(() => store.close());
  const home = await account.dataName("");
  if (home !== undefined) await store.bind("");
  return store;
}

// Worker protocol database. The catalog stays on the main thread.
export async function openBoundStore(
  crypto: ICrypto,
  data: string,
): Promise<IDBStore> {
  const db = await openDataDB(data);
  const account: IAccountStore = {
    async save() {
      return err(Status.InvalidParam);
    },
    async wipe() {},
  };
  return new IDBStore(account, crypto, undefined, db);
}

async function persistBestEffort() {
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
}
