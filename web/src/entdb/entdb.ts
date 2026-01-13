import { min, max } from "../lib";
import { Status } from "../shared/consts";
import { EntityID, GroupID, INeoOp } from "../shared/types";

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
}

export function updateEnt(curr: IEntity<unknown> | undefined, op: INeoOp): [IEntity<unknown>, Status] {
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

  const isOpNewer = !curr || op.ts > curr.updatedAt || (op.ts.getTime() === curr.updatedAt.getTime() && op.ctr > (curr.updatedCtr ?? 0));
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
  }

  return [ent, Status.Success];
}
