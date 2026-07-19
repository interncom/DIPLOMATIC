import { beforeEach, describe, expect, test } from "vitest";
import { syncPeek, syncPull, syncPush } from "../src/sync";
import { MemoryStore } from "../src/stores/memory/store";
import DiplomaticClientAPI from "../src/shared/client";
import libsodiumCrypto from "../src/crypto";
import { Enclave } from "../src/shared/enclave";
import { MockClock } from "../src/shared/clock";
import { DiplomaticLPCServer, LPCTransport } from "../src/shared/lpc/server";
import { CallbackNotifier } from "../src/shared/lpc/pusher";
import memStorage from "../src/shared/storage/memory";
import { sealBag } from "../src/shared/bag";
import { Encoder } from "../src/shared/codec";
import { messageHeadCodec } from "../src/shared/codecs/messageHead";
import {
  Hash,
  HostHandle,
  HostSpecificKeyPair,
  MasterSeed,
  IMessage,
} from "../src/shared/types";
import { Status } from "../src/shared/consts";
import { IDownloadMessage, IStoredMessageData } from "../src/types";

// Fixed seed for deterministic key derivation
const testSeed = new Uint8Array(32).fill(0x42) as MasterSeed;

async function generateTestKeys(enclave: Enclave) {
  const hostSeed = await enclave.derive("test", 1);
  return await libsodiumCrypto.deriveEd25519KeyPair(
    hostSeed,
  ) as HostSpecificKeyPair;
}

async function createTestBag(message: IMessage, enclave: Enclave) {
  const keys = await generateTestKeys(enclave);
  return sealBag(message, keys, libsodiumCrypto, enclave);
}

describe("syncPeek", () => {
  let store: MemoryStore<HostHandle>;
  let enclave: Enclave;
  let clock: MockClock;
  // deno-lint-ignore no-explicit-any
  let host: any;
  let conn: DiplomaticClientAPI<HostHandle>;
  let lpcHost: DiplomaticLPCServer;
  let transport: LPCTransport;

  beforeEach(async () => {
    store = new MemoryStore(libsodiumCrypto);
    enclave = new Enclave(testSeed, libsodiumCrypto);
    clock = new MockClock(new Date(0));
    host = { label: "test", idx: 1, lastSyncedAt: new Date(0), lastSeq: 0 };
    // Create fresh storage and host per test
    const storage = { ...memStorage };
    lpcHost = new DiplomaticLPCServer(
      storage,
      libsodiumCrypto,
      new CallbackNotifier(),
      new MockClock(new Date(0)),
    );
    transport = new LPCTransport(lpcHost);
    conn = new DiplomaticClientAPI(
      enclave,
      libsodiumCrypto,
      host,
      clock,
      transport,
      () => Promise.resolve(Status.Success),
    );
    const keys = await conn.keys();
    const [_, addStatus] = await lpcHost.storage.addUser(keys.publicKey);
    expect(addStatus).toBe(Status.Success);
  });

  test("handles empty peek results", async () => {
    await syncPeek({ conn, store, enclave, clock, host, crypto: libsodiumCrypto });

    const downloads = Array.from(await store.downloads.list());
    expect(downloads.length).toBe(0);
  });

  test("dequeues upload for msg that host already has", async () => {
    const message: IMessage = {
      eid: new Uint8Array(16).fill(1),
      off: 0,
      ctr: 0,
      len: 4,
      bod: new Uint8Array([1, 2, 3, 4]),
    };

    // Seal bag using same host keys that conn will use, and put on host.
    const keys = await generateTestKeys(enclave);
    const [bag, statBag] = await sealBag(message, keys, libsodiumCrypto, enclave);
    if (statBag !== Status.Success || !bag) {
      expect(statBag).toBe(Status.Success);
      return;
    }
    const [seq, setStatus] = await lpcHost.storage.setBag(keys.publicKey, bag);
    if (setStatus !== Status.Success) {
      expect(setStatus).toBe(Status.Success);
      return;
    }

    // Compute headEncHash exactly as sealBag + decryptPeekItem will see it (hsh is included when len>0).
    let hsh: Uint8Array | undefined;
    if (message.bod && message.len > 0) {
      hsh = await libsodiumCrypto.blake3(message.bod);
    }
    const enc = new Encoder();
    const encStat = messageHeadCodec.encode(enc, { ...message, hsh });
    expect(encStat).toBe(Status.Success);
    const headEnc = enc.result();
    const headEncHash = await libsodiumCrypto.blake3(headEnc) as Hash;

    // Store locally (simulating we created it here).
    const storedData: IStoredMessageData = {
      eid: message.eid,
      ...(message.off !== 0 ? { off: message.off } : {}),
      ...(message.ctr !== 0 ? { ctr: message.ctr } : {}),
      body: message.bod,
    };
    await store.messages.add([{ key: headEncHash, data: storedData }]);

    // Enqueue for upload to this host.
    await store.uploads.enq("test", [headEncHash]);
    expect(await store.uploads.list("test")).toContainEqual(headEncHash);

    // Peek should notice we already have it locally, skip download, and dequeue the upload.
    const stat = await syncPeek({ conn, store, enclave, clock, host, crypto: libsodiumCrypto });
    expect(stat).toBe(Status.Success);

    // Upload was dequeued because host already has it.
    const remainingUploads = await store.uploads.list("test");
    expect(remainingUploads.length).toBe(0);

    // No download was enqueued.
    const downloads = Array.from(await store.downloads.list());
    expect(downloads.length).toBe(0);
  });
});

describe("syncPush", () => {
  let store: MemoryStore<HostHandle>;
  let enclave: Enclave;
  let clock: MockClock;
  // deno-lint-ignore no-explicit-any
  let host: any;
  let conn: DiplomaticClientAPI<HostHandle>;
  let lpcHost: DiplomaticLPCServer;
  let transport: LPCTransport;

  beforeEach(async () => {
    store = new MemoryStore(libsodiumCrypto);
    enclave = new Enclave(testSeed, libsodiumCrypto);
    clock = new MockClock(new Date(0));
    host = { label: "test", idx: 1 };
    // Create fresh storage and host per test
    const storage = { ...memStorage };
    lpcHost = new DiplomaticLPCServer(
      storage,
      libsodiumCrypto,
      new CallbackNotifier(),
      new MockClock(new Date(0)),
    );
    transport = new LPCTransport(lpcHost);
    conn = new DiplomaticClientAPI(
      enclave,
      libsodiumCrypto,
      host,
      clock,
      transport,
      () => Promise.resolve(Status.Success),
    );
    const keys = await conn.keys();
    const [_, addStatus] = await lpcHost.storage.addUser(keys.publicKey);
    expect(addStatus).toBe(Status.Success);
  });

  async function enqueueMsg(body: Uint8Array, eidFill: number): Promise<Hash> {
    const message: IMessage = {
      eid: new Uint8Array(16).fill(eidFill),
      off: 0,
      ctr: 0,
      len: body.length,
      bod: body,
    };
    const enc = new Encoder();
    enc.writeStruct(messageHeadCodec, message);
    const headEnc = enc.result();
    const hash = await libsodiumCrypto.blake3(headEnc) as Hash;
    const storedData: IStoredMessageData = {
      eid: message.eid,
      body: message.bod,
    };
    await store.messages.add([{ key: hash, data: storedData }]);
    await store.uploads.enq("test", [hash]);
    return hash;
  }

  test("pushes uploads successfully", async () => {
    await store.hosts.add({ label: "test", handle: lpcHost, idx: 1 });
    await enqueueMsg(new Uint8Array([1, 2, 3, 4]), 1);

    await syncPush({
      conn,
      store,
      enclave,
      clock,
      host,
      crypto: libsodiumCrypto,
    });

    expect(await store.uploads.count()).toBe(0);
  });

  test("drains upload queue under a tight maxPushBytes budget", async () => {
    await store.hosts.add({ label: "test", handle: lpcHost, idx: 1 });
    await enqueueMsg(new Uint8Array([1]), 1);
    await enqueueMsg(new Uint8Array([2]), 2);
    await enqueueMsg(new Uint8Array([3]), 3);

    // Force one bag per request (any single bag exceeds a 1-byte budget).
    // Packing multi-batch behavior is unit-tested in sync-batch.test.ts.
    const stat = await syncPush({
      conn,
      store,
      enclave,
      clock,
      host,
      crypto: libsodiumCrypto,
      maxPushBytes: 1,
    });

    expect(stat).toBe(Status.Success);
    expect(await store.uploads.count()).toBe(0);
  });
});

describe("syncPull", () => {
  let store: MemoryStore<HostHandle>;
  let enclave: Enclave;
  let clock: MockClock;
  // deno-lint-ignore no-explicit-any
  let host: any;
  let conn: DiplomaticClientAPI<HostHandle>;
  let lpcHost: DiplomaticLPCServer;
  let transport: LPCTransport;

  beforeEach(async () => {
    store = new MemoryStore(libsodiumCrypto);
    enclave = new Enclave(testSeed, libsodiumCrypto);
    clock = new MockClock(new Date(0));
    host = { label: "test", idx: 1 };
    // Create fresh storage and host per test
    const storage = { ...memStorage };
    lpcHost = new DiplomaticLPCServer(
      storage,
      libsodiumCrypto,
      new CallbackNotifier(),
      new MockClock(new Date(0)),
    );
    transport = new LPCTransport(lpcHost);
    conn = new DiplomaticClientAPI(
      enclave,
      libsodiumCrypto,
      host,
      clock,
      transport,
      () => Promise.resolve(Status.Success),
    );
    const keys = await conn.keys();
    const [_, addStatus] = await lpcHost.storage.addUser(keys.publicKey);
    expect(addStatus).toBe(Status.Success);
  });

  test("pulls and processes downloads", async () => {
    const message: IMessage = {
      eid: new Uint8Array(16).fill(1),
      off: 0,
      ctr: 0,
      len: 4,
      bod: new Uint8Array([1, 2, 3, 4]),
      hsh: await libsodiumCrypto.blake3(new Uint8Array([1, 2, 3, 4])),
    };
    const [bag, statBag] = await createTestBag(message, enclave);
    if (statBag !== Status.Success) {
      expect(statBag).toBe(Status.Success);
      return;
    }

    // Add bag to host storage
    const keys = await generateTestKeys(enclave);
    const [seq, setStatus] = await lpcHost.storage.setBag(
      keys.publicKey,
      bag,
    );
    if (setStatus !== Status.Success) {
      expect(setStatus).toBe(Status.Success);
      return;
    }

    const download: IDownloadMessage = {
      kdm: bag.kdm,
      head: message,
      host: "test",
      seq,
    };
    await store.downloads.enq([download]);

    const apply = async (parts: { head: unknown }[]) =>
      parts.map(() => Status.Success);
    await syncPull({
      conn,
      store,
      enclave,
      host,
      crypto: libsodiumCrypto,
      clock,
    }, apply);

    const messages = Array.from(await store.messages.list());
    expect(messages.length).toBe(1);
    expect(messages[0].body).toEqual(message.bod);
    expect(await store.downloads.count()).toBe(0);
  });

  test("handles no downloads", async () => {
    const apply = async (parts: { head: unknown }[]) =>
      parts.map(() => Status.Success);
    const stat = await syncPull({
      conn,
      store,
      enclave,
      host,
      crypto: libsodiumCrypto,
      clock,
    }, apply);

    expect(stat).toBe(Status.NoChange);
    const messages = Array.from(await store.messages.list());
    expect(messages.length).toBe(0);
  });

  test("handles messages without body", async () => {
    const message: IMessage = {
      eid: new Uint8Array(16).fill(1),
      off: 0,
      ctr: 0,
      len: 0,
    };
    const [bag, statBag] = await createTestBag(message, enclave);
    if (statBag !== Status.Success) {
      expect(statBag).toBe(Status.Success);
      return;
    }

    // Add bag to host storage
    const keys = await generateTestKeys(enclave);
    const [seq, setStatus] = await lpcHost.storage.setBag(
      keys.publicKey,
      bag,
    );
    if (setStatus !== Status.Success) {
      expect(setStatus).toBe(Status.Success);
      return;
    }

    const download: IDownloadMessage = {
      kdm: bag.kdm,
      head: message,
      host: "test",
      seq,
    };
    await store.downloads.enq([download]);

    const apply = async (parts: { head: unknown }[]) =>
      parts.map(() => Status.Success);
    await syncPull({
      conn,
      store,
      enclave,
      host,
      crypto: libsodiumCrypto,
      clock,
    }, apply);

    const messages = Array.from(await store.messages.list());
    expect(messages.length).toBe(1);
    expect(messages[0].body).toBeUndefined();
  });

  test("drains download queue under a tight maxPullBytes budget", async () => {
    const keys = await generateTestKeys(enclave);
    const downloads: IDownloadMessage[] = [];

    for (let i = 0; i < 3; i++) {
      const body = new Uint8Array([10 + i, 20, 30, 40]);
      const message: IMessage = {
        eid: new Uint8Array(16).fill(i + 1),
        off: 0,
        ctr: 0,
        len: body.length,
        bod: body,
        hsh: await libsodiumCrypto.blake3(body),
      };
      const [bag, statBag] = await createTestBag(message, enclave);
      expect(statBag).toBe(Status.Success);
      if (statBag !== Status.Success) return;
      const [seq, setStatus] = await lpcHost.storage.setBag(
        keys.publicKey,
        bag,
      );
      expect(setStatus).toBe(Status.Success);
      downloads.push({
        kdm: bag.kdm,
        head: message,
        host: "test",
        seq,
      });
    }
    await store.downloads.enq(downloads);

    // Multi-batch packing is unit-tested in sync-batch.test.ts.
    const apply = async (parts: { head: unknown }[]) =>
      parts.map(() => Status.Success);
    const stat = await syncPull({
      conn,
      store,
      enclave,
      host,
      crypto: libsodiumCrypto,
      clock,
      maxPullBytes: 4,
    }, apply);

    expect(stat).toBe(Status.Success);
    expect(await store.downloads.count()).toBe(0);
    expect(Array.from(await store.messages.list()).length).toBe(3);
  });
});
