import {
  type EntityID,
  type GroupID,
  type IDeleteOp,
  type IOp,
  type IUpsertOp,
  Verb,
} from "./types.ts";

export function genUpsertOp<T>(
  eid: EntityID,
  type: string,
  body: T,
  version = 0,
  gid?: GroupID,
  pid?: EntityID,
): IUpsertOp {
  return {
    eid,
    gid,
    pid,
    ts: new Date().toISOString(),
    type,
    verb: Verb.UPSERT,
    ver: version,
    body,
  };
}

export function genDeleteOp<T>(
  eid: Uint8Array,
  type: string,
  version = 0,
): IDeleteOp {
  return {
    eid,
    ts: new Date().toISOString(),
    type,
    verb: Verb.DELETE,
    ver: version,
  };
}

export function isOp(op: any): op is IOp {
  return typeof op.ts === "string" &&
    (op.verb === "UPSERT" || op.verb === "DELETE") &&
    typeof op.type === "string" &&
    typeof op.ver === "number" &&
    op.ver >= 0 &&
    op.body !== undefined;
}
