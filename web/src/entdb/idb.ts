// IndexedDB implementation of EntDB.
// EntDB "renders" a final database state from deltas encoded as IMessages.

import { type DBSchema, IDBPDatabase, openDB } from "idb";
import { Status } from "../shared/consts";
import { EntityID, GroupID, INeoOp, ValStat } from "../shared/types";
import { IEntity, updateEnt, IEntDB, EntitiesQuery } from "./entdb";

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

  async getEnt<T>(eid: EntityID): Promise<ValStat<IEntity<T> | undefined>> {
    if (!this.db) {
      return [undefined, Status.DatabaseClosed];
    }
    const ent = await this.db.get(entityTableName, eid);
    return [ent as IEntity<T> | undefined, Status.Success];
  }

  async getAllOfTypeUpdatedBetween<T>(
    opType: string,
    start: Date,
    end: Date,
  ): Promise<IEntity<T>[]> {
    if (!this.db) {
      return [];
    }
    return this.db.getAllFromIndex(
      entityTableName,
      typeUpdatedAtIndexName,
      IDBKeyRange.bound([opType, start], [opType, end]),
    ) as Promise<IEntity<T>[]>;
  }

  async getGroupMembers<T>(
    opType: string,
    gid: GroupID,
  ): Promise<IEntity<T>[]> {
    if (!this.db) {
      return [];
    }
    return this.db.getAllFromIndex(
      entityTableName,
      typeGroupIndexName,
      IDBKeyRange.only([opType, gid]),
    ) as Promise<IEntity<T>[]>;
  }

  async getAllOfType<T>(opType: string): Promise<IEntity<T>[]> {
    if (!this.db) {
      return [];
    }
    return this.db.getAllFromIndex(
      entityTableName,
      typeIndexName,
      IDBKeyRange.bound([opType], [opType, []]),
    ) as Promise<IEntity<T>[]>;
  }

  async getEntities<T>({ type, gid, pid, updatedBetween }: EntitiesQuery): Promise<ValStat<IEntity<T>[]>> {
    if (!this.db) {
      return [[], Status.DatabaseClosed];
    }
    if (pid !== undefined) {
      const ents = await this.db.getAllFromIndex(
        entityTableName,
        typeParentIndexName,
        IDBKeyRange.only([type, pid]),
      ) as IEntity<T>[];
      return [ents, Status.Success];
    } else if (gid !== undefined) {
      const ents = await this.getGroupMembers<T>(type, gid);
      return [ents, Status.Success];
    } else if (updatedBetween !== undefined) {
      const ents = await this.getAllOfTypeUpdatedBetween<T>(type, updatedBetween.start, updatedBetween.end);
      return [ents, Status.Success];
    }
    const ents = await this.getAllOfType<T>(type);
    return [ents, Status.Success];
  }

  async countEntities({ type }: { type: string }): Promise<ValStat<number>> {
    if (!this.db) {
      return [0, Status.DatabaseClosed];
    }
    const count = await this.db.countFromIndex(
      entityTableName,
      typeIndexName,
      IDBKeyRange.bound([type], [type, []]),
    );
    return [count, Status.Success];
  }
}
