import { beforeEach, describe, expect, test } from "vitest";
import libsodiumCrypto from "../src/crypto";
import { SyncClient } from "../src/client";
import { MockClock } from "../src/shared/clock";
import { CallbackNotifier } from "../src/shared/lpc/pusher";
import { DiplomaticLPCServer, LPCTransport } from "../src/shared/lpc/server";
import { EncodedMessage } from "../src/shared/message";
import memStorage, {
  createMemoryStorage,
} from "../src/shared/storage/memory";
import { Enclave } from "../src/shared/crypto/enclave";
import type {
  HostHandle,
  IHostConnectionInfo,
  IHostCrypto,
  IStateManager,
  IStorage,
} from "../src/shared/types";
import { MemoryStore } from "../src/stores/memory/store";
import { Status } from "../src/shared/consts";
import { err } from "../src/shared/valstat";

const hostClock = new MockClock(new Date(0));
let lpcHost: DiplomaticLPCServer;
let transport: () => LPCTransport;

beforeEach(() => {
  // Create fresh storage per test to avoid interference
  const storage: IStorage = {
    addUser: memStorage.addUser.bind(memStorage),
    hasUser: memStorage.hasUser.bind(memStorage),
    setBags: memStorage.setBags.bind(memStorage),
    getBodies: memStorage.getBodies.bind(memStorage),
    listHeads: memStorage.listHeads.bind(memStorage),
  };
  hostClock.set(new Date(0));
  lpcHost = new DiplomaticLPCServer(
    storage,
    libsodiumCrypto as IHostCrypto,
    new CallbackNotifier(),
    hostClock,
  );
  transport = () => new LPCTransport(lpcHost);
});

const createClient = async (seed: Uint8Array) => {
  const store = new MemoryStore<HostHandle>(libsodiumCrypto);
  const state: IStateManager = {
    async apply(msgs) {
      return msgs.map(() => Status.Success);
    },
    async clear() {
      return Status.Success;
    },
    notify() {},
    async refresh() {},
    on(_type, _listener) {},
    off(_type, _listener) {},
  };
  const client = new SyncClient(
    new MockClock(new Date(0)),
    state,
    store,
    transport,
    libsodiumCrypto,
  );
  const [enclave, est] = Enclave.fromBytes(seed);
  if (est !== Status.Success || enclave === undefined) {
    throw new Error(`enclave ${est}`);
  }
  await client.setSeed(enclave);
  return { store, client };
};

describe("Sync Integration", () => {
  test("messages sync between two clients", async () => {
    // Create shared seed for both clients
    const masterSeed = await libsodiumCrypto.gen256BitSecureRandomSeed();

    // Create two clients with the same seed
    const { client: clientA } = await createClient(masterSeed);
    const { store: storeB, client: clientB } = await createClient(masterSeed);

    // Link both to the same host
    await clientA.link({ handle: lpcHost, label: "test", idx: 1 });
    await clientB.link({ handle: lpcHost, label: "test", idx: 1 });

    // Connect both clients
    await clientA.connect(false); // No listen for simplicity
    await clientB.connect(false);

    // Client A inserts a message
    const testMessage: EncodedMessage = new Uint8Array([1, 2, 3, 4]);
    await clientA.insertRaw(testMessage);

    // Client A syncs (pushes the message)
    expect(await clientA.sync()).toBe(Status.Success);

    // Client B syncs (pulls the message)
    expect(await clientB.sync()).toBe(Status.Success);

    // Verify the message was synced to client B
    const messages = Array.from(await storeB.messages.list());
    expect(messages.length).toBe(1);
    expect(messages[0].body).toEqual(testMessage);
  });

  test("handles multiple messages and updates", async () => {
    const masterSeed = await libsodiumCrypto.gen256BitSecureRandomSeed();
    const { client: clientA } = await createClient(masterSeed);
    const { store: storeB, client: clientB } = await createClient(masterSeed);

    await clientA.link({ handle: lpcHost, label: "test", idx: 1 });
    await clientB.link({ handle: lpcHost, label: "test", idx: 1 });
    await clientA.connect(false);
    await clientB.connect(false);

    // Insert multiple messages
    await clientA.insertRaw(new Uint8Array([1]));
    await clientA.insertRaw(new Uint8Array([2]));
    expect(await clientA.sync()).toBe(Status.Success);
    expect(await clientB.sync()).toBe(Status.Success);

    let messages = Array.from(await storeB.messages.list());
    expect(messages.length).toBe(2);

    // Update one using prior from the latest head (same on A after insert).
    const head = messages[0].head;
    const { Decoder } = await import("../src/shared/codec");
    const { eidCodec } = await import("../src/shared/codecs/eid");
    const dec = new Decoder(head.eid);
    const [eidDec, stEid] = dec.readStruct(eidCodec);
    expect(stEid).toBe(Status.Success);
    if (!eidDec) throw new Error("eid");
    const priorA = {
      eid: head.eid,
      ctr: head.ctr,
      updatedAt: new Date(eidDec.ts.getTime() + head.off),
    };
    const [, stUp] = await clientA.updateRaw(priorA, new Uint8Array([3]));
    expect(stUp).toBe(Status.Success);
    expect(await clientA.sync()).toBe(Status.Success);
    expect(await clientB.sync()).toBe(Status.Success);

    messages = Array.from(await storeB.messages.list());
    expect(messages.length).toBe(3); // two inserts + update
  });

  test("rebuild checkHost pulls missing bags then replays archive", async () => {
    const masterSeed = await libsodiumCrypto.gen256BitSecureRandomSeed();
    const { client: clientA } = await createClient(masterSeed);
    const { store: storeB, client: clientB } = await createClient(masterSeed);

    await clientA.link({ handle: lpcHost, label: "test", idx: 1 });
    await clientB.link({ handle: lpcHost, label: "test", idx: 1 });
    await clientA.connect(false);
    await clientB.connect(false);

    const msg1: EncodedMessage = new Uint8Array([10, 20]);
    const msg2: EncodedMessage = new Uint8Array([30, 40]);
    await clientA.insertRaw(msg1);
    await clientA.insertRaw(msg2);
    expect(await clientA.sync()).toBe(Status.Success);
    expect(await clientB.sync()).toBe(Status.Success);

    let messagesB = Array.from(await storeB.messages.list());
    expect(messagesB.length).toBe(2);

    // Drop one archived msg on B (as if pruning or incomplete sync).
    const drop = messagesB[0];
    await storeB.messages.del([drop.hash]);
    messagesB = Array.from(await storeB.messages.list());
    expect(messagesB.length).toBe(1);

    // lastSeq is already at host max, so normal sync would not re-peek.
    // rebuild with checkHost inventories from seq 0 and recovers the bag.
    expect(await clientB.rebuild({ checkHost: true })).toBe(Status.Success);

    messagesB = Array.from(await storeB.messages.list());
    expect(messagesB.length).toBe(2);
    const bodies = messagesB.map((m) => m.body).sort((a, b) =>
      (a?.[0] ?? 0) - (b?.[0] ?? 0)
    );
    expect(bodies).toEqual([msg1, msg2]);
  });
});

describe("multi-host", () => {
  function numBags(storage: ReturnType<typeof createMemoryStorage>): number {
    let n = 0;
    for (const realms of storage.bag.values()) {
      for (const seqs of realms.values()) n += seqs.size;
    }
    return n;
  }

  function gate(storage: ReturnType<typeof createMemoryStorage>) {
    const listHeads = storage.listHeads.bind(storage);
    const setBags = storage.setBags.bind(storage);
    const getBodies = storage.getBodies.bind(storage);
    return {
      down() {
        storage.listHeads = () => Promise.resolve(err(Status.CommunicationError));
        storage.setBags = () => Promise.resolve(err(Status.CommunicationError));
        storage.getBodies = () =>
          Promise.resolve(err(Status.CommunicationError));
      },
      up() {
        storage.listHeads = listHeads;
        storage.setBags = setBags;
        storage.getBodies = getBodies;
      },
    };
  }

  async function setup(seed: Uint8Array) {
    const clock = new MockClock(new Date(0));
    const store1 = createMemoryStorage();
    const store2 = createMemoryStorage();
    const host1 = new DiplomaticLPCServer(
      store1,
      libsodiumCrypto,
      new CallbackNotifier(),
      clock,
    );
    const host2 = new DiplomaticLPCServer(
      store2,
      libsodiumCrypto,
      new CallbackNotifier(),
      clock,
    );
    const info1: IHostConnectionInfo<HostHandle> = {
      handle: host1,
      label: "h1",
      idx: 1,
    };
    const info2: IHostConnectionInfo<HostHandle> = {
      handle: host2,
      label: "h2",
      idx: 1,
    };
    const transport = (host: IHostConnectionInfo<HostHandle>) => {
      if (host.handle === host1) return new LPCTransport(host1);
      if (host.handle === host2) return new LPCTransport(host2);
      throw new Error("unknown host");
    };
    const open = async (onScheduleSync?: () => void) => {
      const store = new MemoryStore<HostHandle>(libsodiumCrypto);
      const state: IStateManager = {
        async apply(msgs) {
          return msgs.map(() => Status.Success);
        },
        async clear() {
          return Status.Success;
        },
        notify() {},
        async refresh() {},
        on(_type, _listener) {},
        off(_type, _listener) {},
      };
      const client = new SyncClient(
        new MockClock(new Date(0)),
        state,
        store,
        transport,
        libsodiumCrypto,
        true,
        undefined,
        undefined,
        onScheduleSync,
      );
      const [enclave, est] = Enclave.fromBytes(seed);
      if (est !== Status.Success || enclave === undefined) {
        throw new Error(`enclave ${est}`);
      }
      await client.setSeed(enclave);
      return { store, client };
    };
    return { store1, store2, info1, info2, open };
  }

  test("a dead host does not block the live one", async () => {
    const seed = await libsodiumCrypto.gen256BitSecureRandomSeed();
    const { store1, store2, info1, info2, open } = await setup(seed);
    const { client: a } = await open();
    // Dead host is first so a failure would skip the live one.
    await a.link(info2, false);
    await a.link(info1, false);
    await a.connect(false);

    await a.insertRaw(new Uint8Array([1]));
    expect(await a.sync()).toBe(Status.Success);
    expect(numBags(store1)).toBe(1);
    expect(numBags(store2)).toBe(1);

    const net = gate(store2);
    net.down();
    await a.insertRaw(new Uint8Array([2]));
    expect(await a.sync()).toBe(Status.Success);
    expect(numBags(store1)).toBe(2);
    expect(numBags(store2)).toBe(1);

    net.up();
    expect(await a.sync()).toBe(Status.Success);
    expect(numBags(store2)).toBe(2);

    const { store: storeB, client: b } = await open();
    await b.link(info2, false);
    await b.connect(false);
    expect(await b.sync()).toBe(Status.Success);
    const bodies = (await storeB.messages.list()).map((m) => m.body);
    bodies.sort((x, y) => (x?.[0] ?? 0) - (y?.[0] ?? 0));
    expect(bodies).toEqual([new Uint8Array([1]), new Uint8Array([2])]);
  });

  test("a pulled message is sealed for the other host", async () => {
    const seed = await libsodiumCrypto.gen256BitSecureRandomSeed();
    const { store1, store2, info1, info2, open } = await setup(seed);
    const { client: a } = await open();
    await a.link(info1, false);
    await a.connect(false);
    await a.insertRaw(new Uint8Array([7]));
    expect(await a.sync()).toBe(Status.Success);
    expect(numBags(store1)).toBe(1);
    expect(numBags(store2)).toBe(0);

    const { client: b } = await open();
    await b.link(info1, false);
    await b.link(info2, false);
    await b.connect(false);
    expect(await b.sync()).toBe(Status.Success);
    expect(numBags(store1)).toBe(1);
    expect(numBags(store2)).toBe(1);

    const { store: storeC, client: c } = await open();
    await c.link(info2, false);
    await c.connect(false);
    expect(await c.sync()).toBe(Status.Success);
    const msgs = await storeC.messages.list();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.body).toEqual(new Uint8Array([7]));
  });

  test("linking a host peeks before queueing the archive", async () => {
    const seed = await libsodiumCrypto.gen256BitSecureRandomSeed();
    const { store2, info1, info2, open } = await setup(seed);
    const { store: storeA, client: a } = await open();
    await a.link(info1, false);
    await a.connect(false);
    await a.insertRaw(new Uint8Array([3]));
    await a.insertRaw(new Uint8Array([4]));
    expect(await a.sync()).toBe(Status.Success);

    await a.link(info2);
    expect(await storeA.uploads.list("h2")).toHaveLength(2);
    expect(await a.sync()).toBe(Status.Success);
    expect(numBags(store2)).toBe(2);
    expect(await storeA.uploads.list("h2")).toEqual([]);

    // A cursor is stored, so re-link does not queue the archive again.
    await a.link(info2);
    expect(await storeA.uploads.list("h2")).toEqual([]);

    const { store: storeB, client: b } = await open();
    await b.link(info2, false);
    await b.connect(false);
    expect(await b.sync()).toBe(Status.Success);
    expect(await storeB.messages.list()).toHaveLength(2);
  });

  test("linking a host does not reseal a bag it already has", async () => {
    const seed = await libsodiumCrypto.gen256BitSecureRandomSeed();
    const { store1, store2, info1, info2, open } = await setup(seed);
    const { store: storeA, client: a } = await open();
    await a.link(info1, false);
    await a.connect(false);
    await a.insertRaw(new Uint8Array([3]));
    expect(await a.sync()).toBe(Status.Success);

    // Copy only [3] onto h2. [4] stays local to h1.
    const { client: c } = await open();
    await c.link(info1, false);
    await c.link(info2, false);
    await c.connect(false);
    expect(await c.sync()).toBe(Status.Success);
    expect(numBags(store2)).toBe(1);

    await a.insertRaw(new Uint8Array([4]));
    expect(await a.sync()).toBe(Status.Success);
    expect(numBags(store1)).toBe(2);
    expect(numBags(store2)).toBe(1);

    const rows = await storeA.messages.list();
    let hash4: Uint8Array | undefined;
    for (const row of rows) {
      if (row.body?.[0] === 4) hash4 = row.hash;
    }
    if (hash4 === undefined) throw new Error("missing hash");

    await a.link(info2);
    const queued = await storeA.uploads.list("h2");
    expect(queued).toHaveLength(1);
    expect(queued[0]).toEqual(hash4);

    expect(await a.sync()).toBe(Status.Success);
    expect(numBags(store2)).toBe(2);
    expect(await storeA.uploads.list("h2")).toEqual([]);
  });

  test("a notif for a local message drops that host's upload", async () => {
    const seed = await libsodiumCrypto.gen256BitSecureRandomSeed();
    const { store2, info1, info2, open } = await setup(seed);
    const { client: a } = await open();
    await a.link(info1, false);
    await a.connect(false);
    await a.insertRaw(new Uint8Array([7]));
    expect(await a.sync()).toBe(Status.Success);

    // Hold the queued upload. A scheduled sync would push it before the notif.
    const { store: storeB, client: b } = await open(() => {});
    await b.link(info1, false);
    await b.connect(false);
    expect(await b.sync()).toBe(Status.Success);

    // h2 is empty. Link peeks, queues the local message, and listens.
    await b.link(info2);
    expect(await storeB.uploads.list("h2")).toHaveLength(1);
    expect(numBags(store2)).toBe(0);

    const { client: c } = await open();
    await c.link(info1, false);
    await c.link(info2, false);
    await c.connect(false);
    expect(await c.sync()).toBe(Status.Success);
    expect(numBags(store2)).toBe(1);

    await expect.poll(async () => await storeB.uploads.list("h2")).toEqual(
      [],
    );
    const row = await storeB.hosts.get("h2");
    expect(row?.lastSeq).toBe(1);

    expect(await b.sync()).toBe(Status.Success);
    expect(numBags(store2)).toBe(1);
    expect(await storeB.uploads.list("h2")).toEqual([]);
  });
});
