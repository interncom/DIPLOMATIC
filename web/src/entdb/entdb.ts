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
// These are msgpack-encoded within the DIPLOMATIC msg body.
// The rest of the ent data lives alongside those, encoded the same way.

import { Decoder } from "../shared/codec.ts";
import { eidCodec } from "../shared/codecs/eid.ts";
import { Status } from "../shared/consts";
import { err, ok, ValStat } from "../shared/valstat";
import {
  EntityID,
  GroupID,
  IMsgEntBody,
  IOp,
  isMutateOp,
} from "../shared/types";
import { StateManager } from "../state.ts";

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

export type EntitiesQuery = {
  type: string;
  gid?: GroupID;
  pid?: EntityID;
  updatedBetween?: IDateRange;
};

export interface IEntDB {
  apply: (ops: IOp[]) => Promise<{ stats: Status[]; types: Set<string> }>;
  clear: () => Promise<Status>;
  getEnt<T>(
    eid: EntityID,
  ): Promise<ValStat<IEntity<T> | undefined>>;
  getEntities<T>(
    { type, gid, pid, updatedBetween }: EntitiesQuery,
  ): Promise<ValStat<IEntity<T>[]>>;
  countEntities({ type }: { type: string }): Promise<ValStat<number>>;
}

export function entStateManager(edb: IEntDB): StateManager {
  return new StateManager(edb.apply, edb.clear);
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
    return ok({
      eid: op.eid,
      gid: op.gid,
      pid: op.pid,
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
  getEntities: async () => err(Status.NotImplemented),
  countEntities: async () => err(Status.NotImplemented),
  apply: async (ops: IOp[]) => ({
    stats: ops.map(() => Status.NotImplemented),
    types: new Set(),
  }),
  clear: async () => Status.NotImplemented,
};
