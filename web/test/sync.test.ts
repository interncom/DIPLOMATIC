import { beforeEach, describe, expect, test } from 'vitest';
import libsodiumCrypto from '../src/crypto';
import { NeoClient } from '../src/neoclient';
import { MockClock } from '../src/shared/clock';
import { CallbackNotifier } from '../src/shared/lpc/pusher';
import { DiplomaticLPCServer, LPCTransport } from '../src/shared/lpc/server';
import { EncodedMessage } from '../src/shared/message';
import memStorage from '../src/shared/storage/memory';
import type { IHostCrypto, IStorage, MasterSeed } from '../src/shared/types';
import { MemoryStore } from '../src/stores/memory/store';
import { IStateManager } from '../src/types';
import { Status } from '../src/shared/consts';

const hostClock = new MockClock(new Date(0));
let lpcHost: DiplomaticLPCServer;
let transport: LPCTransport;

beforeEach(() => {
  // Create fresh storage per test to avoid interference
  const storage: IStorage = {
    addUser: memStorage.addUser.bind(memStorage),
    hasUser: memStorage.hasUser.bind(memStorage),
    setBag: memStorage.setBag.bind(memStorage),
    getBody: memStorage.getBody.bind(memStorage),
    listHeads: memStorage.listHeads.bind(memStorage),
  };
  hostClock.set(new Date(0));
  lpcHost = new DiplomaticLPCServer(
    storage,
    libsodiumCrypto as IHostCrypto,
    new CallbackNotifier(),
    hostClock
  );
  transport = new LPCTransport(lpcHost);
});

const createClient = async (seed: Uint8Array) => {
  const store = new MemoryStore<any>();
  await store.init();
  const state: IStateManager = {
    async apply(msg) { return Status.Success },
    on(type, listener) { },
    off(type, listener) { },
  };
  const client = new NeoClient(
    new MockClock(new Date(0)),
    state,
    store,
    transport,
    libsodiumCrypto
  );
  await store.seed.save(seed as MasterSeed);
  return { store, client };
};

describe('Sync Integration', () => {
  test('messages sync between two clients', async () => {
    // Create shared seed for both clients
    const masterSeed = await libsodiumCrypto.gen256BitSecureRandomSeed();

    // Create two clients with the same seed
    const { store: storeA, client: clientA } = await createClient(masterSeed);
    const { store: storeB, client: clientB } = await createClient(masterSeed);

    // Link both to the same host
    await clientA.link({ handle: lpcHost, label: 'test', idx: 1 });
    await clientB.link({ handle: lpcHost, label: 'test', idx: 1 });

    // Connect both clients
    await clientA.connect(false); // No listen for simplicity
    await clientB.connect(false);

    // Client A inserts a message
    const testMessage: EncodedMessage = new Uint8Array([1, 2, 3, 4]);
    await clientA.insert(testMessage);

    // Client A syncs (pushes the message)
    await clientA.sync();

    // Client B syncs (pulls the message)
    await clientB.sync();

    // Verify the message was synced to client B
    const messages = Array.from(await storeB.messages.list());
    expect(messages.length).toBe(1);
    expect(messages[0].body).toEqual(testMessage);
  });

  test('handles multiple messages and updates', async () => {
    const masterSeed = await libsodiumCrypto.gen256BitSecureRandomSeed();
    const { store: storeA, client: clientA } = await createClient(masterSeed);
    const { store: storeB, client: clientB } = await createClient(masterSeed);

    await clientA.link({ handle: lpcHost, label: 'test', idx: 1 });
    await clientB.link({ handle: lpcHost, label: 'test', idx: 1 });
    await clientA.connect(false);
    await clientB.connect(false);

    // Insert multiple messages
    await clientA.insert(new Uint8Array([1]));
    await clientA.insert(new Uint8Array([2]));
    await clientA.sync();
    await clientB.sync();

    let messages = Array.from(await storeB.messages.list());
    expect(messages.length).toBe(2);

    // Upsert one
    const eid = messages[0].head.eid;
    await clientA.upsert(eid, new Uint8Array([3]));
    await clientA.sync();
    await clientB.sync();

    messages = Array.from(await storeB.messages.list());
    expect(messages.length).toBe(3); // Original + upsert
  });

  test('peek filter by recorded at works', async () => {
    const masterSeed = await libsodiumCrypto.gen256BitSecureRandomSeed();
    const { store: storeA, client: clientA } = await createClient(masterSeed);
    const { store: storeB, client: clientB } = await createClient(masterSeed);

    await clientA.link({ handle: lpcHost, label: 'test', idx: 1 });
    await clientB.link({ handle: lpcHost, label: 'test', idx: 1 });

    // Set host clock to time of push
    hostClock.set(new Date(1000));

    // Set clientB's lastSyncedAt to after the push time
    const hostB = await storeB.hosts.get('test');
    if (hostB) hostB.lastSyncedAt = new Date(2000);

    await clientA.connect(false);
    await clientB.connect(false);

    // Insert and sync at time 1000
    await clientA.insert(new Uint8Array([1]));
    await clientA.sync();

    // ClientB syncs with lastSyncedAt at 2000 - should not pull messages from 1000
    await clientB.sync();
    expect(Array.from(await storeB.messages.list()).length).toBe(0);
  });
});
