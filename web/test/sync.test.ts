import { beforeEach, describe, expect, test } from "vitest";
import libsodiumCrypto from "../src/crypto";
import { SyncClient } from "../src/client";
import { MockClock } from "../src/shared/clock";
import { CallbackNotifier } from "../src/shared/lpc/pusher";
import { DiplomaticLPCServer, LPCTransport } from "../src/shared/lpc/server";
import { EncodedMessage } from "../src/shared/message";
import memStorage from "../src/shared/storage/memory";
import { Enclave } from "../src/shared/crypto/enclave";
import type { HostHandle, IHostCrypto, IStateManager, IStorage } from "../src/shared/types";
import { MemoryStore } from "../src/stores/memory/store";
import { Status } from "../src/shared/consts";

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
    listHeads: memStorage.listHeads.bind(memStorage) };
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
    on(_type, _listener) { },
    off(_type, _listener) { } };
  const client = new SyncClient(
    new MockClock(new Date(0)),
    state,
    store,
    transport,
    libsodiumCrypto,
  );
  const [enclave, est] = Enclave.fromBytes(libsodiumCrypto, seed);
  if (est !== Status.Success || enclave === undefined) {
    throw new Error(`enclave ${est}`);
  }
  await store.seed.save(enclave);
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
      updatedAt: new Date(eidDec.ts.getTime() + head.off) };
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
