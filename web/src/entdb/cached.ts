// In-memory EntDB cache over a durable IEntDB.
//
// Architecture:
//
// 1. apply(ops) patches mem and notifies subscribers (UI) synchronously,
//    unless constructed with `{ optimistic: false }`.
// 2. The same ops go to durable (authority) in the same call.
// 3. After durable settles, mem is set from durable for those eids.
//    If that changes mem, subscribers are notified again.
// 4. Peer writes (e.g. sync worker) call ingestFromDurable(eids):
//    pull those eids from durable; notify types only if mem changed.
//
// Optimistic notify (default) — do not regress:
// - apply() must NOT be `async`. The first await would be durable IDB and
//   the UI would wait on it. emit() runs in the synchronous prefix, then
//   this.run() persists. Putting emit inside run(), or awaiting getRow /
//   durable.apply before emit, is the failure mode we already hit twice.
// - apply() returns a Promise that settles after durable+reconcile. Callers
//   (StateManager.apply, SyncClient.doApply) may await that for stats, but
//   subscribe listeners have already run. cacheDriven StateManager must not
//   emit again after the applier Promise settles — that emit would be late.
// - SyncClient.doApply must invoke state.apply before awaiting archive IDB
//   so the cache's sync prefix runs before messages.add.
// - Regression tests: "apply notifies and serves mem before durable.apply"
//   (cached-entdb) and "insert notifies before archive IDB" (client).
//
// Reads always hit mem. First list/count of a type pulls durable once
// under the write chain (merge, so it does not clobber a concurrent
// in-flight apply's mem state). After a type is warm, list/count serve
// mem without the chain so concurrent queries are not serialized
// (stale-until-notify, same as hot getEnt).
//
// `warmed` means the full type has been loaded from durable (or was
// provided via constructor init). apply / getEnt / ingest only touch
// individual eids — they must not mark a type warm, or a write before
// the first list would hide every other row of that type until restart.
// Unknown durable tombstones are corrected on reconcile, not before notify.

import { encode } from "@msgpack/msgpack";
import { btob64, bytesEqual } from "../shared/binary";
import { Status } from "../shared/consts";
import { EntityID, Hash, ICrypto, IOp } from "../shared/types";
import { err, ok, ValStat } from "../shared/valstat";
import {
  applyOp,
  EntitiesQuery,
  IEntDB,
  IEntity,
  IEntRow,
  isLiveEnt,
  typesChanged,
} from "./entdb";
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
   * Secondary type/pid/tag indexes on the in-memory layer (default true).
   * Speeds up getEntities list queries after a type is warm.
   * Ignored when `cache` is false.
   */
  indexes?: boolean;
  /**
   * Notify UI as soon as mem is patched, before durable IDB (default true).
   * Set false to notify only after durable commit. Ignored when `cache` is false.
   */
  optimistic?: boolean;
};

export type CachedEntDBOptions = {
  /** Secondary mem indexes (default true). See {@link OpenEntDBOptions.indexes}. */
  indexes?: boolean;
  /** Immediate mem notify (default true). See {@link OpenEntDBOptions.optimistic}. */
  optimistic?: boolean;
};

/**
 * Open EntDB for the app (or worker). Single entry point.
 * Default: cached with mem indexes and optimistic notify.
 * Pass `{ cache: false }` for durable IDB only.
 * Pass `{ optimistic: false }` to notify only after durable commit.
 */
export async function openEntDB(
  opts?: OpenEntDBOptions,
): Promise<IEntDB> {
  const durable = await openEntIDB();
  if (opts?.cache === false) {
    return durable;
  }
  return new CachedEntDB(durable, undefined, {
    indexes: opts?.indexes,
    optimistic: opts?.optimistic,
  });
}

export class CachedEntDB implements IEntDB {
  private mem: EntDBMemory;
  private durable: IEntDB;
  private warmed = new Set<string>();
  private listeners = new Set<EntChangeListener>();
  private chain: Promise<unknown> = Promise.resolve();
  private optimistic: boolean;

  constructor(
    durable: IEntDB,
    init?: IEntity[],
    opts?: CachedEntDBOptions,
  ) {
    this.durable = durable;
    this.optimistic = opts?.optimistic !== false;
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
   * Not `async`: the mem patch+emit below must run before any await.
   * `{ optimistic: false }`: skip the sync prefix; notify after durable.
   */
  apply(ops: IOp[]) {
    let snap: Map<string, RowStamp | undefined> | undefined;
    if (this.optimistic) {
      // Sync prefix: UI sees the write here. Do not move this into run().
      this.emit(applyOps(this.mem, ops).types);
      snap = new Map();
      for (const op of ops) {
        const key = btob64(op.eid);
        snap.set(key, rowStamp(this.mem.ents.get(key)));
      }
    }

    return this.run(async () => {
      const durResult = await this.durable.apply(ops);
      // Authority for eids whose mem stamp still matches this apply.
      // Do not mark types warm: only these eids are in mem.
      const { changed, status } = await this.pullEids(
        ops.map((o) => o.eid),
        snap,
      );
      this.emit(changed);

      if (status !== Status.Success) {
        return {
          stats: ops.map(() => status),
          types: durResult.types,
          eids: durResult.eids,
        };
      }
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
   * Install durable truth for each eid into mem (live or tombstone).
   * When `snap` is set (post-apply reconcile), skip eids whose mem stamp
   * moved — a later apply owns them. Always skip if mem is newer than
   * durable (overlapping optimistic apply). Never replace a newer in-flight
   * mem row with older durable truth.
   */
  private async pullEids(
    eids: Iterable<EntityID>,
    snap?: Map<string, RowStamp | undefined>,
  ): Promise<{ changed: Set<string>; status: Status }> {
    const changed = new Set<string>();
    const seen = new Set<string>();
    for (const eid of eids) {
      const key = btob64(eid);
      if (seen.has(key)) continue;
      seen.add(key);

      const [row, st] = await this.durable.getRow(eid);
      if (st !== Status.Success) {
        // Do not leave mem half-reconciled on a read failure.
        return { changed, status: st };
      }

      const curr = this.mem.ents.get(key);
      // Never clobber a newer in-flight mem row with older durable truth.
      if (curr !== undefined && row !== undefined && rowWins(curr, row)) {
        continue;
      }
      if (snap) {
        if (!stampEq(rowStamp(curr), snap.get(key))) continue;
      }

      if (row) {
        // Single-eid ingest is not a full type load — leave warmed alone.
        this.mem.put(row);
        if (!curr || !sameRow(curr, row)) {
          if (isLiveEnt(row)) {
            changed.add(row.type);
          }
          if (curr !== undefined && isLiveEnt(curr)) {
            changed.add(curr.type);
          }
        }
      } else if (curr !== undefined) {
        this.mem.del(key);
        if (isLiveEnt(curr)) {
          changed.add(curr.type);
        }
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
        if (!curr || rowWins(ent, curr)) {
          this.mem.put(ent);
        }
      }
    }
    this.warmed.add(type);
    return Status.Success;
  }

  async getRow<T>(
    eid: EntityID,
  ): Promise<ValStat<IEntRow<T> | undefined>> {
    const key = btob64(eid);
    if (this.mem.ents.has(key)) {
      return this.mem.getRow<T>(eid);
    }
    return this.run(async () => {
      if (this.mem.ents.has(key)) {
        return this.mem.getRow<T>(eid);
      }
      const [row, st] = await this.durable.getRow<T>(eid);
      if (st !== Status.Success) {
        return err(st);
      }
      if (row) {
        this.mem.put(row);
      }
      return ok(row);
    });
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

  async getEntities<T>(
    query: EntitiesQuery,
  ): Promise<ValStat<IEntity<T>[]>> {
    // Warm types: serve mem without the write chain so concurrent list
    // queries do not serialize (same stale-until-notify model as hot getEnt).
    // Cold types: warm under run() so first IDB load does not race apply/ingest.
    if (!this.warmed.has(query.type)) {
      const st = await this.run(() => this.warmType(query.type));
      if (st !== Status.Success) {
        return err(st);
      }
    }
    return this.mem.getEntities<T>(query);
  }

  async countEntities({ type }: { type: string }): Promise<ValStat<number>> {
    if (!this.warmed.has(type)) {
      const st = await this.run(() => this.warmType(type));
      if (st !== Status.Success) {
        return err(st);
      }
    }
    return this.mem.countEntities({ type });
  }

  /** Durable authority — mem may be only partially warm. */
  async checksum(crypto: ICrypto): Promise<ValStat<Hash>> {
    return this.durable.checksum(crypto);
  }
}

/**
 * Full row identity for notify gating after installing durable truth.
 * Prefer over-notifying (false) to missing a UI update.
 *
 * TODO: pass msg head `hsh` (blake3 of body) into EntDB on apply and store it
 * on the ent. Then sameRow for live can be (ctr, updatedAt, hsh) instead of
 * re-encoding body.
 */
function sameRow(a: IEntRow, b: IEntRow): boolean {
  if (isLiveEnt(a) !== isLiveEnt(b)) return false;
  if (a.ctr !== b.ctr) return false;
  if (a.updatedAt.getTime() !== b.updatedAt.getTime()) return false;
  if (!bytesEqual(a.eid, b.eid)) return false;
  if (!isLiveEnt(a) || !isLiveEnt(b)) {
    // Both tombstones (live/tomb mismatch already rejected).
    return true;
  }
  if (a.createdAt.getTime() !== b.createdAt.getTime()) return false;
  if (a.type !== b.type) return false;
  if (!optBytesEqual(a.pid, b.pid)) return false;
  if (!sameTags(a.tags, b.tags)) return false;
  return sameBody(a.body, b.body);
}

function sameTags(
  a: string[] | undefined,
  b: string[] | undefined,
): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
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

function rowWins(a: IEntRow, b: IEntRow): boolean {
  const ta = a.updatedAt.getTime();
  const tb = b.updatedAt.getTime();
  if (ta !== tb) return ta > tb;
  return a.ctr > b.ctr;
}

type RowStamp = { t: number; ctr: number };

function rowStamp(row: IEntRow | undefined): RowStamp | undefined {
  if (row === undefined) return undefined;
  return { t: row.updatedAt.getTime(), ctr: row.ctr };
}

function stampEq(
  a: RowStamp | undefined,
  b: RowStamp | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.t === b.t && a.ctr === b.ctr;
}

/** Apply ops to mem (LWW per eid); uses put so tombstones stay for LWW. */
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
    if (next === undefined) {
      results.push(Status.InternalError);
      continue;
    }
    for (const t of typesChanged(curr, next)) {
      types.add(t);
    }
    mem.put(next);
    results.push(Status.Success);
  }
  return { stats: results, types };
}
