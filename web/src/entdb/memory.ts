// In-memory implementation of EntDB.
// EntDB "renders" a final database state from deltas encoded as IMessages.

import { applyOp, IEntDB, IEntity } from "./entdb";
import { btob64, bytesEqual } from "../shared/binary";
import { Status } from "../shared/consts";
import { EntityID, GroupID, IOp } from "../shared/types";
import { err, ok, ValStat } from "../shared/valstat.ts";

interface IDateRange {
  start: Date;
  end: Date;
}

type EntitiesQuery = {
  type: string;
  gid?: GroupID;
  pid?: EntityID;
  updatedBetween?: IDateRange;
};

export class EntDBMemory implements IEntDB {
  ents: Map<string, IEntity> = new Map();

  constructor(initEnts: IEntity[] = []) {
    for (const ent of initEnts) {
      const key = btob64(ent.eid);
      this.ents.set(key, ent);
    }
  }

  async apply(ops: IOp[]): Promise<Status[]> {
    const results: Status[] = [];
    for (const op of ops) {
      const key = btob64(op.eid);
      const curr = this.ents.get(key);
      const [next, stat] = applyOp(curr, op);
      if (stat !== Status.Success) {
        results.push(stat);
        continue;
      }
      if (next) {
        this.ents.set(key, next);
      } else {
        this.ents.delete(key);
      }
      results.push(Status.Success);
    }
    return results;
  }

  async clear(): Promise<Status> {
    this.ents.clear();
    return Status.Success;
  }

  async getEnt<T>(
    eid: EntityID,
  ): Promise<ValStat<IEntity<T> | undefined>> {
    const key = btob64(eid);
    const ent = this.ents.get(key);
    return ok(ent as IEntity<T>);
  }

  private async getAllEntities<T>(
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
          ent.type === type && (typeof ent.gid === "string" && ent.gid === gid)
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

  async getEntities<T>(
    query: EntitiesQuery,
  ): Promise<ValStat<IEntity<T>[]>> {
    const [ents, stat] = await this.getAllEntities<T>(query);
    if (stat !== Status.Success) {
      return err(stat);
    }
    return ok(ents);
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
