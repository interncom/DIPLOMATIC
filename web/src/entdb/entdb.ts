import { max } from "../lib";
import { Decoder } from "../shared/codec.ts";
import { eidCodec } from "../shared/codecs/eid.ts";
import { Status } from "../shared/consts";
import { EntityID, GroupID, IMsgEntBody, IOp } from "../shared/types";
import { err, ok, ValStat } from "../shared/valstat.ts";
import { StateManager } from "../state.ts";

export interface IPossiblyDeletedEntity<T> extends IMsgEntBody<T> {
  eid: EntityID;
  updatedAt: Date;
  createdAt: Date;
  ctr: number;
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
  const decOpEid = new Decoder(op.eid);
  const [opEID, statOpEID] = decOpEid.readStruct(eidCodec);
  if (statOpEID !== Status.Success) {
    return err(statOpEID);
  }

  const messageTs = new Date(opEID.ts.getTime() + op.off);
  if (curr && messageTs <= curr.createdAt) {
    return err(Status.NoChange);
  }

  if (curr && curr.createdAt.getTime() !== opEID.ts.getTime()) {
    // CLK is part of the entity ID.
    // If CLK's don't match, they are not the same entity.
    return err(Status.NotFound);
  }
  const createdTs = opEID.ts.getTime();

  // updatedAt is max of current and messageTs
  const updatedTs = curr
    ? max(curr.updatedAt.getTime(), messageTs.getTime())
    : messageTs.getTime();

  let ctr: number;
  if (!curr) {
    ctr = op.ctr;
  } else {
    const currTime = curr.updatedAt.getTime();
    const opTime = messageTs.getTime();
    if (opTime > currTime) {
      ctr = op.ctr;
    } else if (opTime < currTime) {
      ctr = curr.ctr ?? 0;
    } else {
      ctr = Math.max(curr.ctr ?? 0, op.ctr);
    }
  }

  const ts = opEID.ts.getTime() + op.off;
  const isOpNewer = !curr || ts > curr.updatedAt.getTime() ||
    (ts === curr.updatedAt.getTime() &&
      op.ctr > (curr.ctr ?? 0));
  const body = isOpNewer ? op.body : curr.body;

  const ent: IPossiblyDeletedEntity<T> = {
    eid: op.eid,
    gid: isOpNewer ? op.gid : curr.gid,
    pid: isOpNewer ? op.pid : curr.pid,
    type: isOpNewer ? op.type : curr.type,
    createdAt: new Date(createdTs),
    updatedAt: new Date(updatedTs),
    ctr,
    body,
  };

  return ok(ent);
}

export const nullEntDB: IEntDB = {
  getEnt: async () => err(Status.NotImplemented),
  getEntities: async () => err(Status.NotImplemented),
  countEntities: async () => err(Status.NotImplemented),
  apply: async (ops: IOp[]) => ops.map(() => Status.NotImplemented),
  clear: async () => Status.NotImplemented,
};
