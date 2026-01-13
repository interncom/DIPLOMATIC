// In-memory implementation of EntDB.
// EntDB "renders" a final database state from deltas encoded as IMessages.

import { IEntity } from "./entdb";
import { uint8ArraysEqual } from "../shared/binary";
import { Status } from "../shared/consts";
import { EntityID, GroupID, INeoOp } from "../shared/types";
import { IEntDB } from "../types";
import { updateEnt } from "./entdb";

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
}
