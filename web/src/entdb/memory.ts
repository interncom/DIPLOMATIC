// In-memory implementation of EntDB.
// EntDB "renders" a final database state from deltas encoded as IMessages.

import { IEntity, IEntDB } from "./entdb";
import { uint8ArraysEqual } from "../shared/binary";
import { Status } from "../shared/consts";
import { EntityID, GroupID, INeoOp } from "../shared/types";
import { updateEnt } from "./entdb";

interface IDateRange { start: Date, end: Date }

type EntitiesQuery = {
  type: string;
  gid?: GroupID;
  pid?: Uint8Array;
  updatedBetween?: IDateRange;
};

export class EntDBMemory implements IEntDB {
  ents: Map<EntityID, IEntity<unknown>> = new Map();

  async apply(op: INeoOp) {
    const curr = this.ents.get(op.eid);
    const [ent, stat] = updateEnt(curr, op);
    if (stat !== Status.Success) {
      return stat;
    }

    this.ents.set(op.eid, ent);
    return Status.Success;
  }

  async clear() {
    this.ents.clear();
    return Status.Success;
  }

  async getEnt<T>(eid: EntityID): Promise<IEntity<T> | undefined> {
    return this.ents.get(eid) as IEntity<T>;
  }

  async getEntities<T>({ type, gid, pid, updatedBetween }: EntitiesQuery): Promise<IEntity<T>[]> {
    const results: IEntity<T>[] = [];
    if (pid !== undefined) {
      for (const ent of this.ents.values()) {
        if (ent.type === type && ent.pid && uint8ArraysEqual(ent.pid, pid)) {
          results.push(ent as IEntity<T>);
        }
      }
      return results;
    }
    if (gid !== undefined) {
      for (const ent of this.ents.values()) {
        if (ent.type === type && ent.gid === gid) {
          results.push(ent as IEntity<T>);
        }
      }
      return results;
    }
    if (updatedBetween !== undefined) {
      for (const ent of this.ents.values()) {
        if (ent.type === type && ent.updatedAt >= updatedBetween.start && ent.updatedAt <= updatedBetween.end) {
          results.push(ent as IEntity<T>);
        }
      }
      return results;
    }
    for (const ent of this.ents.values()) {
      if (ent.type === type) {
        results.push(ent as IEntity<T>);
      }
    }
    return results;
  }

  async countEntities({ type }: { type: string }): Promise<number> {
    let count = 0;
    for (const ent of this.ents.values()) {
      if (ent.type === type) {
        count += 1;
      }
    }
    return count;
  }
}
