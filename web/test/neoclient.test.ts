import { expect, test, vi, describe, beforeEach } from 'vitest'
import { NeoClient } from '../src/neoclient'
import { MemoryStore } from '../src/stores/memory/store'
import { StateManager } from '../src/state'
import type { IHostConnectionInfo, IProtoHost } from '../src/shared/types'
import { DiplomaticLPCServer, LPCTransport } from "../src/shared/lpc/server";
import memStorage from '../../shared/storage/memory'
import libsodiumCrypto from '../src/crypto'
import { CallbackNotifier } from '../../shared/lpc/pusher'
import { MockClock } from '../../shared/clock'

const lpcHost = new DiplomaticLPCServer(
  memStorage,
  libsodiumCrypto,
  new CallbackNotifier(),
  new MockClock(new Date(0))
);

const transport = new LPCTransport(lpcHost);

describe('NeoClient', () => {
  test('instantiates NeoClient', async () => {
    const store = new MemoryStore<IProtoHost>();
    await store.init();
    const clock = { now: () => new Date() };
    const applier = vi.fn();
    const clear = vi.fn();
    const state = new StateManager(applier, clear);
    const client = new NeoClient<IProtoHost>(clock, state, store, transport);
    expect(client).toBeInstanceOf(NeoClient);
  });

  describe('link', () => {
    test('adds host to store', async () => {
      const store = new MemoryStore<IProtoHost>();
      await store.init();
      const clock = { now: () => new Date() };
      const applier = vi.fn();
      const clear = vi.fn();
      const state = new StateManager(applier, clear);
      const client = new NeoClient<IProtoHost>(clock, state, store, transport);
      const host: IHostConnectionInfo<URL> = {
        handle: new URL('https://example.com'),
        label: 'test',
        idx: 1
      };
      await client.link(host);
      const hosts = Array.from(await store.hosts.list());
      expect(hosts).toHaveLength(1);
      expect(hosts[0].label).toBe(host.label);
      expect(hosts[0].handle).toEqual(host.handle);
      expect(hosts[0].idx).toBe(host.idx);
    });
  });

  describe('unlink', () => {
    test('removes host from store', async () => {
      const store = new MemoryStore<IProtoHost>();
      await store.init();
      const clock = { now: () => new Date() };
      const applier = vi.fn();
      const clear = vi.fn();
      const state = new StateManager(applier, clear);
      const client = new NeoClient<IProtoHost>(clock, state, store, transport);
      const host: IHostConnectionInfo<IProtoHost> = {
        handle: lpcHost,
        label: 'test',
        idx: 1
      };
      await client.link(host);
      await client.unlink('test');
      const hosts = Array.from(await store.hosts.list());
      expect(hosts).toHaveLength(0);
    });
  });

  describe('getXferState', () => {
    test('with zero counts', async () => {
      const store = new MemoryStore<IProtoHost>();
      await store.init();
      const clock = { now: () => new Date() };
      const applier = vi.fn();
      const clear = vi.fn();
      const state = new StateManager(applier, clear);
      const client = new NeoClient<IProtoHost>(clock, state, store, transport);
      const xferState = await client.xferState.get();
      expect(xferState).toEqual({ numDownloads: 0, numUploads: 0 });
    });

    test('with non-zero counts', async () => {
      const store = new MemoryStore<IProtoHost>();
      await store.init();
      // Simulate some uploads and downloads
      const hash1 = new Uint8Array(32).fill(1) as any; // Approximate Hash
      const hash2 = new Uint8Array(32).fill(2) as any;
      const hash3 = new Uint8Array(32).fill(3) as any;
      await store.uploads.enq([hash1, hash2]);
      await store.downloads.enq([hash3]);
      const clock = { now: () => new Date() };
      const applier = vi.fn();
      const clear = vi.fn();
      const state = new StateManager(applier, clear);
      const client = new NeoClient<IProtoHost>(clock, state, store, transport);
      const xferState = await client.xferState.get();
      expect(xferState).toEqual({ numDownloads: 1, numUploads: 2 });
    });
  });

  describe('disconnect', () => {
    test('clears connections', async () => {
      const store = new MemoryStore<IProtoHost>();
      await store.init();
      const clock = { now: () => new Date() };
      const applier = vi.fn();
      const clear = vi.fn();
      const state = new StateManager(applier, clear);
      const client = new NeoClient<IProtoHost>(clock, state, store, transport);
      // Simulate having connections
      client.connections.set('test', {} as any);
      expect(client.connections.size).toBe(1);
      await client.disconnect();
      expect(client.connections.size).toBe(0);
    });
  });
});
