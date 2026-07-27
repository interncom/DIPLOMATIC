// In-memory EntDB cache over a durable IEntDB.
//
// Architecture:
//
// 1. apply(ops) updates mem immediately and notifies subscribers (UI).
// 2. The same ops go to durable (authority) in the same call.
// 3. After durable settles, mem is set from durable for those eids.
//    If that changes mem, subscribers are notified again.
// 4. Peer writes (e.g. sync worker) call ingestFromDurable(eids):
//    pull those eids from durable; notify types only if mem changed.
//
// Reads always hit mem. First list/count of a type pulls durable once
// (merge, so it does not clobber a concurrent in-flight apply's mem state).

import { encode } from "@msgpack/msgpack";
import { btob64, bytesEqual } from "../shared/binary";
import { Status } from "../shared/consts";
import { EntityID, IOp } from "../shared/types";
import { err, ok, ValStat } from "../shared/valstat";
import { applyOp, EntitiesQuery, IEntDB, IEntity } from "./entdb";
import { openEntIDB } from "./idb";
import { EntDBMemory } from "./memory";

export type EntChangeListener = (types: Set<string>) => void;

export type OpenEntDBOptions = {
  /**
   * In-memory cache over IndexedDB (default true).
   * Set false for durable-only (e.g. sync worker).
   */
  cache?: boolean;
  /**
   * Secondary type/pid/gid indexes on the in-memory layer (default true).
   * Speeds up getEntities list queries after a type is warm.
   * Ignored when `cache` is false.
   */
  indexes?: boolean;
};

export type CachedEntDBOptions = {
  /** Secondary mem indexes (default true). See {@link OpenEntDBOptions.indexes}. */
  indexes?: boolean;
};

/**
 * Open EntDB for the app (or worker). Single entry point.
 * Default: cached with mem indexes. Pass `{ cache: false }` for durable IDB only.
 */
export async function openEntDB(
  opts?: OpenEntDBOptions,
): Promise<IEntDB> {
  const durable = await openEntIDB();
  if (opts?.cache === false) {
    return durable;
  }
  return new CachedEntDB(durable, undefined, { indexes: opts?.indexes });
}

export class CachedEntDB implements IEntDB {
  private mem: EntDBMemory;
  private durable: IEntDB;
  private warmed = new Set<string>();
  private listeners = new Set<EntChangeListener>();
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    durable: IEntDB,
    init?: IEntity[],
    opts?: CachedEntDBOptions,
  ) {
    this.durable = durable;
    this.mem = new EntDBMemory(init ?? [], { indexes: opts?.indexes });
    if (init) {
      for (const ent of init) {
        this.warmed.add(ent.type);
      }
    }
  }

  /** UI / StateManager: fired when mem changes (immediate apply or durable ingest). */
  subscribe(listener: EntChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(types: Set<string>) {
    if (types.size < 1) return;
    for (const fn of this.listeners) {
      fn(types);
    }
  }

  private run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.then(() => undefined, () => undefined);
    return next;
  }

  /**
   * Fan-out write: mem (immediate notify) + durable, then reconcile mem
   * from durable for the ops' eids (second notify only if something moved).
   */
  apply(ops: IOp[]) {
    return this.run(async () => {
      // 1–2. Mem immediately + durable in parallel (mem is sync).
      const memResult = applyOps(this.mem, ops);
      this.emit(memResult.types);

      const durResult = await this.durable.apply(ops);

      // 3. Authority: mem := durable for these eids.
      const { changed, status } = await this.pullEids(ops.map((o) => o.eid));
      this.emit(changed);

      for (const t of durResult.types) {
        this.warmed.add(t);
      }
      if (status !== Status.Success) {
        return {
          stats: ops.map(() => status),
          types: durResult.types,
          eids: durResult.eids,
        };
      }
      // Durable stats/types are authoritative for the apply caller.
      return durResult;
    });
  }

  clear() {
    return this.run(async () => {
      const st = await this.durable.clear();
      if (st !== Status.Success) {
        return st;
      }
      const had = this.mem.ents.size > 0;
      await this.mem.clear();
      this.warmed.clear();
      if (had) {
        // Listeners use type names; emitAll is StateManager's job on clear.
      }
      return Status.Success;
    });
  }

  /**
   * Backing store changed outside this.apply (worker wrote shared IDB).
   * Pull only those eids from durable; notify coalesced types if mem changed.
   */
  ingestFromDurable(eids: Iterable<EntityID>) {
    return this.run(async () => {
      const { changed, status } = await this.pullEids(eids);
      this.emit(changed);
      return status;
    });
  }

  /**
   * Install durable truth for each eid into mem.
   * Always writes mem from durable; notifies types only when the full ent
   * identity differs from what mem had (or the row was deleted).
   */
  private async pullEids(
    eids: Iterable<EntityID>,
  ): Promise<{ changed: Set<string>; status: Status }> {
    const changed = new Set<string>();
    const seen = new Set<string>();
    for (const eid of eids) {
      const key = btob64(eid);
      if (seen.has(key)) continue;
      seen.add(key);

      const prev = this.mem.ents.get(key);
      const [ent, st] = await this.durable.getEnt(eid);
      if (st !== Status.Success) {
        // Do not leave mem half-reconciled on a read failure.
        return { changed, status: st };
      }
      if (ent) {
        // Always install durable row (authority), even if we skip notify.
        this.mem.put(ent);
        this.warmed.add(ent.type);
        if (!prev || !sameEntity(prev, ent)) {
          changed.add(ent.type);
          if (prev && prev.type !== ent.type) {
            changed.add(prev.type);
          }
        }
      } else if (prev) {
        this.mem.del(key);
        changed.add(prev.type);
      }
    }
    return { changed, status: Status.Success };
  }

  private async warmType(type: string): Promise<Status> {
    if (this.warmed.has(type)) {
      return Status.Success;
    }
    const [ents, st] = await this.durable.getEntities({ type });
    if (st !== Status.Success) {
      return st;
    }
    if (ents) {
      for (const ent of ents) {
        const key = btob64(ent.eid);
        const curr = this.mem.ents.get(key);
        if (!curr || entWins(ent, curr)) {
          this.mem.put(ent);
        }
      }
    }
    this.warmed.add(type);
    return Status.Success;
  }

  async getEnt<T>(
    eid: EntityID,
  ): Promise<ValStat<IEntity<T> | undefined>> {
    const key = btob64(eid);
    if (this.mem.ents.has(key)) {
      return this.mem.getEnt<T>(eid);
    }
    return this.run(async () => {
      if (this.mem.ents.has(key)) {
        return this.mem.getEnt<T>(eid);
      }
      const [ent, st] = await this.durable.getEnt<T>(eid);
      if (st !== Status.Success) {
        return err(st);
      }
      if (ent) {
        this.mem.put(ent);
        this.warmed.add(ent.type);
      }
      return ok(ent);
    });
  }

  async getEntities<T>(
    query: EntitiesQuery,
  ): Promise<ValStat<IEntity<T>[]>> {
    const st = await this.run(() => this.warmType(query.type));
    if (st !== Status.Success) {
      return err(st);
    }
    return this.mem.getEntities<T>(query);
  }

  async countEntities({ type }: { type: string }): Promise<ValStat<number>> {
    const st = await this.run(() => this.warmType(type));
    if (st !== Status.Success) {
      return err(st);
    }
    return this.mem.countEntities({ type });
  }
}

/**
 * Full ent identity for notify gating after installing durable truth.
 * Prefer over-notifying (false) to missing a UI update.
 *
 * TODO: pass msg head `hsh` (blake3 of body) into EntDB on apply and store it
 * on the ent. Then sameEntity can be (ctr, updatedAt, hsh) instead of
 * re-encoding body — deletes still compare as missing row.
 */
function sameEntity(a: IEntity, b: IEntity): boolean {
  if (a.ctr !== b.ctr) return false;
  if (a.updatedAt.getTime() !== b.updatedAt.getTime()) return false;
  if (a.createdAt.getTime() !== b.createdAt.getTime()) return false;
  if (a.type !== b.type) return false;
  if (a.gid !== b.gid) return false;
  if (!bytesEqual(a.eid, b.eid)) return false;
  if (!optBytesEqual(a.pid, b.pid)) return false;
  return sameBody(a.body, b.body);
}

function optBytesEqual(
  a: Uint8Array | undefined,
  b: Uint8Array | undefined,
): boolean {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  return bytesEqual(a, b);
}

function sameBody(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    return bytesEqual(a, b);
  }
  if (a instanceof Date && b instanceof Date) {
    return a.getTime() === b.getTime();
  }
  try {
    return bytesEqual(encode(a), encode(b));
  } catch {
    return false;
  }
}

function entWins(a: IEntity, b: IEntity): boolean {
  const ta = a.updatedAt.getTime();
  const tb = b.updatedAt.getTime();
  if (ta !== tb) return ta > tb;
  return a.ctr > b.ctr;
}

/** Apply ops to mem (LWW per eid); uses put/del so indexes stay correct. */
function applyOps(
  mem: EntDBMemory,
  ops: IOp[],
): { stats: Status[]; types: Set<string> } {
  const types = new Set<string>();
  const results: Status[] = [];
  for (const op of ops) {
    const key = btob64(op.eid);
    const curr = mem.ents.get(key);
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
      mem.put(next);
    } else {
      mem.del(key);
    }
    results.push(Status.Success);
  }
  return { stats: results, types };
}
