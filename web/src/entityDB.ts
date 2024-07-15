import { openDB, type DBSchema } from 'idb';
import { Applier } from './types';
import { IOp, Verb } from './shared/types';
import { StateManager } from './state';

export const entityTableName = 'entities';
export const typeIndexName = 'entity_type';

interface IEntityDB extends DBSchema {
  entities: {
    key: Uint8Array; // TODO: try Uint8Array;
    value: {
      eid: Uint8Array;
      type: string;
      updatedAt: Date;
      body: unknown;
    };
    indexes: {
      "entity_type": "string",
    };
  }
}

export const db = await openDB<IEntityDB>('db', 4, {
  upgrade(db) {
    const store = db.createObjectStore('entities', { keyPath: 'eid', autoIncrement: false });
    store.createIndex('entity_type', 'type');
  }
});

export const applier: Applier = async (op: IOp) => {
  switch (op.verb) {
    case Verb.UPSERT: {
      const curr = await db.get('entities', op.eid);
      if (new Date(op.ts) > (curr?.updatedAt ?? "")) {
        await db.put('entities', { eid: op.eid, type: op.type, updatedAt: new Date(op.ts), body: op.body });
      }
      break;
    }
    case Verb.DELETE: {
      await db.delete('entities', op.eid);
      break;
    }
  }
};

export const stateManager = new StateManager(applier, () => db.clear('entities'));
