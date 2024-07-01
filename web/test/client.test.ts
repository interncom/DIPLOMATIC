import { expect, test, vi } from 'vitest'
import DiplomaticClient from '../src/client'
import { memoryStore } from '../src/memoryStore';
import { StateManager } from '../src/state';
import { Verb, type IOp } from '../src/shared/types';
import { htob } from '../src/shared/lib';

test('applies op when executing', async () => {
  const seed = htob("0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF");
  const store = memoryStore;
  const applier = vi.fn(async (op: IOp) => { });
  const stateManager = new StateManager(applier);
  const client = new DiplomaticClient({ store, stateManager });
  await client.setSeed(seed);

  const op: IOp = {
    "ts": "2024-06-28T02:30:03.971Z",
    "verb": Verb.UPSERT,
    "ver": 0,
    "type": "test",
    "body": null
  };
  await client.apply(op);
  expect(applier).toHaveBeenCalled();
})
