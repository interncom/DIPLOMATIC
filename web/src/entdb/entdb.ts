// EntDB, short for "Entity Database", is an object database.
// It's built on top of DIPLOMATIC messages.
// Each message (msg) in DIPLOMATIC has an eid.
// That eid uniquely identifies an application object (an "ent").
// A new message updates the value of the corresponding ent.
// EntDB indexes these ents so they can be queried and used efficiently.

// EntDB adds concepts on top of the raw DIPLOMATIC protocol:
// 1. "type" - Mandatory. Groups ents by their application-defined type.
// 2. "pid" (parent ID) - Optional. Encodes a hierarchy amongst ents.
// 3. "gid" (group ID) - Optional. Supports non-hierarchical grouping.
// 4. "tags" - Optional string[]; multi-value reverse index (multiEntry).
//    Like pid reverse lookup, but N:M. Opaque strings; clients define semantics
//    (e.g. impl:<btob64(eid)> for non-exclusive "implements" links).
// These are msgpack-encoded within the DIPLOMATIC msg body.
// The rest of the ent data lives alongside those, encoded the same way.

import { Decoder } from "../shared/codec.ts";
import { eidCodec } from "../shared/codecs/eid.ts";
import { Status } from "../shared/consts";
import { err, ok, ValStat } from "../shared/valstat";
import {
  EntityID,
  GroupID,
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
  eid: EntityID;
  updatedAt: Date;
  createdAt: Date;
  ctr: number;
  body: T;
}

export interface IDateRange {
  start: Date;
  end: Date;
}

export type EntitiesQuery =
  | { type: string }
  | { type: string; gid: GroupID }
  | { type: string; pid: EntityID }
  | { type: string; tag: string }
  | { type: string; updatedBetween: IDateRange };

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
  getEnt<T>(
    eid: EntityID,
  ): Promise<ValStat<IEntity<T> | undefined>>;
  getEntities<T>(
    query: EntitiesQuery,
  ): Promise<ValStat<IEntity<T>[]>>;
  countEntities({ type }: { type: string }): Promise<ValStat<number>>;
  /**
   * Frontier checksum of live rows: eid + updatedAt + ctr per ent
   * (see encodeEntRev / checksumEntRevs). Not a content hash of bodies.
   */
  checksum(crypto: ICrypto): Promise<ValStat<Hash>>;
}

/** Prior rev from a loaded entity (typical update/delete input). */
export function revFromEntity(ent: IEntity): IEntRev {
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
  curr: IEntity | undefined,
  op: IOp,
): ValStat<IEntity | undefined> {
  // Parse op EID.
  const decOpEid = new Decoder(op.eid);
  const [opEID, statOpEID] = decOpEid.readStruct(eidCodec);
  if (statOpEID !== Status.Success) {
    return err(statOpEID);
  }

  // Handle obsolete op (op outdated by curr).
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
      gid: op.gid,
      pid: op.pid,
      ...(tags !== undefined ? { tags } : {}),
      type: op.type,
      createdAt: opEID.ts,
      updatedAt: opUpdatedAt,
      ctr: op.ctr,
      body: op.body,
    });
  } else {
    // It's a deletion op.
    return ok(undefined);
  }
}

export const nullEntDB: IEntDB = {
  getEnt: async () => err(Status.NotImplemented),
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
