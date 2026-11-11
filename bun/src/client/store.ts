// SQLite client store. One folder holds meta, data-<acct>, ents-<acct>, and blobs.
// Protocol tables stay idle until bind opens that account's data file.

import type { Database } from "bun:sqlite";
import { maxInlineBodyBytes } from "../../../web/src/shared/bodykey.ts";
import { Status } from "../../../web/src/shared/consts.ts";
import type { ICrypto } from "../../../web/src/shared/types.ts";
import { err, ok, type ValStat } from "../../../web/src/shared/valstat.ts";
import type { IEntDB } from "../../../web/src/entdb/entdb.ts";
import type {
  IDownloadQueue,
  IHostStore,
  IMessageStore,
  IStore,
  IUploadQueue,
} from "../../../web/src/types.ts";
import type { IRealmStore } from "../../../web/src/stores/realm.ts";
import { SqliteAccountStore } from "./data/account.ts";
import { blobsDir, dataPath, entsPath } from "./dir.ts";
import { type DataTables, openDataTables } from "./data/index.ts";
import { EntSqlite } from "./entdb.ts";
import { openDB } from "./sql.ts";

// idleTables serves empty protocol stores before bind and after close.
function idleTables(): DataTables {
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
      async add() {
        return false;
      },
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
      async hasSeqs() {
        return false;
      },
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

export class SqliteStore implements IStore<URL> {
  realms: IRealmStore;
  hosts: IHostStore<URL>;
  uploads: IUploadQueue;
  downloads: IDownloadQueue;
  messages: IMessageStore;
  #db: Database | undefined;
  #path: string | undefined;
  #ents = new Map<string, EntSqlite>();

  constructor(
    private dir: string,
    public account: SqliteAccountStore,
    private crypto: ICrypto,
    private maxInlineBytes = maxInlineBodyBytes,
  ) {
    const idle = idleTables();
    this.realms = idle.realms;
    this.hosts = idle.hosts;
    this.uploads = idle.uploads;
    this.downloads = idle.downloads;
    this.messages = idle.messages;
  }

  // bind opens the protocol file for label.
  async bind(label: string): Promise<Status> {
    let data: string | undefined;
    try {
      data = await this.account.dataName(label);
    } catch {
      return Status.DatabaseError;
    }
    if (data === undefined) return Status.NotFound;
    const path = dataPath(this.dir, data);
    if (path === undefined) return Status.InvalidParam;
    if (this.#db !== undefined && this.#path === path) return Status.Success;
    let db: Database | undefined;
    try {
      db = openDB(path);
      this.#mount(db, path);
      return Status.Success;
    } catch {
      if (db !== undefined && this.#db !== db) db.close();
      return Status.DatabaseError;
    }
  }

  // openEnts opens the ents file for label, creating the catalog name if needed.
  async openEnts(label: string): Promise<ValStat<IEntDB>> {
    const [name, st] = await this.account.ensureEnts(label);
    if (st !== Status.Success || name === undefined) return err(st);
    const hit = this.#ents.get(name);
    if (hit !== undefined) return ok(hit);
    const path = entsPath(this.dir, name);
    if (path === undefined) return err(Status.InvalidParam);
    let db: Database | undefined;
    try {
      db = openDB(path);
      const edb = new EntSqlite(db);
      this.#ents.set(name, edb);
      return ok(edb);
    } catch {
      if (db !== undefined) db.close();
      return err(Status.DatabaseError);
    }
  }

  // closeData closes the data file and every ents file, then serves idle tables.
  closeData() {
    const db = this.#db;
    this.#db = undefined;
    this.#path = undefined;
    this.#use(idleTables());
    if (db !== undefined) db.close();
    for (const edb of this.#ents.values()) edb.close();
    this.#ents.clear();
  }

  // close releases data, ents, and the account catalog.
  close() {
    this.closeData();
    this.account.close();
  }

  // wipe clears hosts, queues, and messages. Realm counters stay.
  async wipe() {
    await this.hosts.wipe();
    await this.uploads.wipe();
    await this.downloads.wipe();
    await this.messages.wipe();
  }

  #mount(db: Database, path: string) {
    const tables = openDataTables(
      db,
      this.crypto,
      blobsDir(this.dir),
      this.maxInlineBytes,
    );
    const prev = this.#db;
    this.#db = db;
    this.#path = path;
    this.#use(tables);
    if (prev !== undefined && prev !== db) prev.close();
  }

  #use(tables: DataTables) {
    this.realms = tables.realms;
    this.hosts = tables.hosts;
    this.uploads = tables.uploads;
    this.downloads = tables.downloads;
    this.messages = tables.messages;
  }
}
