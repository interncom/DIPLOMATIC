// IndexedDB implementation of EntDB.
// EntDB "renders" a final database state from deltas encoded as IMessages.

import { Status } from "../shared/consts";
import { EntityID, GroupID, IOp } from "../shared/types";
import { err, ok, ValStat } from "../shared/valstat.ts";
import { applyOp, EntitiesQuery, IEntDB, IEntity } from "./entdb";
import { b64tob, btob64 } from "../shared/binary";

export const entityTableName = "entities";
export const typeIndexName = "entity_type_created_at";
export const typeUpdatedAtIndexName = "entity_type_updated_at";
export const typeGroupIndexName = "entity_type_group_id";
export const typeParentIndexName = "entity_type_parent_id";

interface IStoredEntity<T = unknown> {
  bod: T;
  crd: Date; // createdAt
  ctr?: number;
  eid: string;
  gid?: string;
  pid?: string;
  typ: string;
  upd: Date; // updatedAt
}

function entityToStored<T>(ent: IEntity<T>): IStoredEntity<T> {
  const stored: IStoredEntity<T> = {
    bod: ent.body,
    crd: ent.createdAt,
    ...(ent.ctr !== 0 ? { ctr: ent.ctr } : {}),
    eid: btob64(ent.eid),
    gid: ent.gid,
    pid: ent.pid ? btob64(ent.pid) : undefined,
    typ: ent.type,
    upd: ent.updatedAt,
  };
  // NOTE: IndexedDB *will* store undefined attributes unless deleted. Wasteful.
  if (stored.gid === undefined) {
    delete stored.gid;
  }
  if (stored.pid === undefined) {
    delete stored.pid;
  }
  if (stored.ctr === undefined) {
    delete stored.ctr;
  }
  return stored;
}

function storedToEntity<T>(
  stored: IStoredEntity<T>,
): IEntity<T> {
  return {
    body: stored.bod,
    createdAt: stored.crd,
    updatedAt: stored.upd,
    ctr: stored.ctr ?? 0,
    type: stored.typ,
    eid: b64tob(stored.eid) as EntityID,
    gid: stored.gid,
    pid: stored.pid ? b64tob(stored.pid) as EntityID : undefined,
  };
}

export class EntIDB implements IEntDB {
  db: IDBDatabase | undefined;

  async init() {
    this.db = await new Promise((resolve, reject) => {
      const req = indexedDB.open("db", 11);
      req.onupgradeneeded = () => {
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
          store.createIndex(typeIndexName, ["typ", "crd"], {
            unique: false,
          });
        }
        if (!store.indexNames.contains(typeUpdatedAtIndexName)) {
          store.createIndex(typeUpdatedAtIndexName, ["typ", "upd"], {
            unique: false,
          });
        }
        if (!store.indexNames.contains(typeGroupIndexName)) {
          store.createIndex(typeGroupIndexName, ["typ", "gid"], {
            unique: false,
          });
        }
        if (!store.indexNames.contains(typeParentIndexName)) {
          store.createIndex(typeParentIndexName, ["typ", "pid"], {
            unique: false,
          });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  apply = async (ops: IOp[]) => {
    if (!this.db) {
      return ops.map(() => Status.DatabaseClosed);
    }
    const tx = this.db.transaction(entityTableName, "readwrite");
    const store = tx.objectStore(entityTableName);
    return new Promise<Status[]>((resolve) => {
      const results: Status[] = new Array(ops.length).fill(Status.Success);
      if (ops.length < 1) {
        resolve([]);
        return;
      }

      tx.oncomplete = () => {
        resolve(results);
      };
      tx.onerror = () => {
        for (let i = 0; i < results.length; i++) {
          if (results[i] === undefined) {
            results[i] = Status.DatabaseError;
          }
        }
        resolve(results);
      };

      // Group ops by eidB64.
      // We do this in case multiple ops in this batch mutate the same ent.
      // If so, we run the updates in-memory then persist the final state.
      // Without it, IndexedDB was getting mixed-up, due to key collisions.
      const groups = new Map<string, { op: IOp; index: number }[]>();
      for (let i = 0; i < ops.length; i++) {
        const op = ops[i];
        const eidB64 = btob64(op.eid);
        const item = { op, index: i };
        const group = groups.get(eidB64);
        if (group) {
          group.push(item);
        } else {
          groups.set(eidB64, [item]);
        }
      }

      // Run the per-group updates in-memory then persist the final state.
      for (const [eidB64, group] of groups) {
        if (group.length < 1) {
          continue;
        }

        const getReq = store.get(eidB64);
        getReq.onsuccess = () => {
          const currStored = getReq.result;
          let curr: IEntity | undefined = currStored
            ? storedToEntity(currStored)
            : undefined;

          // Sequentially apply applyOp for each op in the group.
          for (const { op, index } of group) {
            const [next, stat] = applyOp(curr, op);
            if (stat !== Status.Success) {
              // NOTE: this includes Status.NoChange.
              results[index] = stat;
              continue;
            }
            curr = next;
          }

          // Persist the final state of the ent if it exists, otherwise delete.
          if (curr) {
            const storedEnt = entityToStored(curr);
            const putReq = store.put(storedEnt);
            putReq.onerror = (evt) => {
              evt.preventDefault();
              for (const { index } of group) {
                results[index] = Status.DatabaseError;
              }
            };
          } else {
            // Undefined indicates it was deleted.
            const delReq = store.delete(eidB64);
            delReq.onerror = () => {
              for (const { index } of group) {
                results[index] = Status.DatabaseError;
              }
            };
          }
        };

        getReq.onerror = () => {
          for (const { index } of group) {
            results[index] = Status.DatabaseError;
          }
        };
      }
    });
  };

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
    const eidHex = btob64(eid);
    const tx = this.db.transaction(entityTableName, "readonly");
    const store = tx.objectStore(entityTableName);
    return new Promise((resolve) => {
      const req = store.get(eidHex);
      req.onsuccess = () => {
        const stored = req.result;
        if (!stored) {
          resolve(ok(undefined));
        } else {
          const ent = storedToEntity<T>(stored);
          resolve(ok(ent));
        }
      };
      req.onerror = () => resolve(err(Status.DatabaseError));
    });
  }

  async getAllOfTypeUpdatedBetween<T>(
    opType: string,
    start: Date,
    end: Date,
  ): Promise<ValStat<IEntity<T>[]>> {
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
  ): Promise<ValStat<IEntity<T>[]>> {
    if (!this.db) {
      return err(Status.DatabaseClosed);
    }
    const tx = this.db.transaction(entityTableName, "readonly");
    const index = tx.objectStore(entityTableName).index(typeGroupIndexName);
    return new Promise((resolve) => {
      const req = index.getAll(IDBKeyRange.only([opType, gid]));
      req.onsuccess = () => {
        const storedEnts = req.result as IStoredEntity<T>[];
        resolve(ok(storedEnts.map(storedToEntity)));
      };
      req.onerror = () => resolve(err(Status.DatabaseError));
    });
  }

  async getAllOfType<T>(
    opType: string,
  ): Promise<ValStat<IEntity<T>[]>> {
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
  ): Promise<ValStat<IEntity<T>[]>> {
    if (!this.db) {
      return err(Status.DatabaseClosed);
    }
    if (pid !== undefined) {
      const pidB64 = btob64(pid);
      const tx = this.db.transaction(entityTableName, "readonly");
      const index = tx.objectStore(entityTableName).index(typeParentIndexName);
      return new Promise((resolve) => {
        const req = index.getAll(IDBKeyRange.only([type, pidB64]));
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
    return ok(ents);
  }

  async countEntities({ type }: { type: string }): Promise<ValStat<number>> {
    if (!this.db) {
      return err(Status.DatabaseClosed);
    }
    const tx = this.db.transaction(entityTableName, "readonly");
    const index = tx.objectStore(entityTableName).index(typeIndexName);
    return new Promise((resolve) => {
      const range = IDBKeyRange.bound([type], [type, []]);
      const req = index.count(range);
      req.onsuccess = () => resolve(ok(req.result));
      req.onerror = () => resolve(err(Status.DatabaseError));
    });
  }
}
