import { openDB, type DBSchema } from 'idb';
import { Applier } from './types';
import { btoh } from './shared/lib';
import { IOp, Verb } from './shared/types';
import { StateManager } from './state';

export const entityTableName = 'entities';
export const typeIndexName = 'entity_type';

interface IEntityDB extends DBSchema {
  entities: {
    key: string; // TODO: try Uint8Array;
    value: {
      eid: string;
      type: string;
      updatedAt: Date;
      body: unknown;
    };
    indexes: {
      "entity_type": "string",
    };
  }
}

export const db = await openDB<IEntityDB>('db', 3, {
  upgrade(db) {
    const store = db.createObjectStore('entities', { keyPath: 'eid', autoIncrement: false });
    store.createIndex('entity_type', 'type');
  }
});

export const applier: Applier = async (op: IOp) => {
  const hex = btoh(op.eid);
  switch (op.verb) {
    case Verb.UPSERT: {
      const curr = await db.get('entities', hex);
      if (new Date(op.ts) > (curr?.updatedAt ?? "")) {
        await db.put('entities', { eid: hex, type: op.type, updatedAt: new Date(op.ts), body: op.body });
      }
      break;
    }
    case Verb.DELETE: {
      await db.delete('entities', hex);
      break;
    }
  }
};

export const stateManager = new StateManager(applier, () => db.clear('entities'));
