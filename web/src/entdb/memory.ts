// In-memory implementation of EntDB.
// EntDB "renders" a final database state from deltas encoded as IMessages.

import { IEntDB, IEntity } from "./entdb";
import { bytesEqual } from "../shared/binary";
import { Status } from "../shared/consts";
import { EntityID, GroupID, IOp } from "../shared/types";
import { ok, ValStat } from "../shared/valstat.ts";
import { updateEnt } from "./entdb";

interface IDateRange {
  start: Date;
  end: Date;
}

type EntitiesQuery = {
  type: string;
  gid?: GroupID;
  pid?: Uint8Array;
  updatedBetween?: IDateRange;
};

export class EntDBMemory implements IEntDB {
  ents: Map<EntityID, IEntity<unknown>> = new Map();

  constructor(initEnts: IEntity<unknown>[] = []) {
    for (const ent of initEnts) {
      this.ents.set(ent.eid, ent);
    }
  }

  async apply(op: IOp): Promise<Status> {
    const curr = this.ents.get(op.eid);
    const [ent, stat] = updateEnt(curr, op);
    if (stat !== Status.Success) {
      return stat;
    }

    this.ents.set(op.eid, ent);
    return Status.Success;
  }

  async clear(): Promise<Status> {
    this.ents.clear();
    return Status.Success;
  }

  async getEnt<T>(eid: EntityID): Promise<ValStat<IEntity<T> | undefined>> {
    const ent = this.ents.get(eid) as IEntity<T> | undefined;
    return ok(ent);
  }

  async getEntities<T>(
    { type, gid, pid, updatedBetween }: EntitiesQuery,
  ): Promise<ValStat<IEntity<T>[]>> {
    const results: IEntity<T>[] = [];
    if (pid !== undefined) {
      for (const ent of this.ents.values()) {
        if (ent.type === type && ent.pid && bytesEqual(ent.pid, pid)) {
          results.push(ent as IEntity<T>);
        }
      }
    } else if (gid !== undefined) {
      for (const ent of this.ents.values()) {
        if (
          ent.type === type &&
          ((typeof ent.gid === "string" && ent.gid === gid) ||
            (ent.gid instanceof Uint8Array && gid instanceof Uint8Array &&
              bytesEqual(ent.gid, gid)))
        ) {
          results.push(ent as IEntity<T>);
        }
      }
    } else if (updatedBetween !== undefined) {
      for (const ent of this.ents.values()) {
        if (
          ent.type === type && ent.updatedAt >= updatedBetween.start &&
          ent.updatedAt <= updatedBetween.end
        ) {
          results.push(ent as IEntity<T>);
        }
      }
    } else {
      for (const ent of this.ents.values()) {
        if (ent.type === type) {
          results.push(ent as IEntity<T>);
        }
      }
    }
    return ok(results);
  }

  async countEntities({ type }: { type: string }): Promise<ValStat<number>> {
    let count = 0;
    for (const ent of this.ents.values()) {
      if (ent.type === type) {
        count += 1;
      }
    }
    return ok(count);
  }
}
