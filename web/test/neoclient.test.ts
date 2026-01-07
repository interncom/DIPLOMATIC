import { expect, test, vi } from 'vitest'
import { NeoClient } from '../src/neoclient'
import { MemoryStore } from '../src/stores/memory/store'
import { StateManager } from '../src/state'

test('instantiates NeoClient', async () => {
  const clock = { now: () => new Date() };
  const store = new MemoryStore();
  const applier = vi.fn(async () => { });
  const clear = vi.fn(async () => { });
  const state = new StateManager(applier, clear);
  const neoClient = new NeoClient(clock, state, store);
  expect(neoClient).toBeInstanceOf(NeoClient);
})
