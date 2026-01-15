import { IHostConnectionInfo } from "../../shared/types";
import type { IHostRow, IHostStore } from "../../types";
import { type IDBPDatabase } from "idb";
import { HOSTS_TABLE } from "./store";

function idbRowToHostRow(row: any): IHostRow<URL> {
  const host: IHostRow<URL> = {
    label: row.label,
    handle: new URL(row.handle),
    idx: row.idx,
    lastSyncedAt: row.lastSyncedAt,
  }
  return host;
}

export class IDBHostStore
  implements IHostStore<URL> {
  db: IDBPDatabase<any>;

  constructor(db: IDBPDatabase) {
    this.db = db;
  }
  async add(info: IHostConnectionInfo<URL>) {
    const host = {
      ...info,
      handle: info.handle.toString(),
      lastSyncedAt: new Date(0),
    };
    await this.db.put(HOSTS_TABLE, host);
  }

  async get(label: string) {
    const row = await this.db.get(HOSTS_TABLE, label);
    if (!row) {
      return undefined;
    }
    return idbRowToHostRow(row);
  }

  async del(label: string) {
    await this.db.delete(HOSTS_TABLE, label);
  }

  async list() {
    const rows = await this.db.getAll(HOSTS_TABLE);
    return rows.map(idbRowToHostRow);
  }

  async wipe() {
    await this.db.clear(HOSTS_TABLE);
  }
}
