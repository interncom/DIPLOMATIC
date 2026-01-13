import { max, min } from "../lib";
import { Status } from "../shared/consts";
import { EntityID, GroupID, IOp, ValStat } from "../shared/types";

export interface IEntity<T> {
  eid: EntityID;
  gid?: GroupID;
  pid?: EntityID; // Parent entity ID. Not necessarily of same type.
  type: string;
  updatedAt: Date;
  updatedCtr: number;
  createdAt: Date;
  body: T;
}

const nullEnt: IEntity<undefined> = {
  eid: new Uint8Array(),
  type: "",
  updatedCtr: 0,
  updatedAt: new Date(0),
  createdAt: new Date(0),
  body: undefined,
};

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
  getEnt<T>(eid: EntityID): Promise<ValStat<IEntity<T> | undefined>>;
  getEntities<T>(
    { type, gid, pid, updatedBetween }: EntitiesQuery,
  ): Promise<ValStat<IEntity<T>[]>>;
  countEntities({ type }: { type: string }): Promise<ValStat<number>>;
}

export function updateEnt(
  curr: IEntity<unknown> | undefined,
  op: IOp,
): [IEntity<unknown>, Status] {
  if (curr && curr.createdAt < op.ts && curr.updatedAt > op.ts) {
    return [nullEnt, Status.NoChange];
  }

  // If op came before curr, use op's ts as the createdAt.
  // If op came after curr, use op's ts as the updatedAt.
  const ts = op.ts.getTime();
  const createdTs = curr ? min(curr.createdAt.getTime(), ts) : ts;
  const updatedTs = curr ? max(curr.updatedAt.getTime(), ts) : ts;

  let updatedCtr: number;
  if (!curr) {
    updatedCtr = op.ctr;
  } else {
    const currTime = curr.updatedAt.getTime();
    const opTime = op.ts.getTime();
    if (opTime > currTime) {
      updatedCtr = op.ctr;
    } else if (opTime < currTime) {
      updatedCtr = curr.updatedCtr ?? 0;
    } else {
      updatedCtr = Math.max(curr.updatedCtr ?? 0, op.ctr);
    }
  }

  const isOpNewer = !curr || op.ts > curr.updatedAt ||
    (op.ts.getTime() === curr.updatedAt.getTime() &&
      op.ctr > (curr.updatedCtr ?? 0));
  const body = isOpNewer ? op.body : curr.body;

  const ent: IEntity<unknown> = {
    eid: op.eid,
    gid: isOpNewer ? op.gid : curr.gid,
    pid: isOpNewer ? op.pid : curr.pid,
    type: isOpNewer ? op.type : curr.type,
    createdAt: new Date(createdTs),
    updatedAt: new Date(updatedTs),
    updatedCtr,
    body,
  };

  return [ent, Status.Success];
}
