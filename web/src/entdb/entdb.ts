// EntDB, short for "Entity Database", is an object database.
// It's built on top of DIPLOMATIC messages.
// Each message (msg) in DIPLOMATIC has an eid.
// That eid uniquely identifies an application object (an "ent").
// A new message updates the value of the corresponding ent.
// EntDB indexes these ents so they can be queried and used efficiently.

// EntDB adds concepts on top of the raw DIPLOMATIC protocol:
// 1. "type" - Mandatory. Groups ents by their application-defined type.
//    Taken from the msg head `typ` (empty = untyped / single-type).
// 2. "pid" (parent ID) - Optional. Encodes a hierarchy amongst ents.
// 3. "tags" - Optional string[]; multi-value reverse index (multiEntry).
//    Like pid reverse lookup, but N:M. Opaque strings; clients define semantics
//    (e.g. impl:<btob64(eid)>). Query: exact string, { range }, or { prefix }.
// pid/tags plus the application payload are msgpack-encoded in the msg body.
//
// Deletes leave permanent tombstones ({ eid, updatedAt, ctr }). Without them,
// out-of-order / newest-first apply of older mutates would resurrect ents.
// Tombstones are never pruned: partition healing can deliver old msgs anytime.

import { Decoder } from "../shared/codec.ts";
import { eidCodec } from "../shared/codecs/eid.ts";
import { Status } from "../shared/consts";
import { err, ok, ValStat } from "../shared/valstat";
import {
  EntityID,
  Hash,
  ICrypto,
  IEntRev,
  IMessageHead,
  IMsgEntBody,
  IOp,
  isMutateOp,
} from "../shared/types";

export { entStateManager } from "./manager.ts";

export interface IEntity<T = unknown> extends Omit<IMsgEntBody<T>, "body"> {
  type: string;
  eid: EntityID;
  updatedAt: Date;
  createdAt: Date;
  ctr: number;
  body: T;
}

/**
 * Deleted eid's LWW frontier: eid + updatedAt + ctr only (no type/body/…).
 * Permanent — pruning would allow obsolete mutates to resurrect the ent.
 * `type?: never` is type-only so IEntity is not assignable to ITombstone.
 */
export interface ITombstone {
  eid: EntityID;
  updatedAt: Date;
  ctr: number;
  type?: never;
}

/** Live ent or tombstone (what the store holds per eid). */
export type IEntRow<T = unknown> = IEntity<T> | ITombstone;

/** Live ent (has `type`). */
export function isLiveEnt<T>(row: IEntRow<T>): row is IEntity<T> {
  return "type" in row;
}

/** Tombstone frontier (no `type`). */
export function isTombstone(row: IEntRow): row is ITombstone {
  return !isLiveEnt(row);
}

/** Inclusive Date range unless excludeStart / excludeEnd. */
export type IDateRange = {
  start: Date;
  end: Date;
  excludeStart?: boolean;
  excludeEnd?: boolean;
};

/** Exact updatedAt or Date range. One shape per query. */
export type DateSpec =
  | Date
  | { range: IDateRange };

/** Lexicographic tag range. Inclusive unless excludeStart / excludeEnd. */
export type ITagRange = {
  start: string;
  end: string;
  excludeStart?: boolean;
  excludeEnd?: boolean;
};

/** Exact tag, lexicographic range, or prefix. One shape per query. */
export type TagSpec =
  | string
  | { range: ITagRange }
  | { prefix: string };

export type EntitiesQuery =
  | { type: string }
  | { type: string; pid: EntityID }
  | { type: string; tag: TagSpec }
  | { type: string; updatedAt: DateSpec };

/** Whether t falls in r (inclusive by default). Does not check start > end. */
export function dateInRange(t: Date, r: IDateRange): boolean {
  const ge = r.excludeStart ? t > r.start : t >= r.start;
  const le = r.excludeEnd ? t < r.end : t <= r.end;
  return ge && le;
}

/**
 * Whether a date spec can match. InvalidParam if range start > end.
 */
export function dateSpecMayMatch(spec: DateSpec): ValStat<boolean> {
  if (spec instanceof Date) {
    return ok(true);
  }
  if (spec.range.start > spec.range.end) {
    return err(Status.InvalidParam);
  }
  return ok(true);
}

/** Whether t satisfies an exact / range spec. */
export function dateMatches(t: Date, spec: DateSpec): boolean {
  if (spec instanceof Date) {
    return t.getTime() === spec.getTime();
  }
  return dateInRange(t, spec.range);
}

/** Whether tag falls in r (inclusive by default). Does not check start > end. */
export function tagInRange(tag: string, r: ITagRange): boolean {
  const ge = r.excludeStart ? tag > r.start : tag >= r.start;
  const le = r.excludeEnd ? tag < r.end : tag <= r.end;
  return ge && le;
}

/**
 * Whether a tag spec can match. InvalidParam if range start > end.
 * False (Success) for empty exact string or empty prefix.
 */
export function tagSpecMayMatch(spec: TagSpec): ValStat<boolean> {
  if (typeof spec === "string") {
    return ok(spec.length > 0);
  }
  if ("range" in spec) {
    if (spec.range.start > spec.range.end) {
      return err(Status.InvalidParam);
    }
    return ok(true);
  }
  return ok(spec.prefix.length > 0);
}

/** Whether tag satisfies an exact / range / prefix spec. */
export function tagMatches(tag: string, spec: TagSpec): boolean {
  if (typeof spec === "string") {
    return tag === spec;
  }
  if ("range" in spec) {
    return tagInRange(tag, spec.range);
  }
  if (spec.prefix.length === 0) {
    return false;
  }
  return tag.startsWith(spec.prefix);
}

/**
 * Normalize tags for storage/index: drop non-strings and empty strings, dedupe
 * (first occurrence wins). Returns undefined when there are no tags left.
 */
export function normalizeTags(
  tags: unknown,
): string[] | undefined {
  if (!Array.isArray(tags) || tags.length === 0) {
    return undefined;
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tags) {
    if (typeof t !== "string" || t.length === 0) {
      continue;
    }
    if (seen.has(t)) {
      continue;
    }
    seen.add(t);
    out.push(t);
  }
  return out.length > 0 ? out : undefined;
}

/** Result of applying ops to EntDB. */
export type ApplyResult = {
  stats: Status[];
  /** Types whose rendered state may have changed (for app list invalidation). */
  types: Set<string>;
  /** Eids that successfully applied (for granular cache ingest). */
  eids: EntityID[];
};

export interface IEntDB {
  apply: (ops: IOp[]) => Promise<ApplyResult>;
  clear: () => Promise<Status>;
  /**
   * Live ent only. Tombstones and missing eids both yield undefined.
   * Use {@link getRow} when LWW / cache reconcile needs the frontier.
   */
  getEnt<T>(
    eid: EntityID,
  ): Promise<ValStat<IEntity<T> | undefined>>;
  /** Live ent or permanent tombstone. */
  getRow<T>(
    eid: EntityID,
  ): Promise<ValStat<IEntRow<T> | undefined>>;
  getEntities<T>(
    query: EntitiesQuery,
  ): Promise<ValStat<IEntity<T>[]>>;
  countEntities({ type }: { type: string }): Promise<ValStat<number>>;
  /**
   * Frontier checksum of all rows (live + tombstone): eid + updatedAt + ctr
   * (see encodeEntRev / checksumEntRevs). Not a content hash of bodies.
   */
  checksum(crypto: ICrypto): Promise<ValStat<Hash>>;
}

/** Prior rev from a live ent or tombstone. */
export function revFromEntity(ent: IEntRow): IEntRev {
  return { eid: ent.eid, ctr: ent.ctr, updatedAt: ent.updatedAt };
}

/** Prior rev from a msg head returned by insert/update/delete. */
export function revFromHead(head: IMessageHead): ValStat<IEntRev> {
  const dec = new Decoder(head.eid);
  const [parsed, st] = dec.readStruct(eidCodec);
  if (st !== Status.Success) {
    return err(st);
  }
  return ok({
    eid: head.eid,
    ctr: head.ctr,
    updatedAt: new Date(parsed.ts.getTime() + head.off),
  });
}

export function applyOp(
  curr: IEntRow | undefined,
  op: IOp,
): ValStat<IEntRow | undefined> {
  // Parse op EID.
  const decOpEid = new Decoder(op.eid);
  const [opEID, statOpEID] = decOpEid.readStruct(eidCodec);
  if (statOpEID !== Status.Success) {
    return err(statOpEID);
  }

  // Handle obsolete op (op outdated by curr, including tombstones).
  // TODO: use order to tiebreak the comparison (unit test).
  const opUpdatedAt = new Date(opEID.ts.getTime() + op.off);
  if (curr !== undefined && opUpdatedAt <= curr.updatedAt) {
    return err(Status.NoChange);
  }

  // Now, either curr doesn't exist or op is newer than curr, so op wins.
  if (isMutateOp(op)) {
    const tags = normalizeTags(op.tags);
    return ok({
      eid: op.eid,
      pid: op.pid,
      ...(tags !== undefined ? { tags } : {}),
      type: op.type,
      createdAt: opEID.ts,
      updatedAt: opUpdatedAt,
      ctr: op.ctr,
      body: op.body,
    });
  }
  // Deletion: permanent tombstone (never prune — out-of-order mutates).
  return ok({
    eid: op.eid,
    updatedAt: opUpdatedAt,
    ctr: op.ctr,
  });
}

/** Types to notify when curr → next after a successful apply. */
export function typesChanged(
  curr: IEntRow | undefined,
  next: IEntRow,
): string[] {
  const types = new Set<string>();
  if (curr !== undefined && isLiveEnt(curr)) types.add(curr.type);
  if (isLiveEnt(next)) types.add(next.type);
  return [...types];
}

export const nullEntDB: IEntDB = {
  getEnt: async () => err(Status.NotImplemented),
  getRow: async () => err(Status.NotImplemented),
  getEntities: async (_query: EntitiesQuery) => err(Status.NotImplemented),
  countEntities: async () => err(Status.NotImplemented),
  checksum: async () => err(Status.NotImplemented),
  apply: async (ops: IOp[]) => ({
    stats: ops.map(() => Status.NotImplemented),
    types: new Set(),
    eids: [],
  }),
  clear: async () => Status.NotImplemented,
};
