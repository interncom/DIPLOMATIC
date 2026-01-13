import { HostHandle, IHostConnectionInfo } from "../../shared/types";
import type { IHostRow, IHostStore } from "../../types";
import { type IDBPDatabase } from "idb";
import { HOSTS_TABLE } from "./store";

export class IDBHostStore<Handle extends HostHandle>
  implements IHostStore<Handle> {
  db: IDBPDatabase<any>;

  constructor(db: IDBPDatabase) {
    this.db = db;
  }
  async add(info: IHostConnectionInfo<Handle>) {
    const host: IHostRow<Handle> = {
      ...info,
      lastSyncedAt: new Date(0),
    };
    await this.db.put(HOSTS_TABLE, host);
  }

  async get(label: string) {
    return (await this.db.get(HOSTS_TABLE, label)) as IHostRow<Handle> | undefined;
  }

  async del(label: string) {
    await this.db.delete(HOSTS_TABLE, label);
  }

  async list() {
    return (await this.db.getAll(HOSTS_TABLE)) as IHostRow<Handle>[];
  }

  async wipe() {
    await this.db.clear(HOSTS_TABLE);
  }
}
