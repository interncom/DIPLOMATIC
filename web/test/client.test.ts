import { describe, expect, test, vi } from "vitest";
import { SyncClient } from "../src/client";
import { MemoryStore } from "../src/stores/memory/store";
import type {
  Hash,
  IHostConnectionInfo,
  IProtoHost,
  MasterSeed,
  IMessage,
  IMessageHead,
} from "../src/shared/types";
import { DiplomaticLPCServer, LPCTransport } from "../src/shared/lpc/server";
import memStorage from "../src/shared/storage/memory";
import libsodiumCrypto from "../src/crypto";
import { CallbackNotifier } from "../src/shared/lpc/pusher";
import { MockClock } from "../src/shared/clock";
import { EncodedMessage } from "../src/shared/message";
import { bytesEqual } from "../src/shared/binary";
import { Encoder } from "../src/shared/codec";
import { messageHeadCodec } from "../src/shared/codecs/messageHead";
import { hostKeys } from "../src/shared/endpoint";
import { IDownloadMessage, IStateManager, IStoredMessageData } from "../src/types";
import { sealBag } from "../src/shared/bag";
import { Status } from "../src/shared/consts";
import { makeEID } from "../src/shared/codecs/eid";

const lpcHost = new DiplomaticLPCServer(
  memStorage,
  libsodiumCrypto,
  new CallbackNotifier(),
  new MockClock(new Date(0)),
);

const transport = () => new LPCTransport(lpcHost);

const mockClock = { now: () => new Date() };
const testHost: IHostConnectionInfo<IProtoHost> = {
  handle: lpcHost,
  label: "test",
  idx: 1,
};

const createClient = async (clock = mockClock) => {
  const store = new MemoryStore<IProtoHost>(libsodiumCrypto);
  const state: IStateManager = {
    async apply(msgs) {
      return msgs.map(() => Status.Success);
    },
    on(_type, _listener) { },
    off(_type, _listener) { },
  };
  const client = new SyncClient<IProtoHost>(
    clock,
    state,
    store,
    transport,
    libsodiumCrypto,
  );
  return { store, state, client };
};

describe("Client", () => {
  test("instantiates Client", async () => {
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
      const hash1 = new Uint8Array(32).fill(1) as Hash; // Approximate Hash
      const hash2 = new Uint8Array(32).fill(2) as Hash;
      const dl: IDownloadMessage = {
        kdm: new Uint8Array(8).fill(3),
        hash: new Uint8Array(32).fill(3) as Hash,
        head: {
          eid: new Uint8Array(16).fill(3),
          ctr: 0,
          len: 0,
          off: 0,
        },
        host: "label",
      };
      await store.uploads.enq("label", [hash1, hash2]);
      await store.downloads.enq([dl]);
      const xferState = await client.xferState.get();
      expect(xferState).toEqual({ numDownloads: 1, numUploads: 2 });
    });
  });

  describe("disconnect", () => {
    test("clears connections", async () => {
      const { client } = await createClient();
      // Simulate having connections
      // deno-lint-ignore no-explicit-any
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
      await client.link(testHost);
      const body: EncodedMessage = new Uint8Array([1, 2, 3]);
      const [_head, statHead] = await client.insertRaw(body);
      if (statHead !== Status.Success) {
        expect(statHead).toEqual(Status.Success);
        return;
      }
      const uploads = await store.uploads.count();
      expect(uploads).toBe(1);
      const messages = Array.from(await store.messages.list());
      expect(messages.length).toBe(1);
      const msg = messages[0];
      if (!msg.body) {
        fail("No body");
        return;
      }
      expect(bytesEqual(body, msg.body)).toBeTruthy();
      expect(msg.head.ctr).toBe(0);
      expect(msg.head.len).toBe(body.length);
    });
  });

  describe("upsert", () => {
    test("stores upsert message and increments counter", async () => {
      const { store, client } = await createClient({
        now: () => new Date(1234567890000),
      });
      await client.link(testHost);
      const eid = new Uint8Array(16).fill(0);
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

    describe("clock skew", () => {
      test("returns ClockOutOfSync when last message timestamp is ahead", async () => {
        const mockClock = new MockClock(new Date(0));
        const { store, client } = await createClient(mockClock);
        const eid = new Uint8Array(16).fill(3);
        const body: EncodedMessage = new Uint8Array([10, 11]);

        // Create a message with future timestamp manually
        const head: IMessageHead = {
          eid,
          clk: new Date(0),
          off: 1000, // timestamp = 0 + 1000 = 1000 > mockClock.now() = 0
          ctr: 0,
          len: 0,
          hsh: undefined,
        };

        // Encode head and compute hash
        const enc = new Encoder();
        enc.writeStruct(messageHeadCodec, head);
        const headEnc = enc.result();
        const hash = await libsodiumCrypto.blake3(headEnc);
        const data: IStoredMessageData = {
          eid: head.eid,
          ...(head.off !== 0 ? { off: head.off } : {}),
          ...(head.ctr !== 0 ? { ctr: head.ctr } : {}),
          body: undefined
        };
        await store.messages.add([{ key: hash, data }]);

        // Now upsert should return ClockOutOfSync
        const result = await client.upsertRaw(eid, body, false);
        expect(result[0]).toBeUndefined();
        expect(result[1]).toBe(Status.ClockOutOfSync);
      });

      test("allows upsert when force=true despite clock skew", async () => {
        const mockClock = new MockClock(new Date(0));
        const { store, client } = await createClient(mockClock);

        const id = await libsodiumCrypto.genRandomBytes(8);
        const eidObj = { id, ts: new Date(0) };
        const [eid, statEid] = makeEID(eidObj);
        if (statEid !== Status.Success) {
          expect(statEid).toEqual(Status.Success);
          return;
        }

        const body: EncodedMessage = new Uint8Array([20, 21]);

        // Create a message with future timestamp manually
        const head: IMessageHead = {
          eid,
          off: 1000, // timestamp = 0 + 1000 = 1000 > mockClock.now() = 0
          ctr: 5,
          len: 0,
          hsh: undefined,
        };

        // Encode head and compute hash
        const enc = new Encoder();
        enc.writeStruct(messageHeadCodec, head);
        const headEnc = enc.result();
        const hash = await libsodiumCrypto.blake3(headEnc);
        const data: IStoredMessageData = {
          eid: head.eid,
          ...(head.off !== 0 ? { off: head.off } : {}),
          ...(head.ctr !== 0 ? { ctr: head.ctr } : {}),
          body: undefined
        };
        await store.messages.add([{ key: hash, data }]);

        // Now upsert with force=true should succeed
        const [newMsg, stat] = await client.upsertRaw(
          head.eid,
          body,
          true,
        );
        if (stat !== Status.Success) {
          expect(stat).toBe(Status.Success);
          return;
        }
        expect(newMsg).toBeDefined();
        expect(newMsg.eid).toEqual(eid);
        expect(newMsg.ctr).toBe(0); // reset ctr
        expect(newMsg.off).not.toBe(head.off);
        expect(newMsg.off).toBe(0);
      });
    });
  });

  describe("delete", () => {
    test("stores delete message and increments counter", async () => {
      const { store, client } = await createClient({
        now: () => new Date(1234567890000),
      });
      await client.link(testHost);

      const id = await libsodiumCrypto.genRandomBytes(8);
      const eidObj = { id, ts: new Date(0) };
      const [eid, statEid] = makeEID(eidObj);
      if (statEid !== Status.Success) {
        expect(statEid).toEqual(Status.Success);
        return;
      }

      await client.upsertRaw(
        eid,
        new Uint8Array([10, 11]),
      );
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

    test("succeeds with clock skew by deleting the skewed entity", async () => {
      const mockClock = new MockClock(new Date(0));
      const { store, client } = await createClient(mockClock);

      const id = await libsodiumCrypto.genRandomBytes(8);
      const eidObj = { id, ts: new Date(0) };
      const [eid, statEid] = makeEID(eidObj);
      if (statEid !== Status.Success) {
        expect(statEid).toEqual(Status.Success);
        return;
      }

      // Create a message with future timestamp manually
      const head: IMessageHead = {
        eid,
        off: 1000, // timestamp = 0 + 1000 = 1000 > mockClock.now() = 0
        ctr: 0,
        len: 2,
        hsh: undefined,
      };

      // Encode head and compute hash
      const enc = new Encoder();
      enc.writeStruct(messageHeadCodec, head);
      const headEnc = enc.result();
      const hash = await libsodiumCrypto.blake3(headEnc);
      const data: IStoredMessageData = {
        eid: head.eid,
        ...(head.off !== 0 ? { off: head.off } : {}),
        ...(head.ctr !== 0 ? { ctr: head.ctr } : {}),
        body: new Uint8Array([30, 31]),
      };
      await store.messages.add([{ key: hash, data }]);

      // Now delete should succeed despite clock skew
      const [respHead, statDel] = await client.delete(eid);
      if (statDel !== Status.Success) {
        expect(statDel).toBe(Status.Success);
        return;
      }
      expect(respHead).toBeDefined();
      expect(respHead.eid).toEqual(eid);
      expect(respHead.len).toBe(0); // delete message
      expect(respHead.ctr).toBe(1); // incremented from 0

      // Check that two messages are now stored: original upsert and the delete
      const messages = Array.from(await store.messages.list());
      expect(messages.length).toBe(2);
      const deleteMsg = messages[1];
      expect(deleteMsg.head.len).toBe(0);
      expect(deleteMsg.head.ctr).toBe(1);
    });
  });

  describe("sync", () => {
    test("pushes message to host", async () => {
      const { store, client } = await createClient(lpcHost.clock);
      const masterSeed = await libsodiumCrypto
        .gen256BitSecureRandomSeed() as MasterSeed;
      await store.seed.save(masterSeed);
      await client.link(testHost);
      await client.connect();

      const body: EncodedMessage = new Uint8Array([1, 2, 3]);
      await client.insertRaw(body);

      expect(await client.sync()).toBe(Status.Success);
      expect(await store.uploads.count()).toBe(0);
      const enclave = (await store.seed.load())!;
      const keys = await hostKeys(
        {
          enclave: enclave,
          crypto: libsodiumCrypto,
          clock: lpcHost.clock,
        },
        "test",
        1,
      );
      const [list, statList] = await lpcHost.storage.listHeads(keys.publicKey, 0);
      if (statList !== Status.Success) {
        expect(statList).toEqual(Status.Success);
        return;
      }
      expect(list.length).toBe(1);
    });

    test("pulls message from host if one is present", async () => {
      const { store, client } = await createClient(lpcHost.clock);
      const masterSeed = await libsodiumCrypto
        .gen256BitSecureRandomSeed() as MasterSeed;
      await store.seed.save(masterSeed);
      await client.link(testHost);
      await client.connect();

      const host = await store.hosts.get("test");
      if (!host) {
        fail("No host");
        return;
      }
      host.lastSeq = 0;

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
        off: 0,
        ctr: 0,
        len: body.length,
        bod: body,
      };
      const bag = await sealBag(msg, keys, libsodiumCrypto, enclave);
      const [_, setStatus] = await lpcHost.storage.setBag(
        keys.publicKey,
        bag,
      );
      expect(setStatus).toBe(Status.Success);

      expect(await store.downloads.count()).toBe(0);
      expect(Array.from(await store.messages.list()).length).toBe(0);

      // Sync: attempts to peek and pull the message from the host
      expect(await client.sync()).toBe(Status.Success);

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
      expect(await clientA.sync()).toBe(Status.Success);

      // ClientB syncs (pulls from host)
      expect(await clientB.sync()).toBe(Status.Success);

      // Verify the message was synced to clientB
      const messages = Array.from(await storeB.messages.list());
      expect(messages.length).toBe(1);
      expect(messages[0].body).toEqual(testMessage);
    });

    test("returns MissingSeed when no seed is set", async () => {
      const { client } = await createClient();
      // Don't set seed
      const result = await client.sync();
      expect(result).toBe(Status.MissingSeed);
    });
  });
});

describe("push notifications", () => {
  test("end-to-end: push notification triggers sync", async () => {
    // Generate shared seed for both clients (single-user system)
    const masterSeed = await libsodiumCrypto.gen256BitSecureRandomSeed() as MasterSeed;

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
    expect(await clientA.sync()).toBe(Status.Success);

    // Wait for the push notification to trigger sync on clientB
    await vi.waitFor(async () => {
      if (syncSpy.mock.calls.length === 1) {
        const result = await syncSpy.mock.results[0].value;
        expect(result).toBe(Status.Success);
        return true;
      }
      return false;
    }, { timeout: 1000 });
  });
});
