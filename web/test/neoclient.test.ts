import { expect, test, vi, describe, beforeEach } from 'vitest'
import { NeoClient } from '../src/neoclient'
import { MemoryStore } from '../src/stores/memory/store'
import { StateManager } from '../src/state'
import type { IHostConnectionInfo } from '../src/shared/types'

describe('NeoClient', () => {
  let clock: any;
  let state: any;

  beforeEach(() => {
    clock = { now: () => new Date() };
    const applier = vi.fn();
    const clear = vi.fn();
    state = new StateManager(applier, clear);
  });

  test('instantiates NeoClient', async () => {
    const store = new MemoryStore();
    await store.init();
    const client = new NeoClient(clock, state, store);
    expect(client).toBeInstanceOf(NeoClient);
  });

  test('link adds host to store', async () => {
    const store = new MemoryStore();
    await store.init();
    const client = new NeoClient(clock, state, store);
    const host: IHostConnectionInfo = {
      url: new URL('https://example.com'),
      label: 'test',
      idx: 1
    };
    await client.link(host);
    const hosts = Array.from(await store.hosts.list());
    expect(hosts).toHaveLength(1);
    expect(hosts[0].label).toBe(host.label);
    expect(hosts[0].url).toEqual(host.url);
    expect(hosts[0].idx).toBe(host.idx);
  });

  test('unlink removes host from store', async () => {
    const store = new MemoryStore();
    await store.init();
    const client = new NeoClient(clock, state, store);
    const host: IHostConnectionInfo = {
      url: new URL('https://example.com'),
      label: 'test',
      idx: 1
    };
    await client.link(host);
    await client.unlink('test');
    const hosts = Array.from(await store.hosts.list());
    expect(hosts).toHaveLength(0);
  });

  test('getXferState with zero counts', async () => {
    const store = new MemoryStore();
    await store.init();
    const client = new NeoClient(clock, state, store);
    const xferState = await client.xferState.get();
    expect(xferState).toEqual({ numDownloads: 0, numUploads: 0 });
  });

  test('getXferState with non-zero counts', async () => {
    const store = new MemoryStore();
    await store.init();
    // Simulate some uploads and downloads
    const hash1 = new Uint8Array(32).fill(1) as any; // Approximate Hash
    const hash2 = new Uint8Array(32).fill(2) as any;
    const hash3 = new Uint8Array(32).fill(3) as any;
    await store.uploads.enq([hash1, hash2]);
    await store.downloads.enq([hash3]);
    const client = new NeoClient(clock, state, store);
    const xferState = await client.xferState.get();
    expect(xferState).toEqual({ numDownloads: 1, numUploads: 2 });
  });
});
