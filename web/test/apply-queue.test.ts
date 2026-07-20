import { describe, expect, test, vi } from "vitest";
import { encode } from "@msgpack/msgpack";
import { SyncClient } from "../src/client";
import { MemoryStore } from "../src/stores/memory/store";
import libsodiumCrypto from "../src/crypto";
import { Status } from "../src/shared/consts";
import { Encoder } from "../src/shared/codec";
import { messageHeadCodec } from "../src/shared/codecs/messageHead";
import type {
  EntityID,
  Hash,
  IMessage,
  IProtoHost,
  IStateManager,
  MasterSeed,
} from "../src/shared/types";
import { isPendingApply } from "../src/types";
import { msg2StoredMsgData } from "../src/sync";
import { MockClock } from "../src/shared/clock";
import { makeEID } from "../src/shared/codecs/eid";
import { DiplomaticLPCServer, LPCTransport } from "../src/shared/lpc/server";
import memStorage from "../src/shared/storage/memory";
import { CallbackNotifier } from "../src/shared/lpc/pusher";
import type { IHostConnectionInfo } from "../src/shared/types";

const seed = new Uint8Array(32).fill(7) as MasterSeed;

function hashOf(n: number): Hash {
  return new Uint8Array(32).fill(n) as Hash;
}

function eidOf(n: number): EntityID {
  return new Uint8Array(16).fill(n) as EntityID;
}

async function storePending(
  store: MemoryStore<IProtoHost>,
  opts: { hash: Hash; eid: EntityID; body?: Uint8Array },
) {
  await store.messages.add([{
    key: opts.hash,
    data: {
      eid: opts.eid,
      body: opts.body ?? new Uint8Array([1]),
      apld: false,
    },
  }]);
}

function mockState(
  applyFn?: (msgs: IMessage[]) => Promise<Status[]> | Status[],
): IStateManager & { applied: IMessage[] } {
  const applied: IMessage[] = [];
  return {
    applied,
    async apply(msgs) {
      applied.push(...msgs);
      if (applyFn) {
        return await applyFn(msgs);
      }
      return msgs.map(() => Status.Success);
    },
    async clear() {
      return Status.Success;
    },
    on() {},
    off() {},
  };
}

function makeClient(
  store: MemoryStore<IProtoHost>,
  state: IStateManager,
  transport: () => ReturnType<typeof LPCTransport> | never = () => {
    throw new Error("no transport");
  },
  clock = new MockClock(new Date(1_000_000)),
) {
  return new SyncClient(
    clock,
    state,
    store,
    transport,
    libsodiumCrypto,
  );
}

describe("isPendingApply / normalizeStoredMessageData", () => {
  test("pending when apld is false or unset", () => {
    const eid = eidOf(1);
    expect(isPendingApply({ eid, apld: false })).toBe(true);
    expect(isPendingApply({ eid })).toBe(true); // legacy unset → pending
    expect(isPendingApply({ eid, apld: true })).toBe(false);
  });

  test("normalize coerces missing apld to false", async () => {
    const { normalizeStoredMessageData } = await import("../src/types");
    const n = normalizeStoredMessageData({ eid: eidOf(1), body: new Uint8Array([1]) });
    expect(n.apld).toBe(false);
    expect(n.eid).toEqual(eidOf(1));
  });
});

describe("msg2StoredMsgData", () => {
  test("marks new archive rows unapplied", () => {
    const eid = eidOf(2);
    const data = msg2StoredMsgData({
      head: { eid, off: 0, ctr: 0, len: 0 },
      body: new Uint8Array([9]),
    });
    expect(data.apld).toBe(false);
    expect(isPendingApply(data)).toBe(true);
  });
});

describe("MemoryMessageStore apply queue", () => {
  test("listUnapplied returns apld===false (and memory treats unset via normalize on get)", async () => {
    const store = new MemoryStore<IProtoHost>(libsodiumCrypto);
    await store.messages.add([
      {
        key: hashOf(1),
        data: { eid: eidOf(1), body: new Uint8Array([1]), apld: false },
      },
      {
        key: hashOf(2),
        data: { eid: eidOf(2), body: new Uint8Array([2]), apld: true },
      },
    ]);
    // Simulate legacy row without apld (bypass write type by writing map directly).
    store.messages.messages.set(
      // same encoding as add
      (await import("../src/shared/binary")).btob64(hashOf(3)),
      { eid: eidOf(3), body: new Uint8Array([3]) },
    );
    const pending = await store.messages.listUnapplied();
    // false + unset both pending in memory scan
    expect(pending.length).toBe(2);
    expect(pending.map((p) => p.applied)).toEqual([false, false]);
    // get normalizes unset → applied false
    expect((await store.messages.get(hashOf(3)))?.applied).toBe(false);
  });

  test("markApplied flips pending to applied", async () => {
    const store = new MemoryStore<IProtoHost>(libsodiumCrypto);
    const h = hashOf(10);
    await storePending(store, { hash: h, eid: eidOf(10) });
    await store.messages.markApplied([h]);
    expect(await store.messages.listUnapplied()).toHaveLength(0);
    expect((await store.messages.get(h))?.applied).toBe(true);
  });

  test("markApplied ignores missing keys", async () => {
    const store = new MemoryStore<IProtoHost>(libsodiumCrypto);
    await store.messages.markApplied([hashOf(99)]);
    expect(await store.messages.listUnapplied()).toHaveLength(0);
  });

  test("markApplied is selective among multiple pending", async () => {
    const store = new MemoryStore<IProtoHost>(libsodiumCrypto);
    const a = hashOf(20);
    const b = hashOf(21);
    await storePending(store, { hash: a, eid: eidOf(20) });
    await storePending(store, { hash: b, eid: eidOf(21) });
    await store.messages.markApplied([a]);
    const pending = await store.messages.listUnapplied();
    expect(pending).toHaveLength(1);
    expect(pending[0].hash).toEqual(b);
  });

  test("toStoredMessage exposes applied flag", async () => {
    const store = new MemoryStore<IProtoHost>(libsodiumCrypto);
    const h = hashOf(30);
    await storePending(store, { hash: h, eid: eidOf(30) });
    const pending = await store.messages.get(h);
    expect(pending?.applied).toBe(false);
    await store.messages.markApplied([h]);
    expect((await store.messages.get(h))?.applied).toBe(true);
  });
});

describe("SyncClient apply queue", () => {
  test("insertRaw applies and marks applied", async () => {
    const store = new MemoryStore<IProtoHost>(libsodiumCrypto);
    const state = mockState();
    const client = makeClient(store, state);
    await client.setSeed(seed);
    const [head, st] = await client.insertRaw(
      encode({ type: "note", body: { t: "hi" } }),
    );
    expect(st).toBe(Status.Success);
    expect(head).toBeDefined();
    expect(state.applied).toHaveLength(1);
    const listed = Array.from(await store.messages.list());
    expect(listed).toHaveLength(1);
    expect(listed[0].applied).toBe(true);
    expect(await store.messages.listUnapplied()).toHaveLength(0);
  });

  test("upsertRaw and delete mark applied", async () => {
    const store = new MemoryStore<IProtoHost>(libsodiumCrypto);
    const state = mockState();
    const client = makeClient(store, state);
    await client.setSeed(seed);
    const [ins, stIns] = await client.insertRaw(
      encode({ type: "t", body: 1 }),
    );
    expect(stIns).toBe(Status.Success);
    if (!ins) throw new Error("missing head");
    const [up, stUp] = await client.upsertRaw(
      ins.eid,
      encode({ type: "t", body: 2 }),
    );
    expect(stUp).toBe(Status.Success);
    expect(up).toBeDefined();
    await client.delete(ins.eid);
    const listed = Array.from(await store.messages.list());
    expect(listed.length).toBeGreaterThanOrEqual(2);
    for (const m of listed) {
      expect(m.applied).toBe(true);
    }
    expect(await store.messages.listUnapplied()).toHaveLength(0);
  });

  test("successful apply enqueues upload when hosts exist", async () => {
    const store = new MemoryStore<IProtoHost>(libsodiumCrypto);
    const state = mockState();
    const lpcHost = new DiplomaticLPCServer(
      memStorage,
      libsodiumCrypto,
      new CallbackNotifier(),
      new MockClock(new Date(0)),
    );
    const host: IHostConnectionInfo<IProtoHost> = {
      handle: lpcHost,
      label: "h",
      idx: 0,
    };
    const client = makeClient(
      store,
      state,
      () => new LPCTransport(lpcHost),
    );
    await client.setSeed(seed);
    await client.link(host, false);
    expect(await store.uploads.count()).toBe(0);
    await client.insertRaw(encode({ type: "t", body: "x" }));
    expect(await store.uploads.count()).toBe(1);
    expect(await store.messages.listUnapplied()).toHaveLength(0);
  });

  test("failed state.apply does not enqueue upload", async () => {
    const store = new MemoryStore<IProtoHost>(libsodiumCrypto);
    const state = mockState(async (msgs) =>
      msgs.map(() => Status.InvalidMessage)
    );
    const lpcHost = new DiplomaticLPCServer(
      memStorage,
      libsodiumCrypto,
      new CallbackNotifier(),
      new MockClock(new Date(0)),
    );
    const client = makeClient(
      store,
      state,
      () => new LPCTransport(lpcHost),
    );
    await client.setSeed(seed);
    await client.link(
      { handle: lpcHost, label: "h", idx: 0 },
      false,
    );
    await client.insertRaw(encode({ type: "t", body: "x" }));
    expect(await store.uploads.count()).toBe(0);
    expect(await store.messages.listUnapplied()).toHaveLength(1);
  });

  test("Status.NoChange still marks applied and may enqueue upload", async () => {
    const store = new MemoryStore<IProtoHost>(libsodiumCrypto);
    const state = mockState(async (msgs) =>
      msgs.map(() => Status.NoChange)
    );
    const lpcHost = new DiplomaticLPCServer(
      memStorage,
      libsodiumCrypto,
      new CallbackNotifier(),
      new MockClock(new Date(0)),
    );
    const client = makeClient(
      store,
      state,
      () => new LPCTransport(lpcHost),
    );
    await client.setSeed(seed);
    await client.link(
      { handle: lpcHost, label: "h", idx: 0 },
      false,
    );
    await client.insertRaw(encode({ type: "t", body: "x" }));
    expect(await store.messages.listUnapplied()).toHaveLength(0);
    expect(await store.uploads.count()).toBe(1);
  });

  test("partial batch failure marks only successes applied", async () => {
    const store = new MemoryStore<IProtoHost>(libsodiumCrypto);
    let call = 0;
    // First insert succeeds; we then simulate multi-msg via drain of two pending
    // rows with mixed apply results.
    const state = mockState(async (msgs) => {
      call += 1;
      // Used only by drain of two stored pending msgs.
      if (msgs.length === 2) {
        return [Status.Success, Status.InvalidMessage];
      }
      return msgs.map(() => Status.Success);
    });
    const client = makeClient(store, state);

    const h1 = hashOf(40);
    const h2 = hashOf(41);
    await storePending(store, { hash: h1, eid: eidOf(40), body: new Uint8Array([1]) });
    await storePending(store, { hash: h2, eid: eidOf(41), body: new Uint8Array([2]) });

    // Build minimal heads so toStoredMessage works; apply via drain.
    // listUnapplied rebuilds heads from stored data (len from body).
    const stats = await client.drainApplyQueue();
    expect(stats).toEqual([Status.Success, Status.InvalidMessage]);
    expect(call).toBe(1);

    const pending = await store.messages.listUnapplied();
    expect(pending).toHaveLength(1);
    expect(pending[0].hash).toEqual(h2);
    expect((await store.messages.get(h1))?.applied).toBe(true);
  });

  test("drainApplyQueue is no-op when empty", async () => {
    const store = new MemoryStore<IProtoHost>(libsodiumCrypto);
    const state = mockState();
    const client = makeClient(store, state);
    const stats = await client.drainApplyQueue();
    expect(stats).toEqual([]);
    expect(state.applied).toHaveLength(0);
  });

  test("drainApplyQueue applies crash leftovers", async () => {
    const store = new MemoryStore<IProtoHost>(libsodiumCrypto);
    const state = mockState();
    const client = makeClient(store, state, undefined, new MockClock(new Date(0)));

    const [eid, eidStat] = makeEID({
      id: new Uint8Array(8).fill(1),
      ts: new Date(0),
    });
    expect(eidStat).toBe(Status.Success);
    const head = { eid, off: 0, ctr: 0, len: 3 };
    const enc = new Encoder();
    enc.writeStruct(messageHeadCodec, head);
    const hash = await libsodiumCrypto.blake3(enc.result());
    await store.messages.add([{
      key: hash,
      data: { eid, body: new Uint8Array([1, 2, 3]), apld: false },
    }]);

    expect(await store.messages.listUnapplied()).toHaveLength(1);
    const stats = await client.drainApplyQueue();
    expect(stats).toEqual([Status.Success]);
    expect(state.applied).toHaveLength(1);
    expect(await store.messages.listUnapplied()).toHaveLength(0);
  });

  test("connect drains apply queue before network work", async () => {
    const store = new MemoryStore<IProtoHost>(libsodiumCrypto);
    const state = mockState();
    const lpcHost = new DiplomaticLPCServer(
      memStorage,
      libsodiumCrypto,
      new CallbackNotifier(),
      new MockClock(new Date(0)),
    );
    const client = makeClient(
      store,
      state,
      () => new LPCTransport(lpcHost),
      new MockClock(new Date(0)),
    );
    await client.setSeed(seed);

    const [eid, eidStat] = makeEID({
      id: new Uint8Array(8).fill(2),
      ts: new Date(0),
    });
    expect(eidStat).toBe(Status.Success);
    const head = { eid, off: 0, ctr: 0, len: 1 };
    const enc = new Encoder();
    enc.writeStruct(messageHeadCodec, head);
    const hash = await libsodiumCrypto.blake3(enc.result());
    await store.messages.add([{
      key: hash,
      data: { eid, body: new Uint8Array([9]), apld: false },
    }]);
    await store.hosts.add({ handle: lpcHost, label: "h", idx: 0 });

    expect(state.applied).toHaveLength(0);
    await client.connect(false, false);
    expect(state.applied).toHaveLength(1);
    expect(await store.messages.listUnapplied()).toHaveLength(0);
  });

  test("sync drains apply queue before peek/push/pull", async () => {
    const store = new MemoryStore<IProtoHost>(libsodiumCrypto);
    const order: string[] = [];
    const state = mockState(async (msgs) => {
      order.push("apply");
      return msgs.map(() => Status.Success);
    });
    const lpcHost = new DiplomaticLPCServer(
      memStorage,
      libsodiumCrypto,
      new CallbackNotifier(),
      new MockClock(new Date(0)),
    );
    const client = makeClient(
      store,
      state,
      () => new LPCTransport(lpcHost),
      new MockClock(new Date(0)),
    );
    await client.setSeed(seed);
    await client.link(
      { handle: lpcHost, label: "h", idx: 0 },
      false,
    );
    // Force a connection so doSync has work (and drains first).
    await client.connect(false, false);

    const [eid, eidStat] = makeEID({
      id: new Uint8Array(8).fill(3),
      ts: new Date(0),
    });
    expect(eidStat).toBe(Status.Success);
    const head = { eid, off: 1, ctr: 0, len: 1 };
    const enc = new Encoder();
    enc.writeStruct(messageHeadCodec, head);
    const hash = await libsodiumCrypto.blake3(enc.result());
    await store.messages.add([{
      key: hash,
      data: { eid, off: 1, body: new Uint8Array([8]), apld: false },
    }]);
    order.length = 0;

    const st = await client.sync();
    expect(st).toBe(Status.Success);
    expect(order[0]).toBe("apply");
    expect(await store.messages.listUnapplied()).toHaveLength(0);
  });

  test("serializes concurrent drainApplyQueue and insert", async () => {
    const store = new MemoryStore<IProtoHost>(libsodiumCrypto);
    let inApply = 0;
    let maxConcurrent = 0;
    const state = mockState(async (msgs) => {
      inApply += 1;
      maxConcurrent = Math.max(maxConcurrent, inApply);
      await new Promise((r) => setTimeout(r, 20));
      inApply -= 1;
      return msgs.map(() => Status.Success);
    });
    const client = makeClient(store, state);
    await client.setSeed(seed);

    const h = hashOf(50);
    await storePending(store, { hash: h, eid: eidOf(50) });

    await Promise.all([
      client.drainApplyQueue(),
      client.insertRaw(encode({ type: "t", body: 1 })),
    ]);
    expect(maxConcurrent).toBe(1);
    expect(await store.messages.listUnapplied()).toHaveLength(0);
  });

  test("mixed Success and failure returns per-hash stats from insert path", async () => {
    // Single-msg path: InvalidMessage → still archived pending
    const store = new MemoryStore<IProtoHost>(libsodiumCrypto);
    const state = mockState(async (msgs) =>
      msgs.map(() => Status.DatabaseError)
    );
    const client = makeClient(store, state);
    await client.setSeed(seed);
    await client.insertRaw(encode({ type: "t", body: 1 }));
    expect(await store.messages.listUnapplied()).toHaveLength(1);
    // Retry drain still fails and stays pending
    const stats = await client.drainApplyQueue();
    expect(stats).toEqual([Status.DatabaseError]);
    expect(await store.messages.listUnapplied()).toHaveLength(1);
  });
});
