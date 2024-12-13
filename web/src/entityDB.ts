import { type DBSchema, openDB } from "idb";
import { Applier } from "./types";
import { IOp, Verb } from "./shared/types";
import { StateManager } from "./state";

export const entityTableName = "entities";
export const typeIndexName = "entity_type_created_at";

export interface IEntity<T> {
  eid: Uint8Array;
  pid?: Uint8Array; // Parent entity ID. Not necessarily of same type.
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
      "entity_type_created_at": [string, Date];
    };
  };
}

export const db = await openDB<IEntityDB>("db", 6, {
  upgrade(db, prevVersion, currVersion, tx) {
    if (!db.objectStoreNames.contains(entityTableName)) {
      const store = db.createObjectStore(entityTableName, {
        keyPath: "eid",
        autoIncrement: false,
      });
    }
    const store = tx.objectStore(entityTableName);
    store.createIndex("entity_type_created_at", ["type", "createdAt"], {
      unique: false,
    });
  },
});

export const applier: Applier = async (op: IOp) => {
  switch (op.verb) {
    case Verb.UPSERT: {
      const curr = await db.get("entities", op.eid);
      if (new Date(op.ts) > (curr?.updatedAt ?? "")) {
        await db.put("entities", {
          eid: op.eid,
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
