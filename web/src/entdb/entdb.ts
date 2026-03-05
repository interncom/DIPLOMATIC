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
  apply: (ops: IOp[]) => Promise<Status[]>;
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
  const apply = async (ops: IOp[]) => {
    const stats = await edb.apply(ops);
    return stats;
  };
  return new StateManager(apply, edb.clear);
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
  apply: async (ops: IOp[]) => ops.map(() => Status.NotImplemented),
  clear: async () => Status.NotImplemented,
};
