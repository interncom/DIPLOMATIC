import { beforeEach, describe, expect, test, vi } from "vitest";
import { SyncClient } from "../src/client";
import { MemoryStore } from "../src/stores/memory/store";
import type {
  Hash,
  IHostConnectionInfo,
  IProtoHost,
  MasterSeed,
} from "../src/shared/types";
import { DiplomaticLPCServer, LPCTransport } from "../src/shared/lpc/server";
import memStorage from "../src/shared/storage/memory";
import libsodiumCrypto from "../src/crypto";
import { CallbackNotifier } from "../src/shared/lpc/pusher";
import { MockClock } from "../src/shared/clock";
import { EncodedMessage, IMessage } from "../src/shared/message";
import { btoh, uint8ArraysEqual } from "../src/shared/binary";
import { hostKeys } from "../src/shared/endpoint";
import { IDownloadMessage, IStateManager } from "../src/types";
import { sealBag } from "../src/shared/bag";
import { fail } from "assert";
import { Status } from "../src/shared/consts";

const lpcHost = new DiplomaticLPCServer(
  memStorage as any,
  libsodiumCrypto as any,
  new CallbackNotifier() as any,
  new MockClock(new Date(0)),
);

const transport = new LPCTransport(lpcHost);

const mockClock = { now: () => new Date() };
const testHost: IHostConnectionInfo<IProtoHost> = {
  handle: lpcHost,
  label: "test",
  idx: 1,
};

const createClient = async (clock = mockClock) => {
  const store = new MemoryStore<IProtoHost>();
  const state: IStateManager = {
    async apply(msg) {
      return Status.Success;
    },
    on(type, listener) { },
    off(type, listener) { },
  };
  const client = new SyncClient<IProtoHost>(clock, state, store, transport);
  return { store, state, client };
};

describe("NeoClient", () => {
  test("instantiates NeoClient", async () => {
    const { client } = await createClient();
    expect(client).toBeInstanceOf(SyncClient);
  });

  describe("link", () => {
    test("adds host to store", async () => {
      const { store, client } = await createClient();
      await client.link(testHost);
      const hosts = Array.from(await store.hosts.list());
      expect(hosts).toHaveLength(1);
      expect(hosts[0].label).toBe(testHost.label);
      expect(hosts[0].handle).toEqual(testHost.handle);
      expect(hosts[0].idx).toBe(testHost.idx);
    });
  });

  describe("unlink", () => {
    test("removes host from store", async () => {
      const { store, client } = await createClient();
      await client.link(testHost);
      await client.unlink("test");
      const hosts = Array.from(await store.hosts.list());
      expect(hosts).toHaveLength(0);
    });
  });

  describe("getXferState", () => {
    test("with zero counts", async () => {
      const { client } = await createClient();
      const xferState = await client.xferState.get();
      expect(xferState).toEqual({ numDownloads: 0, numUploads: 0 });
    });

    test("with non-zero counts", async () => {
      const { store, client } = await createClient();
      // Simulate some uploads and downloads
      const hash1 = new Uint8Array(32).fill(1) as any; // Approximate Hash
      const hash2 = new Uint8Array(32).fill(2) as any;
      const dl: IDownloadMessage = {
        kdm: new Uint8Array(8).fill(3),
        hash: new Uint8Array(32).fill(3) as Hash,
        head: {
          eid: new Uint8Array(16).fill(3),
          clk: new Date(),
          ctr: 0,
          len: 0,
        },
        host: "label",
      };
      await store.uploads.enq([hash1, hash2]);
      await store.downloads.enq([dl]);
      const xferState = await client.xferState.get();
      expect(xferState).toEqual({ numDownloads: 1, numUploads: 2 });
    });
  });

  describe("disconnect", () => {
    test("clears connections", async () => {
      const { client } = await createClient();
      // Simulate having connections
      client.connections.set("test", {} as any);
      expect(client.connections.size).toBe(1);
      await client.disconnect();
      expect(client.connections.size).toBe(0);
    });
  });

  describe("insert", () => {
    test("stores an insert message", async () => {
      const { store, client } = await createClient({
        now: () => new Date(1234567890000),
      });
      const body: EncodedMessage = new Uint8Array([1, 2, 3]);
      await client.insertRaw(body);
      const uploads = await store.uploads.count();
      expect(uploads).toBe(1);
      const messages = Array.from(await store.messages.list());
      expect(messages.length).toBe(1);
      const msg = messages[0];
      if (!msg.body) {
        fail("No body");
      }
      expect(uint8ArraysEqual(body, msg.body)).toBeTruthy();
      expect(msg.head.ctr).toBe(0);
      expect(msg.head.len).toBe(body.length);
    });
  });

  describe("upsert", () => {
    test("stores upsert message and increments counter", async () => {
      const { store, client } = await createClient({
        now: () => new Date(1234567890000),
      });
      const eid = new Uint8Array(32).fill(0);
      const body1: EncodedMessage = new Uint8Array([4, 5, 6]);
      const body2: EncodedMessage = new Uint8Array([7, 8, 9]);
      await client.upsertRaw(eid, body1);
      let messages = Array.from(await store.messages.list());
      expect(messages.length).toBe(1);
      expect(messages[0].head.ctr).toBe(0);
      expect(messages[0].body).toEqual(body1);
      expect(messages[0].head.len).toBe(body1.length);
      await client.upsertRaw(eid, body2);
      messages = Array.from(await store.messages.list());
      expect(messages.length).toBe(2);
      expect(messages[1].head.ctr).toBe(1);
      expect(messages[1].body).toEqual(body2);
      expect(messages[1].head.len).toBe(body2.length);
      const uploads = await store.uploads.count();
      expect(uploads).toBe(2);
    });
  });

  describe("delete", () => {
    test("stores delete message and increments counter", async () => {
      const { store, client } = await createClient({
        now: () => new Date(1234567890000),
      });
      const eid = new Uint8Array(32).fill(1);
      await client.upsertRaw(eid, new Uint8Array([10, 11]));
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

  describe("sync", () => {
    test("pushes message to host", async () => {
      const { store, client } = await createClient(lpcHost.clock);
      const masterSeed = await libsodiumCrypto
        .gen256BitSecureRandomSeed() as any;
      await store.seed.save(masterSeed);
      await client.link(testHost);
      await client.connect();

      const body: EncodedMessage = new Uint8Array([1, 2, 3]);
      await client.insertRaw(body);

      await client.sync();
      expect(await store.uploads.count()).toBe(0);
      const enclave = (await store.seed.load())!;
      const keys = await hostKeys(
        {
          enclave: enclave as any,
          crypto: libsodiumCrypto as any,
          clock: lpcHost.clock,
        },
        "test",
        1,
      );
      const pubKeyHex = btoh(keys.publicKey);
      const messagesOnHost = Array.from((lpcHost.storage as any).bag.values())
        .filter((item: any) => item.pubKeyHex === pubKeyHex);
      expect(messagesOnHost.length).toBe(1);
    });

    test("pulls message from host if one is present", async () => {
      const { store, client } = await createClient(lpcHost.clock);
      const masterSeed = await libsodiumCrypto
        .gen256BitSecureRandomSeed() as any;
      await store.seed.save(masterSeed);
      await client.link(testHost);
      await client.connect();

      const host = await store.hosts.get("test");
      if (!host) {
        fail("No host");
      }
      host.lastSyncedAt = new Date(0);

      // Manually add a message to the host storage
      const enclave = await store.seed.load();
      expect(enclave).not.toBeUndefined();
      if (!enclave) {
        return;
      }
      const keys = await hostKeys(
        { enclave: enclave, crypto: libsodiumCrypto, clock: lpcHost.clock },
        host.label,
        1,
      );
      const body: EncodedMessage = new Uint8Array([4, 5, 6]);
      const msg: IMessage = {
        eid: new Uint8Array(16).fill(0),
        clk: lpcHost.clock.now(),
        ctr: 0,
        len: body.length,
        bod: body,
      };
      const bag = await sealBag(msg, keys, libsodiumCrypto, enclave);
      const sha256 = await libsodiumCrypto.sha256Hash(bag.headCph) as Hash;
      lpcHost.storage.setBag(keys.publicKey, lpcHost.clock.now(), bag, sha256);

      expect(await store.downloads.count()).toBe(0);
      expect(Array.from(await store.messages.list()).length).toBe(0);

      // Sync: attempts to peek and pull the message from the host
      await client.sync();

      // Verify download was cleared and message was stored
      expect(await store.downloads.count()).toBe(0);
      expect(Array.from(await store.messages.list()).length).toBe(1);
    });

    test("syncs between two clients", async () => {
      // Generate shared seed for both clients (single-user system)
      const masterSeed = await libsodiumCrypto
        .gen256BitSecureRandomSeed() as MasterSeed;

      // Create clientA (pusher)
      const { store: storeA, client: clientA } = await createClient(
        lpcHost.clock,
      );
      await storeA.seed.save(masterSeed);
      await clientA.link(testHost);
      await clientA.connect(false); // no listen

      // Create clientB (puller)
      const { store: storeB, client: clientB } = await createClient(
        lpcHost.clock,
      );
      await storeB.seed.save(masterSeed);
      await clientB.link(testHost);
      await clientB.connect(false); // no listen

      // ClientA inserts a message and syncs (pushes to host)
      const testMessage: EncodedMessage = new Uint8Array([1, 2, 3, 4]);
      await clientA.insertRaw(testMessage);
      await clientA.sync();

      // ClientB syncs (pulls from host)
      await clientB.sync();

      // Verify the message was synced to clientB
      const messages = Array.from(await storeB.messages.list());
      expect(messages.length).toBe(1);
      expect(messages[0].body).toEqual(testMessage);
    });
  });
});

describe("push notifications", () => {
  test("end-to-end: push notification triggers sync", async () => {
    // Generate shared seed for both clients (single-user system)
    const masterSeed = await libsodiumCrypto.gen256BitSecureRandomSeed() as any;

    // Create clientA (pusher)
    const { store: storeA, client: clientA } = await createClient(
      lpcHost.clock,
    );
    await storeA.seed.save(masterSeed);
    await clientA.link(testHost);
    const hostA = await storeA.hosts.get("test");
    if (hostA) {
      hostA.lastSyncedAt = new Date(0);
    }

    // Create clientB (listener)
    const { store: storeB, client: clientB } = await createClient(
      lpcHost.clock,
    );
    await storeB.seed.save(masterSeed);
    await clientB.link(testHost);

    // Set clientB's host to old sync time so it will peek for new messages
    const hostB = await storeB.hosts.get("test");
    if (hostB) {
      hostB.lastSyncedAt = new Date(0);
    }

    // Client B connects first (starts listening for notifications)
    await clientB.connect();

    // Spy on clientB's sync method
    const syncSpy = vi.spyOn(clientB, "sync");

    // Client A connects, inserts a message, and syncs (pushes to host, triggers notification)
    await clientA.connect();
    const testMessage: EncodedMessage = new Uint8Array([1, 2, 3, 4]);
    await clientA.insertRaw(testMessage);
    await clientA.sync();

    // Wait for the push notification to trigger sync on clientB
    await vi.waitFor(() => syncSpy.mock.calls.length === 1, { timeout: 1000 });
  });
});
