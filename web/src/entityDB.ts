import { type DBSchema, openDB } from "idb";
import type { Applier } from "./types";
import { type EntityID, type GroupID, type IOp, Verb } from "./shared/types";
import { StateManager } from "./state";

export const entityTableName = "entities";
export const typeIndexName = "entity_type_created_at";
export const typeGroupIndexName = "entity_type_group_id";
export const typeParentIndexName = "entity_type_parent_id";

export interface IEntity<T> {
  eid: EntityID;
  gid?: GroupID;
  pid?: EntityID; // Parent entity ID. Not necessarily of same type.
  type: string;
  updatedAt: Date;
  createdAt: Date;
  body: T;
}

interface IEntityDB extends DBSchema {
  entities: {
    key: Uint8Array; // TODO: try Uint8Array;
    value: IEntity<unknown>;
    indexes: {
      [typeIndexName]: [string, Date];
      [typeGroupIndexName]: [string, GroupID];
      [typeParentIndexName]: [string, EntityID];
    };
  };
}

export const db = await openDB<IEntityDB>("db", 9, {
  upgrade(db, prevVersion, currVersion, tx) {
    if (!db.objectStoreNames.contains(entityTableName)) {
      const store = db.createObjectStore(entityTableName, {
        keyPath: "eid",
        autoIncrement: false,
      });
    }
    const store = tx.objectStore(entityTableName);
    if (!store.indexNames.contains(typeIndexName)) {
      store.createIndex(typeIndexName, ["type", "createdAt"], {
        unique: false,
      });
    }
    if (!store.indexNames.contains(typeGroupIndexName)) {
      store.createIndex(typeGroupIndexName, ["type", "gid"], {
        unique: false,
      });
    }
    if (!store.indexNames.contains(typeParentIndexName)) {
      store.createIndex(typeParentIndexName, ["type", "pid"], {
        unique: false,
      });
    }
  },
});

export const applier: Applier = async (op: IOp) => {
  switch (op.verb) {
    case Verb.UPSERT: {
      const curr = await db.get("entities", op.eid);
      if (new Date(op.ts) > (curr?.updatedAt ?? "")) {
        await db.put("entities", {
          eid: op.eid,
          gid: op.gid,
          pid: op.pid,
          type: op.type,
          createdAt: curr?.createdAt ?? new Date(),
          updatedAt: new Date(op.ts),
          body: op.body,
        });
      }
      break;
    }
    case Verb.DELETE: {
      await db.delete("entities", op.eid);
      break;
    }
  }
};

export const stateManager = new StateManager(
  applier,
  () => db.clear("entities"),
);
