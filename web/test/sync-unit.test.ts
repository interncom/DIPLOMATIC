import { beforeEach, describe, expect, test } from "vitest";
import { reconcileHost, syncPeek, syncPull, syncPush } from "../src/sync";
import { MemoryStore } from "../src/stores/memory/store";
import DiplomaticClientAPI from "../src/shared/client";
import libsodiumCrypto from "../src/crypto";
import { Enclave } from "../src/shared/crypto/enclave";
import { MockClock } from "../src/shared/clock";
import { DiplomaticLPCServer, LPCTransport } from "../src/shared/lpc/server";
import { CallbackNotifier } from "../src/shared/lpc/pusher";
import memStorage, {
  createMemoryStorage,
} from "../src/shared/storage/memory";
import { sealBag } from "../src/shared/bag";
import { Encoder } from "../src/shared/codec";
import { makeEID } from "../src/shared/codecs/eid";
import { messageHeadCodec } from "../src/shared/codecs/messageHead";
import { checksumSet } from "../src/shared/checksum";
import {
  EntityID,
  Hash,
  HostHandle,
  IMessage,
  MasterSeed,
} from "../src/shared/types";
import { Status } from "../src/shared/consts";
import {
  APLD_APPLIED,
  IDownloadMessage,
  IStoredMessageData,
} from "../src/types";
import { bytesEqual } from "../src/shared/binary";

// Fixed seed for deterministic key derivation
const testSeed = new Uint8Array(32).fill(0x42) as MasterSeed;

async function createTestBag(message: IMessage, enclave: Enclave) {
  const hostIdnt = await enclave.deriveIdentity("test", 1);
  return sealBag(message, hostIdnt, libsodiumCrypto, enclave);
}

/** Valid EID (id+ts structure) so messageHeadCodec.decode succeeds on peek. */
function testEid(n: number): EntityID {
  const [eid, st] = makeEID({
    id: new Uint8Array(8).fill(n),
    ts: new Date(n * 1000),
  });
  if (st !== Status.Success || !eid) {
    throw new Error(`testEid(${n}): ${Status[st]}`);
  }
  return eid;
}

function testMsg(n: number, body: number[]): IMessage {
  const bod = new Uint8Array(body);
  return {
    eid: testEid(n),
    off: 0,
    ctr: 0,
    len: bod.length,
    bod,
  };
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
    const hostIdnt = await conn.identity();
    const [_, addStatus] = await lpcHost.storage.addUser(hostIdnt.publicKey);
    expect(addStatus).toBe(Status.Success);
  });

  test("handles empty peek results", async () => {
    await syncPeek({ conn, store, enclave, host, crypto: libsodiumCrypto });

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

    // Seal bag using same host identity that conn will use, and put on host.
    const hostIdnt = await enclave.deriveIdentity("test", 1);
    const [bag, statBag] = await sealBag(
      message,
      hostIdnt,
      libsodiumCrypto,
      enclave,
    );
    if (statBag !== Status.Success || !bag) {
      expect(statBag).toBe(Status.Success);
      return;
    }
    const [seqs, setStatus] = await lpcHost.storage.setBags(hostIdnt.publicKey, [
      bag,
    ]);
    if (setStatus !== Status.Success || !seqs?.[0]) {
      expect(setStatus).toBe(Status.Success);
      return;
    }
    const seq = seqs[0];

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
      apld: APLD_APPLIED,
    };
    await store.messages.add([{ key: headEncHash, data: storedData }]);

    // Enqueue for upload to this host.
    await store.uploads.enq("test", [headEncHash]);
    expect(await store.uploads.list("test")).toContainEqual(headEncHash);

    // Peek should notice we already have it locally, skip download, and dequeue the upload.
    const stat = await syncPeek({
      conn,
      store,
      enclave,
      host,
      crypto: libsodiumCrypto,
    });
    expect(stat).toBe(Status.Success);

    // Upload was dequeued because host already has it.
    const remainingUploads = await store.uploads.list("test");
    expect(remainingUploads.length).toBe(0);

    // No download was enqueued.
    const downloads = Array.from(await store.downloads.list());
    expect(downloads.length).toBe(0);
  });

  test("increments numBags on incremental peek", async () => {
    // Isolated host so leftover bags from other tests do not inflate counts.
    const storage = createMemoryStorage();
    const isolatedHost = new DiplomaticLPCServer(
      storage,
      libsodiumCrypto,
      new CallbackNotifier(),
      new MockClock(new Date(0)),
    );
    const transport = new LPCTransport(isolatedHost);
    const isolatedConn = new DiplomaticClientAPI(
      enclave,
      libsodiumCrypto,
      host,
      clock,
      transport,
      () => Promise.resolve(Status.Success),
    );
    const hostIdnt = await isolatedConn.identity();
    await isolatedHost.storage.addUser(hostIdnt.publicKey);
    await store.hosts.add({ label: "test", handle: isolatedHost, idx: 1 });

    const message: IMessage = {
      eid: new Uint8Array(16).fill(2),
      off: 0,
      ctr: 0,
      len: 2,
      bod: new Uint8Array([9, 9]),
    };
    const [bag, statBag] = await createTestBag(message, enclave);
    expect(statBag).toBe(Status.Success);
    if (!bag) return;
    await isolatedHost.storage.setBags(hostIdnt.publicKey, [bag]);

    const stat = await syncPeek({
      conn: isolatedConn,
      store,
      enclave,
      host: { ...host, lastSeq: 0, numBags: 0, numDupes: 0 },
      crypto: libsodiumCrypto,
    });
    expect(stat).toBe(Status.Success);
    const row = await store.hosts.get("test");
    expect(row?.numBags).toBe(1);
    expect(row?.numDupes).toBe(0);
    expect(row?.lastSeq).toBeGreaterThan(0);
  });
});

/**
 * Host bag/dupe counters on incremental peek (isolated host storage).
 */
describe("syncPeek host bag/dupe stats", () => {
  let store: MemoryStore<HostHandle>;
  let enclave: Enclave;
  let clock: MockClock;
  let hostRow: {
    label: string;
    idx: number;
    lastSeq: number;
    numBags: number;
    numDupes: number;
  };
  let lpcHost: DiplomaticLPCServer;
  let conn: DiplomaticClientAPI<HostHandle>;
  let hostIdnt: Awaited<ReturnType<Enclave["deriveIdentity"]>>;

  async function msgHash(m: IMessage): Promise<Hash> {
    let hsh: Uint8Array | undefined;
    if (m.bod && m.len > 0) hsh = await libsodiumCrypto.blake3(m.bod);
    const enc = new Encoder();
    messageHeadCodec.encode(enc, { ...m, hsh });
    return await libsodiumCrypto.blake3(enc.result()) as Hash;
  }

  async function archive(m: IMessage, hash: Hash) {
    await store.messages.add([{
      key: hash,
      data: {
        eid: m.eid,
        body: m.bod,
        apld: APLD_APPLIED,
      },
    }]);
  }

  beforeEach(async () => {
    store = new MemoryStore(libsodiumCrypto);
    enclave = new Enclave(testSeed, libsodiumCrypto);
    clock = new MockClock(new Date(0));
    hostRow = {
      label: "test",
      idx: 1,
      lastSeq: 0,
      numBags: 0,
      numDupes: 0,
    };
    const storage = createMemoryStorage();
    lpcHost = new DiplomaticLPCServer(
      storage,
      libsodiumCrypto,
      new CallbackNotifier(),
      new MockClock(new Date(0)),
    );
    const transport = new LPCTransport(lpcHost);
    conn = new DiplomaticClientAPI(
      enclave,
      libsodiumCrypto,
      hostRow,
      clock,
      transport,
      () => Promise.resolve(Status.Success),
    );
    hostIdnt = await conn.identity();
    await lpcHost.storage.addUser(hostIdnt.publicKey);
    await store.hosts.add({ label: "test", handle: lpcHost, idx: 1 });
  });

  async function peekFrom(lastSeq: number) {
    const row = await store.hosts.get("test");
    return syncPeek({
      conn,
      store,
      enclave,
      host: {
        ...hostRow,
        lastSeq: row?.lastSeq ?? lastSeq,
        numBags: row?.numBags ?? 0,
        numDupes: row?.numDupes ?? 0,
        handle: lpcHost,
      },
      crypto: libsodiumCrypto,
    });
  }

  test("empty peek leaves numBags/numDupes/lastSeq unchanged", async () => {
    await store.hosts.recordStats("test", {
      lastSeq: 3,
      numBags: 3,
      numDupes: 1,
    });
    const st = await peekFrom(3);
    expect(st).toBe(Status.Success);
    const row = await store.hosts.get("test");
    expect(row?.lastSeq).toBe(3);
    expect(row?.numBags).toBe(3);
    expect(row?.numDupes).toBe(1);
  });

  test("two bags for same msg in one peek: numBags=2, numDupes=1", async () => {
    const m = testMsg(20, [1]);
    const [b1, s1] = await createTestBag(m, enclave);
    const [b2, s2] = await createTestBag(m, enclave);
    expect(s1).toBe(Status.Success);
    expect(s2).toBe(Status.Success);
    if (!b1 || !b2) return;
    await lpcHost.storage.setBags(hostIdnt.publicKey, [b1, b2]);

    expect(await peekFrom(0)).toBe(Status.Success);
    const row = await store.hosts.get("test");
    expect(row?.numBags).toBe(2);
    expect(row?.numDupes).toBe(1);
    expect(row?.lastSeq).toBe(2);
    // First bag is new → download enqueued once (not twice).
    expect(Array.from(await store.downloads.list())).toHaveLength(1);
  });

  test("local msg with pending upload is not counted as dupe", async () => {
    const m = testMsg(21, [2]);
    const hash = await msgHash(m);
    await archive(m, hash);
    await store.uploads.enq("test", [hash]);
    const [bag] = await createTestBag(m, enclave);
    if (!bag) return;
    await lpcHost.storage.setBags(hostIdnt.publicKey, [bag]);

    expect(await peekFrom(0)).toBe(Status.Success);
    const row = await store.hosts.get("test");
    expect(row?.numBags).toBe(1);
    expect(row?.numDupes).toBe(0); // first host bag for our push, not a dupe
    expect(await store.uploads.list("test")).toHaveLength(0);
  });

  test("local msg without upload queue counts as host dupe", async () => {
    const m = testMsg(22, [3]);
    const hash = await msgHash(m);
    await archive(m, hash);
    // No uploads.enq — e.g. already pushed / imported elsewhere.
    const [bag] = await createTestBag(m, enclave);
    if (!bag) return;
    await lpcHost.storage.setBags(hostIdnt.publicKey, [bag]);

    expect(await peekFrom(0)).toBe(Status.Success);
    const row = await store.hosts.get("test");
    expect(row?.numBags).toBe(1);
    expect(row?.numDupes).toBe(1);
  });

  test("sequential peeks accumulate numBags; second peek can add a dupe", async () => {
    const m = testMsg(23, [4]);
    const hash = await msgHash(m);
    const [b1] = await createTestBag(m, enclave);
    if (!b1) return;
    await lpcHost.storage.setBags(hostIdnt.publicKey, [b1]);

    expect(await peekFrom(0)).toBe(Status.Success);
    let row = await store.hosts.get("test");
    expect(row?.numBags).toBe(1);
    expect(row?.numDupes).toBe(0);
    const seq1 = row!.lastSeq;

    // Archive after first peek (as if we pulled+applied), then host gets a dupe bag.
    await archive(m, hash);
    const [b2] = await createTestBag(m, enclave);
    if (!b2) return;
    await lpcHost.storage.setBags(hostIdnt.publicKey, [b2]);

    expect(await peekFrom(seq1)).toBe(Status.Success);
    row = await store.hosts.get("test");
    expect(row?.numBags).toBe(2);
    expect(row?.numDupes).toBe(1);
    expect(row?.lastSeq).toBeGreaterThan(seq1);
  });

  test("mixed batch: new msg + two bags for known msg", async () => {
    const known = testMsg(24, [5]);
    const novel = testMsg(25, [6]);
    const knownHash = await msgHash(known);
    await archive(known, knownHash);

    const [k1] = await createTestBag(known, enclave);
    const [k2] = await createTestBag(known, enclave);
    const [n1] = await createTestBag(novel, enclave);
    if (!k1 || !k2 || !n1) return;
    await lpcHost.storage.setBags(hostIdnt.publicKey, [k1, k2, n1]);

    expect(await peekFrom(0)).toBe(Status.Success);
    const row = await store.hosts.get("test");
    // 3 bags; known contributes 2 dups (first of known without upload = dupe,
    // second of known = within-batch dupe).
    expect(row?.numBags).toBe(3);
    expect(row?.numDupes).toBe(2);
    expect(Array.from(await store.downloads.list())).toHaveLength(1); // novel only
  });

  test("concurrent peeks of the same new bags double-count numBags (no lock across peeks)", async () => {
    // Documents client contract: SyncClient coalesces sync so peeks do not
    // overlap; concurrent syncPeek callers can both see the same seqs and each
    // apply bagDelta. Prefer single-flight sync (or reconcile for absolute).
    const m = testMsg(26, [7]);
    const [bag] = await createTestBag(m, enclave);
    if (!bag) return;
    await lpcHost.storage.setBags(hostIdnt.publicKey, [bag]);

    const peekArgs = {
      conn,
      store,
      enclave,
      host: {
        ...hostRow,
        lastSeq: 0,
        numBags: 0,
        numDupes: 0,
        handle: lpcHost,
      },
      crypto: libsodiumCrypto,
    };
    const [st1, st2] = await Promise.all([
      syncPeek(peekArgs),
      syncPeek(peekArgs),
    ]);
    expect(st1).toBe(Status.Success);
    expect(st2).toBe(Status.Success);
    const row = await store.hosts.get("test");
    // Both peeks saw 1 bag before either advanced lastSeq (same lastSeq=0).
    expect(row?.numBags).toBe(2);
  });

  test("concurrent recordStats deltas compose under host-store serialization", async () => {
    await Promise.all([
      store.hosts.recordStats("test", { bagDelta: 1, dupeDelta: 1, lastSeq: 1 }),
      store.hosts.recordStats("test", { bagDelta: 2, dupeDelta: 0, lastSeq: 3 }),
      store.hosts.recordStats("test", { bagDelta: 1, dupeDelta: 1, lastSeq: 2 }),
    ]);
    const row = await store.hosts.get("test");
    expect(row?.numBags).toBe(4);
    expect(row?.numDupes).toBe(2);
    expect(row?.lastSeq).toBe(3); // max of advances
  });
});

describe("reconcileHost", () => {
  let store: MemoryStore<HostHandle>;
  let enclave: Enclave;
  let clock: MockClock;
  let host: {
    label: string;
    idx: number;
    lastSeq: number;
    numBags: number;
    numDupes: number;
    handle?: HostHandle;
  };
  let conn: DiplomaticClientAPI<HostHandle>;
  let lpcHost: DiplomaticLPCServer;

  beforeEach(async () => {
    store = new MemoryStore(libsodiumCrypto);
    enclave = new Enclave(testSeed, libsodiumCrypto);
    clock = new MockClock(new Date(0));
    host = {
      label: "test",
      idx: 1,
      lastSeq: 0,
      numBags: 0,
      numDupes: 0,
    };
    // Isolated host storage so bags do not leak across tests.
    const storage = createMemoryStorage();
    lpcHost = new DiplomaticLPCServer(
      storage,
      libsodiumCrypto,
      new CallbackNotifier(),
      new MockClock(new Date(0)),
    );
    const transport = new LPCTransport(lpcHost);
    conn = new DiplomaticClientAPI(
      enclave,
      libsodiumCrypto,
      host,
      clock,
      transport,
      () => Promise.resolve(Status.Success),
    );
    const hostIdnt = await conn.identity();
    await lpcHost.storage.addUser(hostIdnt.publicKey);
    await store.hosts.add({ label: "test", handle: lpcHost, idx: 1 });
  });

  test("sets numBags/numDupes and reports set differences", async () => {
    const hostIdnt = await enclave.deriveIdentity("test", 1);

    // Two bags, same head (duplicate on host).
    const message: IMessage = {
      eid: new Uint8Array(16).fill(3),
      off: 0,
      ctr: 0,
      len: 3,
      bod: new Uint8Array([1, 2, 3]),
    };
    const [bag1, s1] = await createTestBag(message, enclave);
    const [bag2, s2] = await createTestBag(message, enclave);
    expect(s1).toBe(Status.Success);
    expect(s2).toBe(Status.Success);
    if (!bag1 || !bag2) return;
    await lpcHost.storage.setBags(hostIdnt.publicKey, [bag1, bag2]);

    // Local-only msg (on client, not on host).
    const localOnly: IMessage = {
      eid: new Uint8Array(16).fill(4),
      off: 0,
      ctr: 0,
      len: 1,
      bod: new Uint8Array([7]),
    };
    let hsh: Uint8Array | undefined;
    if (localOnly.bod && localOnly.len > 0) {
      hsh = await libsodiumCrypto.blake3(localOnly.bod);
    }
    const enc = new Encoder();
    messageHeadCodec.encode(enc, { ...localOnly, hsh });
    const localHash = await libsodiumCrypto.blake3(enc.result()) as Hash;
    await store.messages.add([{
      key: localHash,
      data: {
        eid: localOnly.eid,
        body: localOnly.bod,
        apld: APLD_APPLIED,
      },
    }]);

    const [report, st] = await reconcileHost(
      {
        conn,
        store,
        enclave,
        host: { ...host, handle: lpcHost },
        crypto: libsodiumCrypto,
      },
      { pull: true, push: true },
    );
    expect(st).toBe(Status.Success);
    expect(report).toBeDefined();
    if (!report) return;
    expect(report.bagCount).toBe(2);
    expect(report.uniqueMsgs).toBe(1);
    expect(report.numDupes).toBe(1);
    expect(report.missingLocal).toBe(1); // host msg not in archive
    expect(report.missingHost).toBe(1); // local-only
    // Host msgcheck = checksum of distinct msgs only (ignores bag dups).
    expect(report.msgcheck).toBeDefined();
    expect(report.msgcheck.length).toBe(32);

    const row = await store.hosts.get("test");
    expect(row?.numBags).toBe(2);
    expect(row?.numDupes).toBe(1);
    expect(row?.lastSeq).toBeGreaterThan(0);

    // pull enqueued download for missing local head
    expect(Array.from(await store.downloads.list()).length).toBe(1);
    // push enqueued local-only
    expect(await store.uploads.list("test")).toHaveLength(1);
  });

  test("pull false does not enqueue downloads", async () => {
    const hostIdnt = await enclave.deriveIdentity("test", 1);
    const message: IMessage = {
      eid: new Uint8Array(16).fill(5),
      off: 0,
      ctr: 0,
      len: 1,
      bod: new Uint8Array([1]),
    };
    const [bag, s] = await createTestBag(message, enclave);
    expect(s).toBe(Status.Success);
    if (!bag) return;
    await lpcHost.storage.setBags(hostIdnt.publicKey, [bag]);

    const [report, st] = await reconcileHost(
      {
        conn,
        store,
        enclave,
        host: { ...host, handle: lpcHost },
        crypto: libsodiumCrypto,
      },
      { pull: false, push: false },
    );
    expect(st).toBe(Status.Success);
    expect(report?.missingLocal).toBe(1);
    expect(Array.from(await store.downloads.list()).length).toBe(0);
  });

  test("host msgcheck matches checksum of distinct msgs", async () => {
    const hostIdnt = await enclave.deriveIdentity("test", 1);
    const msgA: IMessage = {
      eid: new Uint8Array(16).fill(6),
      off: 0,
      ctr: 0,
      len: 1,
      bod: new Uint8Array([1]),
    };
    const msgB: IMessage = {
      eid: new Uint8Array(16).fill(7),
      off: 0,
      ctr: 0,
      len: 1,
      bod: new Uint8Array([2]),
    };
    const [bagA1] = await createTestBag(msgA, enclave);
    const [bagA2] = await createTestBag(msgA, enclave); // dupe of A
    const [bagB] = await createTestBag(msgB, enclave);
    if (!bagA1 || !bagA2 || !bagB) return;
    await lpcHost.storage.setBags(hostIdnt.publicKey, [bagA1, bagA2, bagB]);

    // Expected: msgs A and B only (A has two bags on host).
    const msgHash = async (m: IMessage) => {
      let hsh: Uint8Array | undefined;
      if (m.bod && m.len > 0) hsh = await libsodiumCrypto.blake3(m.bod);
      const enc = new Encoder();
      messageHeadCodec.encode(enc, { ...m, hsh });
      return await libsodiumCrypto.blake3(enc.result()) as Hash;
    };
    const ha = await msgHash(msgA);
    const hb = await msgHash(msgB);
    const expected = await checksumSet([ha, hb], libsodiumCrypto);

    // Stale high cursor — reconcile should reset lastSeq from inventory.
    await store.hosts.recordStats("test", { lastSeq: 999 });

    const [report, st] = await reconcileHost(
      {
        conn,
        store,
        enclave,
        host: { ...host, handle: lpcHost, lastSeq: 999 },
        crypto: libsodiumCrypto,
      },
      { pull: false, push: false },
    );
    expect(st).toBe(Status.Success);
    expect(report?.uniqueMsgs).toBe(2);
    expect(report?.numDupes).toBe(1);
    expect(bytesEqual(report!.msgcheck, expected)).toBe(true);
    const row = await store.hosts.get("test");
    expect(row?.lastSeq).toBeLessThan(999);
    expect(row?.lastSeq).toBeGreaterThan(0);
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
    const hostIdnt = await conn.identity();
    const [_, addStatus] = await lpcHost.storage.addUser(hostIdnt.publicKey);
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
      apld: APLD_APPLIED,
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
    // Multi-batch byte budgets are unit-tested in sync-batch.test.ts.
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
    const hostIdnt = await conn.identity();
    const [_, addStatus] = await lpcHost.storage.addUser(hostIdnt.publicKey);
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
    const keys = await enclave.deriveIdentity("test", 1);
    const [seqs, setStatus] = await lpcHost.storage.setBags(keys.publicKey, [
      bag,
    ]);
    if (setStatus !== Status.Success || !seqs?.[0]) {
      expect(setStatus).toBe(Status.Success);
      return;
    }
    const seq = seqs[0];

    const download: IDownloadMessage = {
      kdm: bag.kdm,
      head: message,
      host: "test",
      seq,
    };
    await store.downloads.enq([download]);

    await syncPull({
      conn,
      store,
      enclave,
      host,
      crypto: libsodiumCrypto,
    });

    const messages = Array.from(await store.messages.list());
    expect(messages.length).toBe(1);
    expect(messages[0].body).toEqual(message.bod);
    expect(await store.downloads.count()).toBe(0);
  });

  test("deqDownloadsForHeadHashes clears queue when archive gains the msg", async () => {
    const { deqDownloadsForHeadHashes } = await import("../src/sync");
    const body = new Uint8Array([1, 2, 3, 4]);
    const message: IMessage = {
      eid: new Uint8Array(16).fill(9),
      off: 0,
      ctr: 0,
      len: body.length,
      bod: body,
      hsh: await libsodiumCrypto.blake3(body),
    };
    const enc = new Encoder();
    enc.writeStruct(messageHeadCodec, message);
    const headEnc = enc.result();
    const headEncHash = await libsodiumCrypto.blake3(headEnc) as Hash;

    await store.downloads.enq([{
      kdm: new Uint8Array(8).fill(1),
      head: message,
      host: "test",
      seq: 99,
      headEnc,
      headEncHash,
    }]);
    expect(await store.downloads.count()).toBe(1);

    // Same moment as import/apply: archive the msg, then deq matching downloads.
    await store.messages.add([{
      key: headEncHash,
      data: { eid: message.eid, body, apld: APLD_APPLIED },
    }]);
    await deqDownloadsForHeadHashes(store, [headEncHash], libsodiumCrypto);

    expect(await store.downloads.count()).toBe(0);

    let pullCalls = 0;
    const origPull = conn.pull.bind(conn);
    conn.pull = async (seqs) => {
      pullCalls += 1;
      return origPull(seqs);
    };
    const st = await syncPull({
      conn,
      store,
      enclave,
      host,
      crypto: libsodiumCrypto,
    });
    expect(st).toBe(Status.NoChange);
    expect(pullCalls).toBe(0);
  });

  test("single pull batch finishes (no wait for a missing next batch)", async () => {
    const body = new Uint8Array([9, 8, 7, 6]);
    const message: IMessage = {
      eid: new Uint8Array(16).fill(2),
      off: 0,
      ctr: 0,
      len: body.length,
      bod: body,
      hsh: await libsodiumCrypto.blake3(body),
    };
    const [bag, statBag] = await createTestBag(message, enclave);
    expect(statBag).toBe(Status.Success);
    if (statBag !== Status.Success || !bag) return;

    const keys = await enclave.deriveIdentity("test", 1);
    const [seqs, setStatus] = await lpcHost.storage.setBags(keys.publicKey, [
      bag,
    ]);
    expect(setStatus).toBe(Status.Success);
    const seq = seqs?.[0];
    expect(seq).toBeDefined();
    if (seq === undefined) return;

    await store.downloads.enq([{
      kdm: bag.kdm,
      head: message,
      host: "test",
      seq,
    }]);

    let pullCalls = 0;
    let afterOpenCalls = 0;
    const origPull = conn.pull.bind(conn);
    conn.pull = async (seqs) => {
      pullCalls += 1;
      return origPull(seqs);
    };

    const st = await Promise.race([
      syncPull(
        {
          conn,
          store,
          enclave,
          host,
          crypto: libsodiumCrypto,
        },
        async () => {
          afterOpenCalls += 1;
        },
      ),
      new Promise<Status>((_, reject) =>
        setTimeout(
          () => reject(new Error("syncPull hung on single batch")),
          5_000,
        )
      ),
    ]);

    expect(st).toBe(Status.Success);
    expect(pullCalls).toBe(1);
    expect(afterOpenCalls).toBe(1);
    expect(await store.downloads.count()).toBe(0);
  });

  test("handles no downloads", async () => {
    const stat = await syncPull({
      conn,
      store,
      enclave,
      host,
      crypto: libsodiumCrypto,
    });

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
    const keys = await enclave.deriveIdentity("test", 1);
    const [seqs, setStatus] = await lpcHost.storage.setBags(keys.publicKey, [
      bag,
    ]);
    if (setStatus !== Status.Success || !seqs?.[0]) {
      expect(setStatus).toBe(Status.Success);
      return;
    }
    const seq = seqs[0];

    const download: IDownloadMessage = {
      kdm: bag.kdm,
      head: message,
      host: "test",
      seq,
    };
    await store.downloads.enq([download]);

    await syncPull({
      conn,
      store,
      enclave,
      host,
      crypto: libsodiumCrypto,
    });

    const messages = Array.from(await store.messages.list());
    expect(messages.length).toBe(1);
    expect(messages[0].body).toBeUndefined();
  });

  test("drains download queue under a tight maxPullBytes budget", async () => {
    const keys = await enclave.deriveIdentity("test", 1);
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
      const [seqs, setStatus] = await lpcHost.storage.setBags(keys.publicKey, [
        bag,
      ]);
      expect(setStatus).toBe(Status.Success);
      expect(seqs?.[0]).toBeDefined();
      downloads.push({
        kdm: bag.kdm,
        head: message,
        host: "test",
        seq: seqs[0],
      });
    }
    await store.downloads.enq(downloads);

    // Multi-batch byte budgets are unit-tested in sync-batch.test.ts.
    const stat = await syncPull({
      conn,
      store,
      enclave,
      host,
      crypto: libsodiumCrypto,
      maxPullBytes: 4,
    });

    expect(stat).toBe(Status.Success);
    expect(await store.downloads.count()).toBe(0);
    expect(Array.from(await store.messages.list()).length).toBe(3);
  });
});
