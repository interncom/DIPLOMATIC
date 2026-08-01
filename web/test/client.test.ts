import { describe, expect, test, vi } from "vitest";
import { encode } from "@msgpack/msgpack";
import { SyncClient } from "../src/client";
import { MemoryStore } from "../src/stores/memory/store";
import type {
  Hash,
  IHostConnectionInfo,
  IProtoHost,
  MasterSeed,
  IMessage,
  IMessageHead,
  IStateManager,
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

import {
  APLD_APPLIED,
  IDownloadMessage,
  IStoredMessageData,
} from "../src/types";
import { sealBag } from "../src/shared/bag";
import { Status } from "../src/shared/consts";
import { makeEID } from "../src/shared/codecs/eid";
import { entStateManager, revFromHead } from "../src/entdb/entdb";
import { EntDBMemory } from "../src/entdb/memory";

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
    async clear() {
      return Status.Success;
    },
    notify() {},
    async refresh() {},
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

  describe("hosts", () => {
    test("returns empty when none linked", async () => {
      const { client } = await createClient();
      expect(await client.hosts()).toEqual([]);
    });

    test("returns linked hosts", async () => {
      const { client } = await createClient();
      await client.link(testHost, false);
      const hosts = await client.hosts();
      expect(hosts).toHaveLength(1);
      expect(hosts[0].label).toBe(testHost.label);
      expect(hosts[0].handle).toEqual(testHost.handle);
    });
  });

  describe("getXferState", () => {
    test("with zero counts", async () => {
      const { client } = await createClient();
      const xferState = await client.xferState.get();
      expect(xferState).toEqual({
        numDownloads: 0,
        numUploads: 0,
        progress: { phase: "idle" },
      });
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
      expect(xferState).toEqual({
        numDownloads: 1,
        numUploads: 2,
        progress: { phase: "idle" },
      });
    });

    test("includes idle progress in snapshot by default", async () => {
      const { client } = await createClient();
      const xferState = await client.xferState.get();
      expect(xferState.progress).toEqual({ phase: "idle" });
    });
  });

  describe("disconnect", () => {
    test("closes listeners and clears connections", async () => {
      const { client } = await createClient();
      const seed = new Uint8Array(32).fill(1) as MasterSeed;
      await client.setSeed(seed);
      // Avoid auto-sync side effects; still open the push listener.
      await client.link(testHost, false);
      await client.connect(true, false);
      expect(client.connections.size).toBe(1);
      const conn = client.connections.get("test");
      expect(conn).toBeDefined();
      if (!conn) {
        return;
      }
      const closeSpy = vi.spyOn(conn, "closeListener");
      await client.disconnect();
      expect(closeSpy).toHaveBeenCalledOnce();
      expect(client.connections.size).toBe(0);
    });
  });

  describe("wipe", () => {
    test("clears protocol store and calls state.clear", async () => {
      const store = new MemoryStore<IProtoHost>(libsodiumCrypto);
      let cleared = false;
      const state: IStateManager = {
        async apply(msgs) {
          return msgs.map(() => Status.Success);
        },
        async clear() {
          cleared = true;
          return Status.Success;
        },
        notify() {},
        async refresh() {},
        on(_type, _listener) { },
        off(_type, _listener) { },
      };
      const client = new SyncClient(
        mockClock,
        state,
        store,
        transport,
        libsodiumCrypto,
      );

      const seed = new Uint8Array(32).fill(9) as MasterSeed;
      await client.setSeed(seed);
      await client.link(testHost, false);
      const body: EncodedMessage = new Uint8Array([1, 2, 3]);
      await client.insertRaw(body);

      const hash = new Uint8Array(32).fill(1) as Hash;
      await store.uploads.enq("test", [hash]);
      const dl: IDownloadMessage = {
        kdm: new Uint8Array(8).fill(3),
        seq: 1,
        head: {
          eid: new Uint8Array(16).fill(3),
          ctr: 0,
          len: 0,
          off: 0,
        },
        host: "test",
      };
      await store.downloads.enq([dl]);

      expect(await store.seed.load()).toBeDefined();
      expect(Array.from(await store.hosts.list()).length).toBe(1);
      expect(Array.from(await store.messages.list()).length).toBe(1);
      expect(await store.uploads.count()).toBeGreaterThan(0);
      expect(await store.downloads.count()).toBe(1);

      await client.wipe();

      expect(cleared).toBe(true);
      expect(client.connections.size).toBe(0);
      expect(await store.seed.load()).toBeUndefined();
      expect(Array.from(await store.hosts.list()).length).toBe(0);
      expect(Array.from(await store.messages.list()).length).toBe(0);
      expect(await store.uploads.count()).toBe(0);
      expect(await store.downloads.count()).toBe(0);
    });

    test("clears EntDB and notifies type subscribers", async () => {
      const entDB = new EntDBMemory();
      const stateMgr = entStateManager(entDB);
      const store = new MemoryStore<IProtoHost>(libsodiumCrypto);
      const client = new SyncClient(
        mockClock,
        stateMgr,
        store,
        transport,
        libsodiumCrypto,
      );

      const seed = new Uint8Array(32).fill(7) as MasterSeed;
      await client.setSeed(seed);
      await client.link(testHost, false);

      const entBod: EncodedMessage = encode({
        type: "todo",
        body: { text: "hi" },
      });
      await client.insertRaw(entBod);

      const [before, beforeStat] = await entDB.getEntities({ type: "todo" });
      expect(beforeStat).toBe(Status.Success);
      expect(before?.length).toBe(1);

      let notified = 0;
      stateMgr.on("todo", () => {
        notified += 1;
      });

      await client.wipe();

      const [after, afterStat] = await entDB.getEntities({ type: "todo" });
      expect(afterStat).toBe(Status.Success);
      expect(after?.length).toBe(0);
      expect(notified).toBe(1);
      expect(Array.from(await store.messages.list()).length).toBe(0);
    });

    test("cancels pending scheduled sync", async () => {
      vi.useFakeTimers();
      try {
        const { store, client } = await createClient();
        const seed = new Uint8Array(32).fill(5) as MasterSeed;
        await client.setSeed(seed);
        await client.link(testHost, false);
        // scheduleSync is private; trigger via insert (debounces sync).
        const body: EncodedMessage = new Uint8Array([1]);
        await client.insertRaw(body);
        await client.wipe();
        const syncSpy = vi.spyOn(client, "sync");
        await vi.advanceTimersByTimeAsync(1000);
        expect(syncSpy).not.toHaveBeenCalled();
        syncSpy.mockRestore();
        expect(await store.seed.load()).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
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

  describe("update", () => {
    test("stores update message and increments counter", async () => {
      const { store, client } = await createClient({
        now: () => new Date(1234567890000),
      });
      await client.link(testHost);
      const body1: EncodedMessage = new Uint8Array([4, 5, 6]);
      const body2: EncodedMessage = new Uint8Array([7, 8, 9]);
      const [h1, st1] = await client.insertRaw(body1);
      expect(st1).toBe(Status.Success);
      if (!h1) throw new Error("missing h1");
      let messages = Array.from(await store.messages.list());
      expect(messages.length).toBe(1);
      expect(messages[0].head.ctr).toBe(0);
      expect(messages[0].body).toEqual(body1);
      expect(messages[0].head.len).toBe(body1.length);
      const [prior, stP] = revFromHead(h1);
      expect(stP).toBe(Status.Success);
      if (!prior) throw new Error("missing prior");
      await client.updateRaw(prior, body2);
      messages = Array.from(await store.messages.list());
      expect(messages.length).toBe(2);
      expect(messages[1].head.ctr).toBe(1);
      expect(messages[1].body).toEqual(body2);
      expect(messages[1].head.len).toBe(body2.length);
      const uploads = await store.uploads.count();
      expect(uploads).toBe(2);
    });

    describe("clock skew", () => {
      test("returns ClockOutOfSync when prior updatedAt is ahead", async () => {
        const mockClock = new MockClock(new Date(0));
        const { client } = await createClient(mockClock);
        const id = await libsodiumCrypto.genRandomBytes(8);
        const [eid, statEid] = makeEID({ id, ts: new Date(0) });
        if (statEid !== Status.Success || !eid) {
          expect(statEid).toEqual(Status.Success);
          return;
        }
        const body: EncodedMessage = new Uint8Array([10, 11]);
        const prior = {
          eid,
          ctr: 0,
          updatedAt: new Date(1000), // ahead of clock (0)
        };
        const result = await client.updateRaw(prior, body, false);
        expect(result[0]).toBeUndefined();
        expect(result[1]).toBe(Status.ClockOutOfSync);
      });

      test("allows update when force=true despite clock skew", async () => {
        const mockClock = new MockClock(new Date(0));
        const { store, client } = await createClient(mockClock);

        const id = await libsodiumCrypto.genRandomBytes(8);
        const eidObj = { id, ts: new Date(0) };
        const [eid, statEid] = makeEID(eidObj);
        if (statEid !== Status.Success || !eid) {
          expect(statEid).toEqual(Status.Success);
          return;
        }

        const body: EncodedMessage = new Uint8Array([20, 21]);

        // Seed skewed latest msg in archive (optional; prior alone drives skew).
        const head: IMessageHead = {
          eid,
          off: 1000,
          ctr: 5,
          len: 0,
          hsh: undefined,
        };
        const enc = new Encoder();
        enc.writeStruct(messageHeadCodec, head);
        const headEnc = enc.result();
        const hash = await libsodiumCrypto.blake3(headEnc);
        const data: IStoredMessageData = {
          eid: head.eid,
          ...(head.off !== 0 ? { off: head.off } : {}),
          ...(head.ctr !== 0 ? { ctr: head.ctr } : {}),
          body: undefined,
          apld: APLD_APPLIED,
        };
        await store.messages.add([{ key: hash, data }]);

        const prior = {
          eid,
          ctr: 5,
          updatedAt: new Date(1000),
        };
        const [newMsg, stat] = await client.updateRaw(prior, body, true);
        if (stat !== Status.Success) {
          expect(stat).toBe(Status.Success);
          return;
        }
        expect(newMsg).toBeDefined();
        // Replacement keeps id bytes; new eid ts = now (0) so off = 0, ctr = 0.
        expect(newMsg.ctr).toBe(0);
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

      const [h1, st1] = await client.insertRaw(new Uint8Array([10, 11]));
      expect(st1).toBe(Status.Success);
      if (!h1) throw new Error("missing h1");
      const [prior, stP] = revFromHead(h1);
      expect(stP).toBe(Status.Success);
      if (!prior) throw new Error("missing prior");
      await client.delete({ prior });
      const messages = Array.from(await store.messages.list());
      expect(messages.length).toBe(2);
      const insertMsg = messages[0];
      expect(insertMsg.head.ctr).toBe(0);
      expect(insertMsg.head.len).toBe(2);
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
      if (statEid !== Status.Success || !eid) {
        expect(statEid).toEqual(Status.Success);
        return;
      }

      const head: IMessageHead = {
        eid,
        off: 1000,
        ctr: 0,
        len: 2,
        hsh: undefined,
      };
      const enc = new Encoder();
      enc.writeStruct(messageHeadCodec, head);
      const headEnc = enc.result();
      const hash = await libsodiumCrypto.blake3(headEnc);
      const data: IStoredMessageData = {
        eid: head.eid,
        ...(head.off !== 0 ? { off: head.off } : {}),
        ...(head.ctr !== 0 ? { ctr: head.ctr } : {}),
        body: new Uint8Array([30, 31]),
        apld: APLD_APPLIED,
      };
      await store.messages.add([{ key: hash, data }]);

      const prior = {
        eid,
        ctr: 0,
        updatedAt: new Date(1000),
      };
      const [respHead, statDel] = await client.delete({ prior, force: true });
      if (statDel !== Status.Success) {
        expect(statDel).toBe(Status.Success);
        return;
      }
      expect(respHead).toBeDefined();
      expect(respHead.eid).toEqual(eid);
      expect(respHead.len).toBe(0);
      expect(respHead.ctr).toBe(1);

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
      const hostIdnt = await enclave.deriveIdentity("test", 1);
      const [list, statList] = await lpcHost.storage.listHeads(
        hostIdnt.publicKey,
        0,
      );
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
      const hostIdnt = await enclave.deriveIdentity(host.label, 1);
      const body: EncodedMessage = new Uint8Array([4, 5, 6]);
      const msg: IMessage = {
        eid: new Uint8Array(16).fill(0),
        clk: lpcHost.clock.now(),
        off: 0,
        ctr: 0,
        len: body.length,
        bod: body,
      };
      const [bag, statBag] = await sealBag(
        msg,
        hostIdnt,
        libsodiumCrypto,
        enclave,
      );
      if (statBag !== Status.Success) {
        expect(statBag).toBe(Status.Success);
        return;
      }

      const [, setStatus] = await lpcHost.storage.setBags(hostIdnt.publicKey, [
        bag,
      ]);
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
