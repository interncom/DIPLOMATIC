import { max } from "../lib";
import { Status } from "../shared/consts";
import { EntityID, GroupID, IOp } from "../shared/types";
import { err, ok, ValStat } from "../shared/valstat.ts";
import { StateManager } from "../state.ts";

export interface IPossiblyDeletedEntity<T> {
  eid: EntityID;
  gid?: GroupID;
  pid?: EntityID; // Parent entity ID. Not necessarily of same type.
  type: string;
  updatedAt: Date;
  updatedCtr: number;
  createdAt: Date;
  body: T | undefined;
}

export interface IEntity<T> extends Omit<IPossiblyDeletedEntity<T>, 'body'> {
  body: T;
}

export function isLiveEntity<T>(ent: IPossiblyDeletedEntity<T>): ent is IEntity<T> {
  return ent.body !== undefined;
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
  apply: (op: IOp) => Promise<Status>;
  clear: () => Promise<Status>;
  getEnt<T>(
    eid: EntityID,
    createdAt: Date,
  ): Promise<ValStat<IEntity<T> | undefined>>;
  getEntities<T>(
    { type, gid, pid, updatedBetween }: EntitiesQuery,
  ): Promise<ValStat<IEntity<T>[]>>;
  countEntities({ type }: { type: string }): Promise<ValStat<number>>;
}

export function entStateManager(edb: IEntDB): StateManager {
  return new StateManager(edb.apply, edb.clear);
}

export function updateEnt<T = unknown>(
  curr: IPossiblyDeletedEntity<T> | undefined,
  op: IOp<T>,
): ValStat<IPossiblyDeletedEntity<T>> {
  const messageTs = new Date(op.clk.getTime() + op.off);
  if (curr && messageTs <= curr.createdAt) {
    return err(Status.NoChange);
  }

  if (curr && curr.createdAt.getTime() !== op.clk.getTime()) {
    // CLK is part of the entity ID.
    // If CLK's don't match, they are not the same entity.
    return err(Status.NotFound);
  }
  const createdTs = op.clk.getTime();

  // updatedAt is max of current and messageTs
  const updatedTs = curr
    ? max(curr.updatedAt.getTime(), messageTs.getTime())
    : messageTs.getTime();

  let updatedCtr: number;
  if (!curr) {
    updatedCtr = op.ctr;
  } else {
    const currTime = curr.updatedAt.getTime();
    const opTime = messageTs.getTime();
    if (opTime > currTime) {
      updatedCtr = op.ctr;
    } else if (opTime < currTime) {
      updatedCtr = curr.updatedCtr ?? 0;
    } else {
      updatedCtr = Math.max(curr.updatedCtr ?? 0, op.ctr);
    }
  }

  const ts = op.clk.getTime() + op.off;
  const isOpNewer = !curr || ts > curr.updatedAt.getTime() ||
    (ts === curr.updatedAt.getTime() &&
      op.ctr > (curr.updatedCtr ?? 0));
  const body = isOpNewer ? op.body : curr.body;

  const ent: IPossiblyDeletedEntity<T> = {
    eid: op.eid,
    gid: isOpNewer ? op.gid : curr.gid,
    pid: isOpNewer ? op.pid : curr.pid,
    type: isOpNewer ? op.type : curr.type,
    createdAt: new Date(createdTs),
    updatedAt: new Date(updatedTs),
    updatedCtr,
    body,
  };

  return ok(ent);
}

export const nullEntDB: IEntDB = {
  getEnt: async () => err(Status.NotImplemented),
  getEntities: async () => err(Status.NotImplemented),
  countEntities: async () => err(Status.NotImplemented),
  apply: async (op: IOp) => Status.NotImplemented,
  clear: async () => Status.NotImplemented,
};
