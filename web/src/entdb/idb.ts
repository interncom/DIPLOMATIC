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
/** multiEntry index on tags[]; query by tag then filter by type. */
export const tagsIndexName = "entity_tags";

/** Shared by main thread and sync worker — must stay in lockstep. */
export const ENT_IDB_NAME = "db";
/** v12: multiEntry tags index (entity_tags). */
export const ENT_IDB_VERSION = 12;

interface IStoredEntity<T = unknown> {
  bod: T;
  crd: Date; // createdAt
  ctr?: number;
  eid: string;
  gid?: string;
  pid?: string;
  tags?: string[];
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
    tags: ent.tags,
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
  if (stored.tags === undefined) {
    delete stored.tags;
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
    ...(stored.tags !== undefined ? { tags: stored.tags } : {}),
  };
}

export class EntIDB implements IEntDB {
  db: IDBDatabase | undefined;
  /** In-flight open; coalesces concurrent ensureDb / peer upgrade reopen. */
  private opening: Promise<IDBDatabase> | undefined;

  async init() {
    await this.ensureDb();
  }

  /**
   * Open (or reopen) the shared EntDB IDB connection.
   * Main + worker both hold connections; on versionchange we must close so the
   * peer's upgrade is not blocked forever (classic multi-connection hang).
   */
  private async ensureDb(): Promise<IDBDatabase> {
    if (this.db) {
      return this.db;
    }
    if (this.opening) {
      return this.opening;
    }
    this.opening = openEntIdbConnection().then((db) => {
      db.onversionchange = () => {
        // Let the other realm (worker/main/tab) finish schema upgrade.
        db.close();
        if (this.db === db) {
          this.db = undefined;
        }
      };
      this.db = db;
      this.opening = undefined;
      return db;
    }, (err) => {
      this.opening = undefined;
      throw err;
    });
    return this.opening;
  }

  apply = async (ops: IOp[]) => {
    const types = new Set<string>();
    const eids: EntityID[] = [];

    let db: IDBDatabase;
    try {
      db = await this.ensureDb();
    } catch {
      return {
        stats: ops.map(() => Status.DatabaseClosed),
        types,
        eids,
      };
    }
    const tx = db.transaction(entityTableName, "readwrite");
    const store = tx.objectStore(entityTableName);
    return new Promise<{
      stats: Status[];
      types: Set<string>;
      eids: EntityID[];
    }>((resolve) => {
      const results: Status[] = new Array(ops.length).fill(Status.Success);
      if (ops.length < 1) {
        resolve({ stats: [], types, eids });
        return;
      }

      tx.oncomplete = () => {
        resolve({ stats: results, types, eids });
      };
      tx.onerror = () => {
        for (let i = 0; i < results.length; i++) {
          if (results[i] === undefined) {
            results[i] = Status.DatabaseError;
          }
        }
        resolve({ stats: results, types, eids });
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
          let groupChanged = false;
          for (const { op, index } of group) {
            const [next, stat] = applyOp(curr, op);
            if (stat !== Status.Success) {
              // NOTE: this includes Status.NoChange.
              results[index] = stat;
              continue;
            }
            groupChanged = true;
            if (next) {
              types.add(next.type);
            } else if (curr) {
              types.add(curr.type);
            }
            curr = next;
          }
          if (groupChanged) {
            eids.push(group[0].op.eid);
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
    let db: IDBDatabase;
    try {
      db = await this.ensureDb();
    } catch {
      return Status.DatabaseClosed;
    }
    const tx = db.transaction(entityTableName, "readwrite");
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
    let db: IDBDatabase;
    try {
      db = await this.ensureDb();
    } catch {
      return err(Status.DatabaseClosed);
    }
    const eidHex = btob64(eid);
    const tx = db.transaction(entityTableName, "readonly");
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
    let db: IDBDatabase;
    try {
      db = await this.ensureDb();
    } catch {
      return err(Status.DatabaseClosed);
    }
    const tx = db.transaction(entityTableName, "readonly");
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
    let db: IDBDatabase;
    try {
      db = await this.ensureDb();
    } catch {
      return err(Status.DatabaseClosed);
    }
    const tx = db.transaction(entityTableName, "readonly");
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
    let db: IDBDatabase;
    try {
      db = await this.ensureDb();
    } catch {
      return err(Status.DatabaseClosed);
    }
    const tx = db.transaction(entityTableName, "readonly");
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

  async getByTag<T>(
    opType: string,
    tag: string,
  ): Promise<ValStat<IEntity<T>[]>> {
    let db: IDBDatabase;
    try {
      db = await this.ensureDb();
    } catch {
      return err(Status.DatabaseClosed);
    }
    const tx = db.transaction(entityTableName, "readonly");
    const index = tx.objectStore(entityTableName).index(tagsIndexName);
    return new Promise((resolve) => {
      const req = index.getAll(IDBKeyRange.only(tag));
      req.onsuccess = () => {
        const storedEnts = req.result as IStoredEntity<T>[];
        // multiEntry index is tag-only; keep type filter (same API as pid/gid).
        const ents = storedEnts
          .filter((s) => s.typ === opType)
          .map(storedToEntity);
        resolve(ok(ents));
      };
      req.onerror = () => resolve(err(Status.DatabaseError));
    });
  }

  private async getAllEntities<T>(
    query: EntitiesQuery,
  ): Promise<ValStat<IEntity<T>[]>> {
    if ("pid" in query) {
      let db: IDBDatabase;
      try {
        db = await this.ensureDb();
      } catch {
        return err(Status.DatabaseClosed);
      }
      const pidB64 = btob64(query.pid);
      const tx = db.transaction(entityTableName, "readonly");
      const index = tx.objectStore(entityTableName).index(typeParentIndexName);
      return new Promise((resolve) => {
        const req = index.getAll(IDBKeyRange.only([query.type, pidB64]));
        req.onsuccess = () => {
          const storedEnts = req.result as IStoredEntity<T>[];
          const ents = storedEnts.map(storedToEntity);
          resolve(ok(ents));
        };
        req.onerror = () => resolve(err(Status.DatabaseError));
      });
    } else if ("gid" in query) {
      return await this.getGroupMembers<T>(query.type, query.gid);
    } else if ("tag" in query) {
      return await this.getByTag<T>(query.type, query.tag);
    } else if ("updatedBetween" in query) {
      return await this.getAllOfTypeUpdatedBetween<T>(
        query.type,
        query.updatedBetween.start,
        query.updatedBetween.end,
      );
    }
    return await this.getAllOfType<T>(query.type);
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
    let db: IDBDatabase;
    try {
      db = await this.ensureDb();
    } catch {
      return err(Status.DatabaseClosed);
    }
    const tx = db.transaction(entityTableName, "readonly");
    const index = tx.objectStore(entityTableName).index(typeIndexName);
    return new Promise((resolve) => {
      const range = IDBKeyRange.bound([type], [type, []]);
      const req = index.count(range);
      req.onsuccess = () => resolve(ok(req.result));
      req.onerror = () => resolve(err(Status.DatabaseError));
    });
  }
}

function upgradeEntIdb(db: IDBDatabase, tx: IDBTransaction) {
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
  // multiEntry on array keyPath only (IDB forbids multiEntry + compound
  // keyPath). Lookup by tag, then filter typ in app code.
  if (!store.indexNames.contains(tagsIndexName)) {
    store.createIndex(tagsIndexName, "tags", {
      unique: false,
      multiEntry: true,
    });
  }
}

function openEntIdbConnection(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(ENT_IDB_NAME, ENT_IDB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      const tx = req.transaction;
      if (!tx) {
        reject(new Error("Transaction is null during EntDB upgrade"));
        return;
      }
      try {
        upgradeEntIdb(db, tx);
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    };
    req.onblocked = () => {
      // Another main/worker/tab connection has not closed yet. We wait until
      // their onversionchange handler closes; without that, open hangs forever.
      console.warn(
        "[DIPLOMATIC] EntDB IDB upgrade blocked " +
          `(${ENT_IDB_NAME} → v${ENT_IDB_VERSION}); ` +
          "waiting for other connections to close",
      );
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () =>
      reject(req.error ?? new Error("EntDB IndexedDB open failed"));
  });
}

/** Durable IndexedDB EntDB. Internal-only. Apps use {@link openEntDB} instead. */
export async function openEntIDB() {
  const entDB = new EntIDB();
  await entDB.init();
  return entDB;
}
