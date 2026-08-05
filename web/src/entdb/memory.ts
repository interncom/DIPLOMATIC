// In-memory implementation of EntDB.
// EntDB "renders" a final database state from deltas encoded as IMessages.

import { applyOp, IEntDB, IEntity } from "./entdb";
import { btob64, bytesEqual } from "../shared/binary";
import { Status } from "../shared/consts";
import { EntityID, GroupID, IOp } from "../shared/types";
import { err, ok, ValStat } from "../shared/valstat.ts";

interface IDateRange {
  start: Date;
  end: Date;
}

type EntitiesQuery = {
  type: string;
  gid?: GroupID;
  pid?: EntityID;
  tag?: string;
  updatedBetween?: IDateRange;
};

/** Options for {@link EntDBMemory}. */
export type EntDBMemoryOptions = {
  /**
   * Secondary type / type+pid / type+gid / type+tag indexes for list queries.
   * Default true. Disable only if you need to save the index memory.
   */
  indexes?: boolean;
};

/**
 * eidKey → entity within one type (or one type+parent / type+group bucket).
 * Map (not array) so put/del stay O(1).
 */
type EntBucket = Map<string, IEntity>;

export class EntDBMemory implements IEntDB {
  ents: Map<string, IEntity> = new Map();

  private readonly useIndex: boolean;
  /** type → eidKey → ent */
  private byType = new Map<string, EntBucket>();
  /** type → pidKey → eidKey → ent */
  private byTypePid = new Map<string, Map<string, EntBucket>>();
  /** type → gid → eidKey → ent */
  private byTypeGid = new Map<string, Map<string, EntBucket>>();
  /** type → tag → eidKey → ent */
  private byTypeTag = new Map<string, Map<string, EntBucket>>();

  constructor(initEnts: IEntity[] = [], opts?: EntDBMemoryOptions) {
    this.useIndex = opts?.indexes !== false;
    for (const ent of initEnts) {
      this.put(ent);
    }
  }

  /** Install or replace an entity; keeps secondary indexes in sync. */
  put(ent: IEntity): void {
    const key = btob64(ent.eid);
    const prev = this.ents.get(key);
    if (prev) {
      this.unindex(key, prev);
    }
    this.ents.set(key, ent);
    this.index(key, ent);
  }

  /** Remove by eid key; keeps secondary indexes in sync. */
  del(key: string): void {
    const prev = this.ents.get(key);
    if (!prev) {
      return;
    }
    this.unindex(key, prev);
    this.ents.delete(key);
  }

  private index(key: string, ent: IEntity): void {
    if (!this.useIndex) {
      return;
    }
    let typeBucket = this.byType.get(ent.type);
    if (!typeBucket) {
      typeBucket = new Map();
      this.byType.set(ent.type, typeBucket);
    }
    typeBucket.set(key, ent);

    if (ent.pid) {
      const pk = btob64(ent.pid);
      let byPid = this.byTypePid.get(ent.type);
      if (!byPid) {
        byPid = new Map();
        this.byTypePid.set(ent.type, byPid);
      }
      let pidBucket = byPid.get(pk);
      if (!pidBucket) {
        pidBucket = new Map();
        byPid.set(pk, pidBucket);
      }
      pidBucket.set(key, ent);
    }

    if (typeof ent.gid === "string") {
      let byGid = this.byTypeGid.get(ent.type);
      if (!byGid) {
        byGid = new Map();
        this.byTypeGid.set(ent.type, byGid);
      }
      let gidBucket = byGid.get(ent.gid);
      if (!gidBucket) {
        gidBucket = new Map();
        byGid.set(ent.gid, gidBucket);
      }
      gidBucket.set(key, ent);
    }

    if (ent.tags) {
      let byTag = this.byTypeTag.get(ent.type);
      if (!byTag) {
        byTag = new Map();
        this.byTypeTag.set(ent.type, byTag);
      }
      for (const tag of ent.tags) {
        let tagBucket = byTag.get(tag);
        if (!tagBucket) {
          tagBucket = new Map();
          byTag.set(tag, tagBucket);
        }
        tagBucket.set(key, ent);
      }
    }
  }

  private unindex(key: string, ent: IEntity): void {
    if (!this.useIndex) {
      return;
    }
    const typeBucket = this.byType.get(ent.type);
    if (typeBucket) {
      typeBucket.delete(key);
      if (typeBucket.size === 0) {
        this.byType.delete(ent.type);
      }
    }

    if (ent.pid) {
      const pk = btob64(ent.pid);
      const byPid = this.byTypePid.get(ent.type);
      const pidBucket = byPid?.get(pk);
      if (pidBucket) {
        pidBucket.delete(key);
        if (pidBucket.size === 0) {
          byPid?.delete(pk);
        }
      }
      if (byPid && byPid.size === 0) {
        this.byTypePid.delete(ent.type);
      }
    }

    if (typeof ent.gid === "string") {
      const byGid = this.byTypeGid.get(ent.type);
      const gidBucket = byGid?.get(ent.gid);
      if (gidBucket) {
        gidBucket.delete(key);
        if (gidBucket.size === 0) {
          byGid?.delete(ent.gid);
        }
      }
      if (byGid && byGid.size === 0) {
        this.byTypeGid.delete(ent.type);
      }
    }

    if (ent.tags) {
      const byTag = this.byTypeTag.get(ent.type);
      if (byTag) {
        for (const tag of ent.tags) {
          const tagBucket = byTag.get(tag);
          if (tagBucket) {
            tagBucket.delete(key);
            if (tagBucket.size === 0) {
              byTag.delete(tag);
            }
          }
        }
        if (byTag.size === 0) {
          this.byTypeTag.delete(ent.type);
        }
      }
    }
  }

  private clearIndexes(): void {
    this.byType.clear();
    this.byTypePid.clear();
    this.byTypeGid.clear();
    this.byTypeTag.clear();
  }

  private bucketList<T>(bucket: EntBucket | undefined): IEntity<T>[] {
    if (!bucket || bucket.size === 0) {
      return [];
    }
    const out: IEntity<T>[] = [];
    for (const ent of bucket.values()) {
      out.push(ent as IEntity<T>);
    }
    return out;
  }

  async apply(ops: IOp[]) {
    const types = new Set<string>();
    const eids: EntityID[] = [];
    const results: Status[] = [];
    for (const op of ops) {
      const key = btob64(op.eid);
      const curr = this.ents.get(key);
      const [next, stat] = applyOp(curr, op);
      if (stat !== Status.Success) {
        results.push(stat);
        continue;
      }
      if (next) {
        types.add(next.type);
      } else if (curr) {
        types.add(curr.type);
      }
      if (next) {
        this.put(next);
      } else {
        this.del(key);
      }
      eids.push(op.eid);
      results.push(Status.Success);
    }
    return { stats: results, types, eids };
  }

  async clear(): Promise<Status> {
    this.ents.clear();
    this.clearIndexes();
    return Status.Success;
  }

  async getEnt<T>(
    eid: EntityID,
  ): Promise<ValStat<IEntity<T> | undefined>> {
    const key = btob64(eid);
    const ent = this.ents.get(key);
    return ok(ent as IEntity<T> | undefined);
  }

  private async getAllEntities<T>(
    { type, gid, pid, tag, updatedBetween }: EntitiesQuery,
  ): Promise<ValStat<IEntity<T>[]>> {
    if (this.useIndex) {
      if (pid !== undefined) {
        const pk = btob64(pid);
        return ok(this.bucketList<T>(this.byTypePid.get(type)?.get(pk)));
      }
      if (gid !== undefined) {
        return ok(this.bucketList<T>(this.byTypeGid.get(type)?.get(gid)));
      }
      if (tag !== undefined) {
        return ok(this.bucketList<T>(this.byTypeTag.get(type)?.get(tag)));
      }
      if (updatedBetween !== undefined) {
        const results: IEntity<T>[] = [];
        const typeBucket = this.byType.get(type);
        if (typeBucket) {
          for (const ent of typeBucket.values()) {
            if (
              ent.updatedAt >= updatedBetween.start &&
              ent.updatedAt <= updatedBetween.end
            ) {
              results.push(ent as IEntity<T>);
            }
          }
        }
        return ok(results);
      }
      return ok(this.bucketList<T>(this.byType.get(type)));
    }

    // Full-map scan (indexes disabled).
    const results: IEntity<T>[] = [];
    if (pid !== undefined) {
      for (const ent of this.ents.values()) {
        if (ent.type === type && ent.pid && bytesEqual(ent.pid, pid)) {
          results.push(ent as IEntity<T>);
        }
      }
    } else if (gid !== undefined) {
      for (const ent of this.ents.values()) {
        if (
          ent.type === type && (typeof ent.gid === "string" && ent.gid === gid)
        ) {
          results.push(ent as IEntity<T>);
        }
      }
    } else if (tag !== undefined) {
      for (const ent of this.ents.values()) {
        if (ent.type === type && ent.tags && ent.tags.includes(tag)) {
          results.push(ent as IEntity<T>);
        }
      }
    } else if (updatedBetween !== undefined) {
      for (const ent of this.ents.values()) {
        if (
          ent.type === type && ent.updatedAt >= updatedBetween.start &&
          ent.updatedAt <= updatedBetween.end
        ) {
          results.push(ent as IEntity<T>);
        }
      }
    } else {
      for (const ent of this.ents.values()) {
        if (ent.type === type) {
          results.push(ent as IEntity<T>);
        }
      }
    }
    return ok(results);
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
    if (this.useIndex) {
      return ok(this.byType.get(type)?.size ?? 0);
    }
    let count = 0;
    for (const ent of this.ents.values()) {
      if (ent.type === type) {
        count += 1;
      }
    }
    return ok(count);
  }
}
