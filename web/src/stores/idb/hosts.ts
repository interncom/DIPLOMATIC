import { HostHandle, IHostConnectionInfo } from "../../shared/types";
import type { IHostRow, IHostStore } from "../../types";
import { type IDBPDatabase } from "idb";

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
    await this.db.put("hosts", host);
  }

  async get(label: string) {
    return (await this.db.get("hosts", label)) as IHostRow<Handle> | undefined;
  }

  async del(label: string) {
    await this.db.delete("hosts", label);
  }

  async list() {
    return (await this.db.getAll("hosts")) as IHostRow<Handle>[];
  }

  async wipe() {
    await this.db.clear("hosts");
  }
}
