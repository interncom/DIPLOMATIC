// IndexedDB implementation of EntDB.
// EntDB "renders" a final database state from deltas encoded as IMessages.

import { type DBSchema, IDBPDatabase, openDB } from "idb";
import { Status } from "../shared/consts";
import { EntityID, GroupID, IOp, ValStat } from "../shared/types";
import { EntitiesQuery, IEntDB, IEntity, updateEnt } from "./entdb";
import { btoh, htob } from "../shared/binary";

export const entityTableName = "entities";
export const typeIndexName = "entity_type_created_at";
export const typeUpdatedAtIndexName = "entity_type_updated_at";
export const typeGroupIndexName = "entity_type_group_id";
export const typeParentIndexName = "entity_type_parent_id";

interface IStoredEntity<T = unknown> {
  eid: string;
  gid?: string;
  pid?: string;
  type: string;
  updatedAt: Date;
  updatedCtr: number;
  createdAt: Date;
  body: T;
}

function entityToStored<T>(ent: IEntity<T>): IStoredEntity<T> {
  return {
    ...ent,
    eid: btoh(ent.eid),
    gid: ent.gid
      ? (typeof ent.gid === "string" ? ent.gid : btoh(ent.gid))
      : undefined,
    pid: ent.pid ? btoh(ent.pid) : undefined,
  };
}

function storedToEntity<T>(stored: IStoredEntity<T>): IEntity<T> {
  return {
    ...stored,
    eid: htob(stored.eid),
    gid: stored.gid
      ? (stored.gid.length === 64 ? htob(stored.gid) : stored.gid)
      : undefined,
    pid: stored.pid ? htob(stored.pid) : undefined,
  };
}

interface IEntityDB extends DBSchema {
  [entityTableName]: {
    key: string;
    value: IStoredEntity<unknown>;
    indexes: {
      [typeIndexName]: [string, Date];
      [typeUpdatedAtIndexName]: [string, Date];
      [typeGroupIndexName]: [string, string];
      [typeParentIndexName]: [string, string];
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

  async apply(op: IOp) {
    if (!this.db) {
      return Status.DatabaseClosed;
    }
    const currHex = btoh(op.eid);
    const currStored = await this.db.get(entityTableName, currHex);
    const curr = currStored ? storedToEntity(currStored) : undefined;
    const [ent, stat] = updateEnt(curr, op);
    if (stat !== Status.Success) {
      return stat;
    }
    const storedEnt = entityToStored(ent);
    await this.db.put(entityTableName, storedEnt);
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
    const eidHex = btoh(eid);
    const stored = await this.db.get(entityTableName, eidHex);
    if (!stored) {
      return [undefined, Status.Success];
    }
    const ent = storedToEntity(stored as IStoredEntity<T>);
    return [ent, Status.Success];
  }

  async getAllOfTypeUpdatedBetween<T>(
    opType: string,
    start: Date,
    end: Date,
  ): Promise<IEntity<T>[]> {
    if (!this.db) {
      return [];
    }
    const storedEnts = await this.db.getAllFromIndex(
      entityTableName,
      typeUpdatedAtIndexName,
      IDBKeyRange.bound([opType, start], [opType, end]),
    ) as IStoredEntity<T>[];
    return storedEnts.map(storedToEntity);
  }

  async getGroupMembers<T>(
    opType: string,
    gid: GroupID,
  ): Promise<IEntity<T>[]> {
    if (!this.db) {
      return [];
    }
    const gidHex = typeof gid === "string" ? gid : btoh(gid);
    const storedEnts = await this.db.getAllFromIndex(
      entityTableName,
      typeGroupIndexName,
      IDBKeyRange.only([opType, gidHex]),
    ) as IStoredEntity<T>[];
    return storedEnts.map(storedToEntity);
  }

  async getAllOfType<T>(opType: string): Promise<IEntity<T>[]> {
    if (!this.db) {
      return [];
    }
    const storedEnts = await this.db.getAllFromIndex(
      entityTableName,
      typeIndexName,
      IDBKeyRange.bound([opType], [opType, new Date(Infinity)]),
    ) as IStoredEntity<T>[];
    return storedEnts.map(storedToEntity);
  }

  async getEntities<T>(
    { type, gid, pid, updatedBetween }: EntitiesQuery,
  ): Promise<ValStat<IEntity<T>[]>> {
    if (!this.db) {
      return [[], Status.DatabaseClosed];
    }
    if (pid !== undefined) {
      const pidHex = btoh(pid);
      const storedEnts = await this.db.getAllFromIndex(
        entityTableName,
        typeParentIndexName,
        IDBKeyRange.only([type, pidHex]),
      ) as IStoredEntity<T>[];
      const ents = storedEnts.map(storedToEntity);
      return [ents, Status.Success];
    } else if (gid !== undefined) {
      const ents = await this.getGroupMembers<T>(type, gid);
      return [ents, Status.Success];
    } else if (updatedBetween !== undefined) {
      const ents = await this.getAllOfTypeUpdatedBetween<T>(
        type,
        updatedBetween.start,
        updatedBetween.end,
      );
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
      IDBKeyRange.bound([type], [type, new Date(Infinity)]),
    );
    return [count, Status.Success];
  }
}
