// IndexedDB implementation of EntDB.
// EntDB "renders" a final database state from deltas encoded as IMessages.

import { Status } from "../shared/consts";
import { EntityID, GroupID, IOp } from "../shared/types";
import { err, ok, ValStat } from "../shared/valstat.ts";
import { EntitiesQuery, IEntDB, IEntity, IPossiblyDeletedEntity, isLiveEntity, updateEnt } from "./entdb";
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
  ctr: number;
  createdAt: Date;
  body?: T;
}

function entityToStored<T>(ent: IPossiblyDeletedEntity<T>): IStoredEntity<T> {
  return {
    ...ent,
    body: ent.body,
    ctr: ent.ctr,
    eid: btoh(ent.eid),
    gid: ent.gid
      ? (typeof ent.gid === "string" ? ent.gid : btoh(ent.gid))
      : undefined,
    pid: ent.pid ? btoh(ent.pid) : undefined,
  };
}

function storedToEntity<T>(stored: IStoredEntity<T>): IPossiblyDeletedEntity<T> {
  return {
    ...stored,
    eid: htob(stored.eid) as EntityID,
    gid: stored.gid
      ? (stored.gid.length === 64 ? htob(stored.gid) : stored.gid)
      : undefined,
    pid: stored.pid ? htob(stored.pid) as EntityID : undefined,
  };
}

export class EntIDB implements IEntDB {
  db: IDBDatabase | undefined;

  async init() {
    this.db = await new Promise((resolve, reject) => {
      const req = indexedDB.open("db", 10);
      req.onupgradeneeded = (event) => {
        const db = req.result;
        const tx = req.transaction;
        if (!tx) {
          throw new Error("Transaction is null during upgrade");
        }
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
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  apply = async (op: IOp) => {
    if (!this.db) {
      return Status.DatabaseClosed;
    }
    const currHex = btoh(op.eid);
    const tx = this.db.transaction(entityTableName, "readwrite");
    const store = tx.objectStore(entityTableName);
    return new Promise<Status>((resolve) => {
      tx.oncomplete = () => resolve(Status.Success);
      tx.onerror = () => resolve(Status.DatabaseError);
      const getReq = store.get(currHex);
      getReq.onsuccess = () => {
        const currStored = getReq.result;
        const curr = currStored ? storedToEntity(currStored) : undefined;
        const [ent, stat] = updateEnt(curr, op);
        if (stat !== Status.Success) {
          resolve(stat);
          return;
        }
        const storedEnt = entityToStored(ent);
        store.put(storedEnt);
      };
      getReq.onerror = () => resolve(Status.DatabaseError);
    });
  }

  async clear() {
    if (!this.db) {
      return Status.DatabaseClosed;
    }
    const tx = this.db.transaction(entityTableName, "readwrite");
    const store = tx.objectStore(entityTableName);
    return new Promise<Status>((resolve) => {
      tx.oncomplete = () => resolve(Status.Success);
      tx.onerror = () => resolve(Status.DatabaseError);
      store.clear();
    });
  }

  async getEnt<T>(
    eid: EntityID,
  ): Promise<ValStat<IEntity<T> | undefined>> {
    if (!this.db) {
      return err(Status.DatabaseClosed);
    }
    const eidHex = btoh(eid);
    const tx = this.db.transaction(entityTableName, "readonly");
    const store = tx.objectStore(entityTableName);
    return new Promise((resolve) => {
      const req = store.get(eidHex);
      req.onsuccess = () => {
        const stored = req.result;
        if (!stored) {
          resolve(ok(undefined));
        } else {
          const ent = storedToEntity(stored as IStoredEntity<T>);
          if (isLiveEntity(ent)) {
            resolve(ok(ent));
          } else {
            resolve(ok(undefined));
          }
        }
      };
      req.onerror = () => resolve(err(Status.DatabaseError));
    });
  }

  async getAllOfTypeUpdatedBetween<T>(
    opType: string,
    start: Date,
    end: Date,
  ): Promise<ValStat<IPossiblyDeletedEntity<T>[]>> {
    if (!this.db) {
      return err(Status.DatabaseClosed);
    }
    const tx = this.db.transaction(entityTableName, "readonly");
    const index = tx.objectStore(entityTableName).index(typeUpdatedAtIndexName);
    return new Promise((resolve) => {
      const req = index.getAll(
        IDBKeyRange.bound([opType, start], [opType, end]),
      );
      req.onsuccess = () => {
        const storedEnts = req.result as IStoredEntity<T>[];
        resolve(ok(storedEnts.map(storedToEntity)));
      };
      req.onerror = () => resolve(err(Status.DatabaseError));
    });
  }

  async getGroupMembers<T>(
    opType: string,
    gid: GroupID,
  ): Promise<ValStat<IPossiblyDeletedEntity<T>[]>> {
    if (!this.db) {
      return err(Status.DatabaseClosed);
    }
    const gidHex = typeof gid === "string" ? gid : btoh(gid);
    const tx = this.db.transaction(entityTableName, "readonly");
    const index = tx.objectStore(entityTableName).index(typeGroupIndexName);
    return new Promise((resolve) => {
      const req = index.getAll(IDBKeyRange.only([opType, gidHex]));
      req.onsuccess = () => {
        const storedEnts = req.result as IStoredEntity<T>[];
        resolve(ok(storedEnts.map(storedToEntity)));
      };
      req.onerror = () => resolve(err(Status.DatabaseError));
    });
  }

  async getAllOfType<T>(opType: string): Promise<ValStat<IPossiblyDeletedEntity<T>[]>> {
    if (!this.db) {
      return err(Status.DatabaseClosed);
    }
    const tx = this.db.transaction(entityTableName, "readonly");
    const index = tx.objectStore(entityTableName).index(typeIndexName);
    return new Promise((resolve) => {
      const req = index.getAll(
        IDBKeyRange.bound([opType], [opType, []]),
      );
      req.onsuccess = () => {
        const storedEnts = req.result as IStoredEntity<T>[];
        resolve(ok(storedEnts.map(storedToEntity)));
      };
      req.onerror = () => resolve(err(Status.DatabaseError));
    });
  }

  private async getAllEntities<T>(
    { type, gid, pid, updatedBetween }: EntitiesQuery,
  ): Promise<ValStat<IPossiblyDeletedEntity<T>[]>> {
    if (!this.db) {
      return err(Status.DatabaseClosed);
    }
    if (pid !== undefined) {
      const pidHex = btoh(pid);
      const tx = this.db.transaction(entityTableName, "readonly");
      const index = tx.objectStore(entityTableName).index(typeParentIndexName);
      return new Promise((resolve) => {
        const req = index.getAll(IDBKeyRange.only([type, pidHex]));
        req.onsuccess = () => {
          const storedEnts = req.result as IStoredEntity<T>[];
          const ents = storedEnts.map(storedToEntity);
          resolve(ok(ents));
        };
        req.onerror = () => resolve(err(Status.DatabaseError));
      });
    } else if (gid !== undefined) {
      return await this.getGroupMembers<T>(type, gid);
    } else if (updatedBetween !== undefined) {
      return await this.getAllOfTypeUpdatedBetween<T>(
        type,
        updatedBetween.start,
        updatedBetween.end,
      );
    }
    return await this.getAllOfType<T>(type);
  }

  async getEntities<T>(
    query: EntitiesQuery,
  ): Promise<ValStat<IEntity<T>[]>> {
    const [ents, stat] = await this.getAllEntities<T>(query);
    if (stat !== Status.Success) {
      return err(stat);
    }
    const liveEnts = ents.filter(isLiveEntity);
    return ok(liveEnts);
  }

  async countEntities({ type }: { type: string }): Promise<ValStat<number>> {
    if (!this.db) {
      return err(Status.DatabaseClosed);
    }
    const tx = this.db.transaction(entityTableName, "readonly");
    const index = tx.objectStore(entityTableName).index(typeIndexName);
    return new Promise((resolve) => {
      const req = index.count(
        IDBKeyRange.bound([type], [type, new Date(Infinity)]),
      );
      req.onsuccess = () => resolve(ok(req.result));
      req.onerror = () => resolve(err(Status.DatabaseError));
    });
  }
}
