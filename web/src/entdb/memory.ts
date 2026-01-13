// In-memory implementation of EntDB.
// EntDB "renders" a final database state from deltas encoded as IMessages.

import { IEntity } from "../entdb";
import { min, max } from "../lib";
import { uint8ArraysEqual } from "../shared/binary";
import { Status } from "../shared/consts";
import { EntityID, GroupID, INeoOp } from "../shared/types";
import { IEntDB } from "../types";

export class EntDBMemory implements IEntDB {
  ents: Map<EntityID, IEntity<unknown>> = new Map();

  async getByEID(eid: EntityID): Promise<IEntity<unknown> | undefined> {
    return this.ents.get(eid);
  }

  async getByGID(gid: GroupID): Promise<Iterable<IEntity<unknown>>> {
    if (!gid) {
      return [];
    }
    const ents: IEntity<unknown>[] = [];
    for (const ent of this.ents.values()) {
      if (!ent.gid) {
        continue;
      }
      if (typeof gid === "string") {
        if (ent.gid === gid) {
          ents.push(ent);
        }
      } else {
        if (ent.gid instanceof Uint8Array && uint8ArraysEqual(ent.gid, gid)) {
          ents.push(ent);
        }
      }
    }
    return ents;
  }

  async getByPID(pid: EntityID): Promise<Iterable<IEntity<unknown>>> {
    if (!pid) {
      return [];
    }
    const ents: IEntity<unknown>[] = [];
    for (const ent of this.ents.values()) {
      if (ent.pid && uint8ArraysEqual(ent.pid, pid)) {
        ents.push(ent);
      }
    }
    return ents;
  }

  async getByType(type: string): Promise<Iterable<IEntity<unknown>>> {
    if (!type) {
      return [];
    }
    const ents: IEntity<unknown>[] = [];
    for (const ent of this.ents.values()) {
      if (ent.type === type) {
        ents.push(ent);
      }
    }
    return ents;
  }

  async apply(op: INeoOp) {
    const curr = this.ents.get(op.eid);
    if (curr && curr.createdAt < op.ts && curr.updatedAt > op.ts) {
      return Status.NoChange;
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

    this.ents.set(op.eid, ent);
    return Status.Success;
  }

  async clear() {
    this.ents.clear();
    return Status.Success;
  }
}
