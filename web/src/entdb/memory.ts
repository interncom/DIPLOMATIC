// In-memory implementation of EntDB.
// EntDB "renders" a final database state from deltas encoded as IMessages.

import { IEntDB, IEntity, IPossiblyDeletedEntity, isLiveEntity } from "./entdb";
import { btob64, bytesEqual } from "../shared/binary";
import { Status } from "../shared/consts";
import { EntityID, GroupID, IOp } from "../shared/types";
import { err, ok, ValStat } from "../shared/valstat.ts";
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
  ents: Map<string, IPossiblyDeletedEntity<unknown>> = new Map();

  constructor(initEnts: IPossiblyDeletedEntity<unknown>[] = []) {
    for (const ent of initEnts) {
      const key = btob64(ent.eid);
      this.ents.set(key, ent);
    }
  }

  async apply(op: IOp): Promise<Status> {
    const key = btob64(op.eid);
    const curr = this.ents.get(key);
    const [ent, stat] = updateEnt(curr, op);
    if (stat !== Status.Success) {
      return stat;
    }

    const newKey = btob64(ent.eid);
    this.ents.set(newKey, ent);
    return Status.Success;
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
    if (ent && isLiveEntity(ent)) {
      return ok(ent as IEntity<T>);
    }
    return ok(undefined);
  }

  private async getAllEntities<T>(
    { type, gid, pid, updatedBetween }: EntitiesQuery,
  ): Promise<ValStat<IPossiblyDeletedEntity<T>[]>> {
    const results: IPossiblyDeletedEntity<T>[] = [];
    if (pid !== undefined) {
      for (const ent of this.ents.values()) {
        if (ent.type === type && ent.pid && bytesEqual(ent.pid, pid)) {
          results.push(ent as IPossiblyDeletedEntity<T>);
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
          results.push(ent as IPossiblyDeletedEntity<T>);
        }
      }
    } else if (updatedBetween !== undefined) {
      for (const ent of this.ents.values()) {
        if (
          ent.type === type && ent.updatedAt >= updatedBetween.start &&
          ent.updatedAt <= updatedBetween.end
        ) {
          results.push(ent as IPossiblyDeletedEntity<T>);
        }
      }
    } else {
      for (const ent of this.ents.values()) {
        if (ent.type === type) {
          results.push(ent as IPossiblyDeletedEntity<T>);
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
    const liveEnts = ents.filter(isLiveEntity);
    return ok(liveEnts);
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
