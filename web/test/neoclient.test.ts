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
import { EncodedMessage } from '../src/shared/message'

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

  describe('insert', () => {
    test('stores an insert message', async () => {
      const store = new MemoryStore<IProtoHost>();
      await store.init();
      const clock = { now: () => new Date(1234567890000) };
      const applier = vi.fn();
      const clear = vi.fn();
      const state = new StateManager(applier, clear);
      const client = new NeoClient<IProtoHost>(clock, state, store, transport);
      const body: EncodedMessage = new Uint8Array([1, 2, 3]);
      await client.insert(body);
      const uploads = await store.uploads.count();
      expect(uploads).toBe(1);
      const messages = Array.from(await store.messages.list());
      expect(messages.length).toBe(1);
      const msg = messages[0];
      expect(msg.body).toBeUndefined();
      expect(msg.head.ctr).toBe(0);
      expect(msg.head.len).toBe(body.length);
    });
  });

  describe('upsert', () => {
    test('stores upsert message and increments counter', async () => {
      const store = new MemoryStore<IProtoHost>();
      await store.init();
      const clock = { now: () => new Date(1234567890000) };
      const applier = vi.fn();
      const clear = vi.fn();
      const state = new StateManager(applier, clear);
      const client = new NeoClient<IProtoHost>(clock, state, store, transport);
      const eid = new Uint8Array(32).fill(0);
      const body1: EncodedMessage = new Uint8Array([4, 5, 6]);
      const body2: EncodedMessage = new Uint8Array([7, 8, 9]);
      await client.upsert(eid, body1);
      let messages = Array.from(await store.messages.list());
      expect(messages.length).toBe(1);
      expect(messages[0].head.ctr).toBe(0);
      expect(messages[0].body).toEqual(body1);
      expect(messages[0].head.len).toBe(body1.length);
      await client.upsert(eid, body2);
      messages = Array.from(await store.messages.list());
      expect(messages.length).toBe(2);
      expect(messages[1].head.ctr).toBe(1);
      expect(messages[1].body).toEqual(body2);
      expect(messages[1].head.len).toBe(body2.length);
      const uploads = await store.uploads.count();
      expect(uploads).toBe(2);
    });
  });

  describe('delete', () => {
    test('stores delete message and increments counter', async () => {
      const store = new MemoryStore<IProtoHost>();
      await store.init();
      const clock = { now: () => new Date(1234567890000) };
      const applier = vi.fn();
      const clear = vi.fn();
      const state = new StateManager(applier, clear);
      const client = new NeoClient<IProtoHost>(clock, state, store, transport);
      const eid = new Uint8Array(32).fill(1);
      await client.upsert(eid, new Uint8Array([10, 11]));
      await client.delete(eid);
      const messages = Array.from(await store.messages.list());
      expect(messages.length).toBe(2);
      const upsertMsg = messages[0];
      expect(upsertMsg.head.ctr).toBe(0);
      expect(upsertMsg.head.len).toBe(2); // new Uint8Array([10, 11]) length 2
      const deleteMsg = messages[1];
      expect(deleteMsg.head.ctr).toBe(1);
      expect(deleteMsg.head.len).toBe(0);
      expect(deleteMsg.body).toBeUndefined();
      const uploads = await store.uploads.count();
      expect(uploads).toBe(2);
    });
  });
});
