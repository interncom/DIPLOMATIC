// IndexedDB implementation of EntDB.
// EntDB "renders" a final database state from deltas encoded as IMessages.

import { type DBSchema, IDBPDatabase, openDB } from "idb";
import { Status } from "../shared/consts";
import { EntityID, GroupID, INeoOp } from "../shared/types";
import { IEntDB } from "../types";
import { IEntity, updateEnt } from "./entdb";

export const entityTableName = "entities";
export const typeIndexName = "entity_type_created_at";
export const typeUpdatedAtIndexName = "entity_type_updated_at";
export const typeGroupIndexName = "entity_type_group_id";
export const typeParentIndexName = "entity_type_parent_id";

interface IEntityDB extends DBSchema {
  [entityTableName]: {
    key: Uint8Array; // TODO: try Uint8Array;
    value: IEntity<unknown>;
    indexes: {
      [typeIndexName]: [string, Date];
      [typeUpdatedAtIndexName]: [string, Date];
      [typeGroupIndexName]: [string, GroupID];
      [typeParentIndexName]: [string, EntityID];
    };
  };
}

export class EntIDB implements IEntDB {
  db: IDBPDatabase<IEntityDB> | undefined;

  async init() {
    this.db = await openDB<IEntityDB>("db", 10, {
      upgrade(db, prevVersion, currVersion, tx) {
        if (!db.objectStoreNames.contains(entityTableName)) {
          db.createObjectStore(entityTableName, {
            keyPath: "eid",
            autoIncrement: false,
          });
        }
        const store = tx.objectStore(entityTableName);
        if (!store.indexNames.contains(typeIndexName)) {
          store.createIndex(typeIndexName, ["type", "createdAt"], {
            unique: false,
          });
        }
        if (!store.indexNames.contains(typeUpdatedAtIndexName)) {
          store.createIndex(typeUpdatedAtIndexName, ["type", "updatedAt"], {
            unique: false,
          });
        }
        if (!store.indexNames.contains(typeGroupIndexName)) {
          store.createIndex(typeGroupIndexName, ["type", "gid"], {
            unique: false,
          });
        }
        if (!store.indexNames.contains(typeParentIndexName)) {
          store.createIndex(typeParentIndexName, ["type", "pid"], {
            unique: false,
          });
        }
      },
    });
  }

  async getByEID(eid: EntityID): Promise<[IEntity<unknown> | undefined, Status]> {
    if (!this.db) {
      return [undefined, Status.DatabaseClosed];
    }
    const ent = await this.db.get(entityTableName, eid);
    return [ent, Status.Success];
  }

  async getByGID(gid: GroupID): Promise<[Iterable<IEntity<unknown>>, Status]> {
    if (!this.db) {
      return [[], Status.DatabaseClosed];
    }
    return [ents, Status.Success];
  }

  async getByPID(pid: EntityID): Promise<[Iterable<IEntity<unknown>>, Status]> {
    if (!this.db) {
      return [[], Status.DatabaseClosed];
    }
  }

  async getByType(type: string): Promise<[Iterable<IEntity<unknown>>, Status]> {
    if (!this.db) {
      return [[], Status.DatabaseClosed];
    }
  }

  async apply(op: INeoOp) {
    if (!this.db) {
      return Status.DatabaseClosed;
    }
    const curr = await this.db.get(entityTableName, op.eid);
    const [ent, stat] = updateEnt(curr, op);
    if (stat !== Status.Success) {
      return stat;
    }
    await this.db.put(entityTableName, ent, op.eid);
    return Status.Success;
  }

  async clear() {
    if (!this.db) {
      return Status.DatabaseClosed;
    }
    await this.db.clear(entityTableName);
    return Status.Success;
  }
}
