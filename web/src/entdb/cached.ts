// In-memory EntDB cache over a durable IEntDB.
//
// Architecture:
//
// 1. apply(ops) patches mem synchronously, unless `{ optimistic: false }`.
// 2. Durable persist is queued on the write chain immediately after that.
// 3. Type subscribers are notified after the next paint (double rAF). Sync
//    emit blocks paint of hide(); setTimeout(0) loses to IDB. List reads
//    during an in-flight write serve mem and must not wait on the write chain.
// 4. After durable.apply, pull/reconcile only eids that did not Success
//    (NoChange / error). Do not re-read or re-encode bodies that mem
//    already holds. Peer ingest still pulls by eid.
//
// Optimistic notify (default) — do not regress:
// - apply() must NOT be `async`. The first await would be durable IDB and
//   mem would not be patched before callers continue.
// - Patch mem, queue persist, then afterPaint(emit). Persist's first work
//   is a microtask (chain.then) then IDB. Sync emit runs list watchers
//   before paint, so a fire-and-forget save+hide keeps the modal up until
//   every type list is copied. setTimeout(0) shares the macrotask queue
//   with IDB and the list updates only after persist. Cold getEntities
//   must not this.run(warmType): that shares the chain with ingestFromDurable
//   (worker dirty eids) and blocks first hydration until every dirty getRow
//   finishes. First list uses beginWarm (off-chain). While a local write is
//   in flight, return mem immediately. Handlers may list; they must not
//   jump the persist chain.
// - apply() returns a Promise that settles after durable. Callers may
//   await that for stats. cacheDriven StateManager must not emit after
//   that Promise settles — that emit would be late.
// - SyncClient.apply kicks state.apply before applyChain (and before
//   archive IDB) so a prior persist cannot delay the list.
// - Regression tests: "apply notifies and serves mem before durable.apply",
//   "apply patches mem immediately; notify is not after durable",
//   "subscribe handlers do not block durable.apply",
//   "list during in-flight write serves mem",
//   "first list does not wait for ingestFromDurable" (cached-entdb),
//   "insert notifies before archive IDB" (client).
//
// Reads always hit mem. First list/count of a type pulls durable once
// off the persist/ingest chain (merge via rowWins with concurrent ingest).
// After a type is warm, list/count serve
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
import { dipLog, setVerbose } from "../verbose";

/**
 * Run `fn` after the next paint. Sync/microtask emit copies type lists and
 * re-renders before the browser can paint hide(); the modal stays up until
 * that work finishes. setTimeout(0) shares the macrotask queue with IDB and
 * the list waits on persist. Double rAF is the rendering pipeline, not IDB.
 * Node tests have no rAF — fall back to a microtask.
 */
function afterPaint(fn: () => void) {
  const raf = globalThis.requestAnimationFrame;
  if (typeof raf !== "function") {
    queueMicrotask(fn);
    return;
  }
  raf(() => {
    raf(fn);
  });
}

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
  /**
   * Timed `[dip]` traces for apply / list / persist (default false).
   * Process-wide; also accepted on openDiplomaticClient / useClient.
   */
  verbose?: boolean;
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
 * Pass `{ verbose: true }` for `[dip]` timings (apply, list, persist).
 */
export async function openEntDB(
  opts?: OpenEntDBOptions,
): Promise<IEntDB> {
  if (opts?.verbose !== undefined) {
    setVerbose(opts.verbose);
  }
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
  /** Optimistic applies whose durable persist has not finished. */
  private inflight = 0;
  /** In-flight warmType per type (not on the persist/ingest chain). */
  private warmP = new Map<string, Promise<Status>>();

  constructor(
    durable: IEntDB,
    init?: IEntity[],
    opts?: CachedEntDBOptions,
  ) {
    this.durable = durable;
    this.optimistic = opts?.optimistic !== false;
    dipLog("CachedEntDB open", { optimistic: this.optimistic });
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
    const t0 = performance.now();
    dipLog("emit start", {
      types: [...types],
      listeners: this.listeners.size,
    });
    for (const fn of this.listeners) {
      fn(types);
    }
    dipLog("emit done", { ms: Math.round(performance.now() - t0) });
  }

  private run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.then(() => undefined, () => undefined);
    return next;
  }

  /**
   * Fan-out write: patch mem, queue durable, notify UI after the next paint.
   * Not `async`: mem patch must run before any await.
   * `{ optimistic: false }`: skip the mem prefix; notify after durable.
   */
  apply(ops: IOp[]) {
    let snap: Map<string, RowStamp | undefined> | undefined;
    let types: Set<string> | undefined;
    if (this.optimistic) {
      // Sync prefix: mem is patched here. Do not await; do not emit yet.
      types = applyOps(this.mem, ops).types;
      snap = new Map();
      for (const op of ops) {
        const key = btob64(op.eid);
        snap.set(key, rowStamp(this.mem.ents.get(key)));
      }
      this.inflight += 1;
      dipLog("apply mem patched", {
        ops: ops.length,
        types: types ? [...types] : [],
        inflight: this.inflight,
      });
    }

    // Queue persist before notify so list watchers cannot jump the chain.
    const persist = this.run(async () => {
      dipLog("persist start", { ops: ops.length });
      try {
        const tDur = performance.now();
        const durResult = await this.durable.apply(ops);
        dipLog("persist durable.apply done", {
          ms: Math.round(performance.now() - tDur),
        });
        if (!this.optimistic) {
          const { changed, status } = await this.pullEids(
            ops.map((o) => o.eid),
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
        }
        // Mem already has successful ops. Only pull eids durable rejected
        // (NoChange / error) — skip getRow + body re-encode on the hot path.
        const pull: EntityID[] = [];
        for (let i = 0; i < ops.length; i++) {
          if (durResult.stats[i] !== Status.Success) {
            pull.push(ops[i].eid);
          }
        }
        if (pull.length > 0) {
          dipLog("persist pull rejected eids", { n: pull.length });
          const { changed, status } = await this.pullEids(pull, snap);
          this.emit(changed);
          if (status !== Status.Success) {
            return {
              stats: ops.map(() => status),
              types: durResult.types,
              eids: durResult.eids,
            };
          }
        }
        dipLog("persist done");
        return durResult;
      } finally {
        if (this.optimistic) {
          this.inflight -= 1;
        }
      }
    });

    if (types) {
      // Persist is already queued (chain.then). Emit after paint so hide()
      // can close the modal in this frame. setTimeout(0) loses to IDB.
      afterPaint(() => {
        dipLog("emit after paint");
        this.emit(types);
      });
    }
    return persist;
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
    const n = [...eids].length;
    dipLog("ingest queued", { eids: n });
    return this.run(async () => {
      const t0 = performance.now();
      dipLog("ingest start", { eids: n });
      const { changed, status } = await this.pullEids(eids);
      dipLog("ingest done", {
        ms: Math.round(performance.now() - t0),
        changed: [...changed],
      });
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
    const t0 = performance.now();
    dipLog("warmType start", { type });
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
    dipLog("warmType done", {
      type,
      n: ents?.length ?? 0,
      ms: Math.round(performance.now() - t0),
    });
    return Status.Success;
  }

  /**
   * Load a type from durable into mem. Not on the persist/ingest chain —
   * first UI list must not wait for dirty-eid pull after worker sync.
   */
  private beginWarm(type: string): Promise<Status> {
    if (this.warmed.has(type)) {
      return Promise.resolve(Status.Success);
    }
    const hit = this.warmP.get(type);
    if (hit) {
      return hit;
    }
    const p = this.warmType(type).finally(() => {
      this.warmP.delete(type);
    });
    this.warmP.set(type, p);
    return p;
  }

  /** Background warm + notify. Does not block the caller. */
  private ensureWarm(type: string) {
    if (this.warmed.has(type)) {
      return;
    }
    void this.beginWarm(type).then((st) => {
      if (st === Status.Success) {
        this.emit(new Set([type]));
      }
    });
  }

  async getRow<T>(
    eid: EntityID,
  ): Promise<ValStat<IEntRow<T> | undefined>> {
    const key = btob64(eid);
    if (this.mem.ents.has(key)) {
      return this.mem.getRow<T>(eid);
    }
    // Off the persist/ingest chain — same reason as first getEntities.
    const [row, st] = await this.durable.getRow<T>(eid);
    if (st !== Status.Success) {
      return err(st);
    }
    if (row) {
      const curr = this.mem.ents.get(key);
      if (!curr || rowWins(row, curr)) {
        this.mem.put(row);
      }
    }
    return this.mem.getRow<T>(eid);
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
    // Warm: mem only.
    // In-flight local write: serve mem now (optimistic row); warm in background.
    // Cold: load this type from durable *off* the persist/ingest chain so a
    // worker dirty-eid ingest cannot block first UI hydration.
    if (this.warmed.has(query.type)) {
      dipLog("getEntities mem", { type: query.type });
      return this.mem.getEntities<T>(query);
    }
    if (this.inflight > 0) {
      dipLog("getEntities inflight-mem", { type: query.type });
      this.ensureWarm(query.type);
      return this.mem.getEntities<T>(query);
    }
    dipLog("getEntities beginWarm", { type: query.type });
    const st = await this.beginWarm(query.type);
    if (st !== Status.Success) {
      return err(st);
    }
    dipLog("getEntities afterWarm", { type: query.type });
    return this.mem.getEntities<T>(query);
  }

  async countEntities({ type }: { type: string }): Promise<ValStat<number>> {
    if (this.warmed.has(type)) {
      return this.mem.countEntities({ type });
    }
    if (this.inflight > 0) {
      this.ensureWarm(type);
      return this.mem.countEntities({ type });
    }
    const st = await this.beginWarm(type);
    if (st !== Status.Success) {
      return err(st);
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
