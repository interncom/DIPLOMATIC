// In-memory implementation of EntDB.
// EntDB "renders" a final database state from deltas encoded as IMessages.

import {
  applyOp,
  dateMatches,
  DateSpec,
  dateSpecMayMatch,
  EntitiesQuery,
  IEntDB,
  IEntity,
  IEntRow,
  isLiveEnt,
  revFromEntity,
  tagMatches,
  TagSpec,
  tagSpecMayMatch,
  typesChanged,
} from "./entdb";
import { btob64, bytesEqual } from "../shared/binary";
import { checksumEntRevs } from "../shared/checksum";
import { Status } from "../shared/consts";
import { EntityID, Hash, ICrypto, IOp } from "../shared/types";
import { err, ok, ValStat } from "../shared/valstat.ts";

/** Options for {@link EntDBMemory}. */
export type EntDBMemoryOptions = {
  /**
   * Secondary type / type+pid / type+tag indexes for list queries.
   * Default true. Disable only if you need to save the index memory.
   */
  indexes?: boolean;
};

/**
 * eidKey → entity within one type (or one type+parent bucket).
 * Map (not array) so put/del stay O(1). Live ents only (tombstones unindexed).
 */
type EntBucket = Map<string, IEntity>;

export class EntDBMemory implements IEntDB {
  /** Live ents and permanent tombstones. */
  ents: Map<string, IEntRow> = new Map();

  private readonly useIndex: boolean;
  /** type → eidKey → ent */
  private byType = new Map<string, EntBucket>();
  /** type → pidKey → eidKey → ent */
  private byTypePid = new Map<string, Map<string, EntBucket>>();
  /** type → tag → eidKey → ent */
  private byTypeTag = new Map<string, Map<string, EntBucket>>();

  constructor(initEnts: IEntity[] = [], opts?: EntDBMemoryOptions) {
    this.useIndex = opts?.indexes !== false;
    for (const ent of initEnts) {
      this.put(ent);
    }
  }

  /** Install or replace a row; live ents are indexed, tombstones are not. */
  put(row: IEntRow): void {
    const key = btob64(row.eid);
    const prev = this.ents.get(key);
    if (prev !== undefined && isLiveEnt(prev)) {
      this.unindex(key, prev);
    }
    this.ents.set(key, row);
    if (isLiveEnt(row)) {
      this.index(key, row);
    }
  }

  /** Remove by eid key; keeps secondary indexes in sync. */
  del(key: string): void {
    const prev = this.ents.get(key);
    if (prev === undefined) {
      return;
    }
    if (isLiveEnt(prev)) {
      this.unindex(key, prev);
    }
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

  /**
   * List by tag spec. Exact uses the tag map; range/prefix scan tag keys
   * (Map order is insertion, not lexicographic).
   */
  private byTagSpec<T>(type: string, spec: TagSpec): ValStat<IEntity<T>[]> {
    const [may, st] = tagSpecMayMatch(spec);
    if (st !== Status.Success) {
      return err(st);
    }
    if (!may) {
      return ok([]);
    }
    if (typeof spec === "string") {
      return ok(this.bucketList<T>(this.byTypeTag.get(type)?.get(spec)));
    }
    const byTag = this.byTypeTag.get(type);
    if (!byTag) {
      return ok([]);
    }
    const seen = new Set<string>();
    const out: IEntity<T>[] = [];
    for (const [tag, bucket] of byTag) {
      if (!tagMatches(tag, spec)) {
        continue;
      }
      for (const [key, ent] of bucket) {
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        out.push(ent as IEntity<T>);
      }
    }
    return ok(out);
  }

  /**
   * List by updatedAt spec. Scans the type bucket (no date secondary map).
   */
  private byDateSpec<T>(type: string, spec: DateSpec): ValStat<IEntity<T>[]> {
    const [may, st] = dateSpecMayMatch(spec);
    if (st !== Status.Success) {
      return err(st);
    }
    if (!may) {
      return ok([]);
    }
    const results: IEntity<T>[] = [];
    const typeBucket = this.byType.get(type);
    if (typeBucket) {
      for (const ent of typeBucket.values()) {
        if (dateMatches(ent.updatedAt, spec)) {
          results.push(ent as IEntity<T>);
        }
      }
    }
    return ok(results);
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
      if (next === undefined) {
        results.push(Status.InternalError);
        continue;
      }
      for (const t of typesChanged(curr, next)) {
        types.add(t);
      }
      this.put(next);
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

  async getRow<T>(
    eid: EntityID,
  ): Promise<ValStat<IEntRow<T> | undefined>> {
    const key = btob64(eid);
    const row = this.ents.get(key);
    return ok(row as IEntRow<T> | undefined);
  }

  async getEnt<T>(
    eid: EntityID,
  ): Promise<ValStat<IEntity<T> | undefined>> {
    const [row, st] = await this.getRow<T>(eid);
    if (st !== Status.Success) {
      return err(st);
    }
    if (row === undefined || !isLiveEnt(row)) {
      return ok(undefined);
    }
    return ok(row);
  }

  private async getAllEntities<T>(
    query: EntitiesQuery,
  ): Promise<ValStat<IEntity<T>[]>> {
    const { type } = query;
    if (this.useIndex) {
      if ("pid" in query) {
        const pk = btob64(query.pid);
        return ok(this.bucketList<T>(this.byTypePid.get(type)?.get(pk)));
      }
      if ("tag" in query) {
        return this.byTagSpec<T>(type, query.tag);
      }
      if ("updatedAt" in query) {
        return this.byDateSpec<T>(type, query.updatedAt);
      }
      return ok(this.bucketList<T>(this.byType.get(type)));
    }

    // Full-map scan (indexes disabled). Live only.
    const results: IEntity<T>[] = [];
    if ("pid" in query) {
      for (const row of this.ents.values()) {
        if (
          isLiveEnt(row) && row.type === type && row.pid &&
          bytesEqual(row.pid, query.pid)
        ) {
          results.push(row as IEntity<T>);
        }
      }
    } else if ("tag" in query) {
      const spec = query.tag;
      const [may, st] = tagSpecMayMatch(spec);
      if (st !== Status.Success) {
        return err(st);
      }
      if (!may) {
        return ok(results);
      }
      for (const row of this.ents.values()) {
        if (
          isLiveEnt(row) && row.type === type && row.tags &&
          row.tags.some((t) => tagMatches(t, spec))
        ) {
          results.push(row as IEntity<T>);
        }
      }
    } else if ("updatedAt" in query) {
      const spec = query.updatedAt;
      const [may, st] = dateSpecMayMatch(spec);
      if (st !== Status.Success) {
        return err(st);
      }
      if (!may) {
        return ok(results);
      }
      for (const row of this.ents.values()) {
        if (
          isLiveEnt(row) && row.type === type &&
          dateMatches(row.updatedAt, spec)
        ) {
          results.push(row as IEntity<T>);
        }
      }
    } else {
      for (const row of this.ents.values()) {
        if (isLiveEnt(row) && row.type === type) {
          results.push(row as IEntity<T>);
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
    for (const row of this.ents.values()) {
      if (isLiveEnt(row) && row.type === type) {
        count += 1;
      }
    }
    return ok(count);
  }

  async checksum(crypto: ICrypto): Promise<ValStat<Hash>> {
    const revs = [];
    for (const row of this.ents.values()) {
      revs.push(revFromEntity(row));
    }
    return checksumEntRevs(revs, crypto);
  }
}
