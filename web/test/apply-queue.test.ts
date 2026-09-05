import { describe, expect, test, vi } from "vitest";
import { encode } from "@msgpack/msgpack";
import { SyncClient } from "../src/client";
import { MemoryStore } from "../src/stores/memory/store";
import libsodiumCrypto from "../src/crypto";
import { Status } from "../src/shared/consts";
import { Encoder } from "../src/shared/codec";
import { messageHeadCodec } from "../src/shared/codecs/messageHead";
import { Enclave } from "../src/shared/crypto/enclave";
import type { EntityID, Hash, IMessage, IProtoHost, IStateManager } from "../src/shared/types";
import {
  APLD_APPLIED,
  APLD_ERROR,
  APLD_PENDING,
  apldFromStored,
  isApldState,
  isPendingApply,
  isTerminalApplyFailure,
  setApld } from "../src/types";
import { msg2StoredMsgData } from "../src/sync";
import { MockClock } from "../src/shared/clock";
import { makeEID } from "../src/shared/codecs/eid";
import { revFromHead } from "../src/entdb/entdb";
import { DiplomaticLPCServer, LPCTransport } from "../src/shared/lpc/server";
import memStorage from "../src/shared/storage/memory";
import { CallbackNotifier } from "../src/shared/lpc/pusher";
import type { IHostConnectionInfo } from "../src/shared/types";

function testEnclave(): Enclave {
  const [e, st] = Enclave.fromBytes(new Uint8Array(32).fill(7));
  if (st !== Status.Success || e === undefined) throw new Error(`enclave ${st}`);
  return e;
}

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
      apld: APLD_PENDING } }]);
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
    notify() {},
    async refresh() {},
    on() {},
    off() {} };
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

describe("apld helpers", () => {
  test("apld type is only the three ApldState constants", () => {
    expect(isApldState(APLD_PENDING)).toBe(true);
    expect(isApldState(APLD_APPLIED)).toBe(true);
    expect(isApldState(APLD_ERROR)).toBe(true);
    expect(isApldState("f")).toBe(true);
    expect(isApldState("t")).toBe(true);
    expect(isApldState("e")).toBe(true);
    expect(isApldState(true)).toBe(false);
    expect(isApldState(false)).toBe(false);
    expect(isApldState("x")).toBe(false);
    expect(isApldState(0)).toBe(false);
    expect(isApldState(undefined)).toBe(false);
  });

  test("pending when apld is PENDING or unset; not APPLIED/ERROR", () => {
    const eid = eidOf(1);
    expect(isPendingApply({ eid, apld: APLD_PENDING })).toBe(true);
    expect(isPendingApply({ eid })).toBe(true); // legacy unset → pending
    expect(isPendingApply({ eid, apld: APLD_APPLIED })).toBe(false);
    expect(isPendingApply({ eid, apld: APLD_ERROR })).toBe(false);
  });

  test("apldFromStored coerces raw storage values", () => {
    expect(apldFromStored(APLD_PENDING)).toBe(APLD_PENDING);
    expect(apldFromStored(APLD_APPLIED)).toBe(APLD_APPLIED);
    expect(apldFromStored(APLD_ERROR)).toBe(APLD_ERROR);
    expect(apldFromStored(undefined)).toBe(APLD_PENDING);
    // Runtime-only legacy values (not assignable to ApldState at type level).
    expect(apldFromStored(false)).toBe(APLD_PENDING);
    expect(apldFromStored(true)).toBe(APLD_APPLIED);
    expect(apldFromStored("nope")).toBe(APLD_PENDING);
  });

  test("setApld mutates in place and clears err when not ERROR", () => {
    const row = {
      eid: eidOf(1),
      body: new Uint8Array([1]),
      apld: APLD_PENDING,
      err: Status.InvalidMessage };
    setApld(row, APLD_APPLIED);
    expect(row.apld).toBe(APLD_APPLIED);
    expect(row.err).toBeUndefined();
    expect(row.body).toEqual(new Uint8Array([1]));
    setApld(row, APLD_ERROR, Status.HashMismatch);
    expect(row.apld).toBe(APLD_ERROR);
    expect(row.err).toBe(Status.HashMismatch);
  });

  test("isTerminalApplyFailure classifies statuses", () => {
    expect(isTerminalApplyFailure(Status.InvalidMessage)).toBe(true);
    expect(isTerminalApplyFailure(Status.HashMismatch)).toBe(true);
    expect(isTerminalApplyFailure(Status.Success)).toBe(false);
    expect(isTerminalApplyFailure(Status.NoChange)).toBe(false);
    expect(isTerminalApplyFailure(Status.DatabaseError)).toBe(false);
    expect(isTerminalApplyFailure(Status.StorageError)).toBe(false);
  });
});

describe("msg2StoredMsgData", () => {
  test("marks new archive rows unapplied", () => {
    const eid = eidOf(2);
    const data = msg2StoredMsgData({
      head: { eid, off: 0, ctr: 0, len: 0 },
      body: new Uint8Array([9]) });
    expect(data.apld).toBe(APLD_PENDING);
    expect(isPendingApply(data)).toBe(true);
  });
});

describe("MemoryMessageStore apply queue", () => {
  test("list({ apld }) filters by apply state; list() returns all", async () => {
    const store = new MemoryStore<IProtoHost>(libsodiumCrypto);
    await store.messages.add([
      {
        key: hashOf(1),
        data: { eid: eidOf(1), body: new Uint8Array([1]), apld: APLD_PENDING } },
      {
        key: hashOf(2),
        data: { eid: eidOf(2), body: new Uint8Array([2]), apld: APLD_APPLIED } },
      {
        key: hashOf(4),
        data: {
          eid: eidOf(4),
          body: new Uint8Array([4]),
          apld: APLD_ERROR,
          err: Status.InvalidMessage } },
    ]);
    // Simulate legacy row without apld (bypass write type by writing map directly).
    store.messages.messages.set(
      // same encoding as add
      (await import("../src/shared/binary")).btob64(hashOf(3)),
      { eid: eidOf(3), body: new Uint8Array([3]) },
    );
    const pending = await store.messages.list({ apld: APLD_PENDING });
    // f + unset both pending; t and e excluded
    expect(pending.length).toBe(2);
    expect(pending.map((p) => p.apld)).toEqual([APLD_PENDING, APLD_PENDING]);
    // default body: true
    expect(pending[0].body).toBeDefined();
    expect(pending[0].head.len).toBe(1);
    const noBody = await store.messages.list({
      apld: APLD_PENDING,
      body: false });
    expect(noBody[0].body).toBeUndefined();
    expect(noBody[0].head.hsh).toBeUndefined();
    expect(noBody[0].head.len).toBe(1);
    const applied = await store.messages.list({ apld: APLD_APPLIED });
    expect(applied).toHaveLength(1);
    expect(applied[0].hash).toEqual(hashOf(2));
    const failed = await store.messages.list({ apld: APLD_ERROR });
    expect(failed).toHaveLength(1);
    expect(failed[0].hash).toEqual(hashOf(4));
    expect(failed[0].err).toBe(Status.InvalidMessage);
    // get coerces unset → APLD_PENDING
    expect((await store.messages.get(hashOf(3)))?.apld).toBe(APLD_PENDING);
    expect(await store.messages.list()).toHaveLength(4);
    expect(await store.messages.count()).toBe(4);
    expect(await store.messages.count(APLD_PENDING)).toBe(2);
    expect(await store.messages.count(APLD_ERROR)).toBe(1);
    expect(await store.messages.count(APLD_APPLIED)).toBe(1);
  });

  test("markApplied flips pending to applied", async () => {
    const store = new MemoryStore<IProtoHost>(libsodiumCrypto);
    const h = hashOf(10);
    await storePending(store, { hash: h, eid: eidOf(10) });
    await store.messages.markApplied([h]);
    expect(await store.messages.list({ apld: APLD_PENDING })).toHaveLength(0);
    expect((await store.messages.get(h))?.apld).toBe(APLD_APPLIED);
  });

  test("markFailed flips pending to e and stores err", async () => {
    const store = new MemoryStore<IProtoHost>(libsodiumCrypto);
    const h = hashOf(11);
    await storePending(store, { hash: h, eid: eidOf(11) });
    await store.messages.markFailed([{ key: h, err: Status.InvalidMessage }]);
    expect(await store.messages.list({ apld: APLD_PENDING })).toHaveLength(0);
    const row = await store.messages.get(h);
    expect(row?.apld).toBe(APLD_ERROR);
    expect(row?.err).toBe(Status.InvalidMessage);
  });

  test("markApplied ignores missing keys", async () => {
    const store = new MemoryStore<IProtoHost>(libsodiumCrypto);
    await store.messages.markApplied([hashOf(99)]);
    expect(await store.messages.list({ apld: APLD_PENDING })).toHaveLength(0);
  });

  test("markApplied is selective among multiple pending", async () => {
    const store = new MemoryStore<IProtoHost>(libsodiumCrypto);
    const a = hashOf(20);
    const b = hashOf(21);
    await storePending(store, { hash: a, eid: eidOf(20) });
    await storePending(store, { hash: b, eid: eidOf(21) });
    await store.messages.markApplied([a]);
    const pending = await store.messages.list({ apld: APLD_PENDING });
    expect(pending).toHaveLength(1);
    expect(pending[0].hash).toEqual(b);
  });

  test("toStoredMessage exposes apld state", async () => {
    const store = new MemoryStore<IProtoHost>(libsodiumCrypto);
    const h = hashOf(30);
    await storePending(store, { hash: h, eid: eidOf(30) });
    const pending = await store.messages.get(h);
    expect(pending?.apld).toBe(APLD_PENDING);
    await store.messages.markApplied([h]);
    expect((await store.messages.get(h))?.apld).toBe(APLD_APPLIED);
  });
});

describe("SyncClient apply queue", () => {
  test("insertRaw applies and marks applied", async () => {
    const store = new MemoryStore<IProtoHost>(libsodiumCrypto);
    const state = mockState();
    const client = makeClient(store, state);
    await client.setSeed(testEnclave());
    const [head, st] = await client.insert({
      type: "note",
      body: { t: "hi" },
    });
    expect(st).toBe(Status.Success);
    expect(head).toBeDefined();
    expect(state.applied).toHaveLength(1);
    const listed = Array.from(await store.messages.list());
    expect(listed).toHaveLength(1);
    expect(listed[0].apld).toBe(APLD_APPLIED);
    expect(await store.messages.list({ apld: APLD_PENDING })).toHaveLength(0);
  });

  test("updateRaw and delete mark applied", async () => {
    const store = new MemoryStore<IProtoHost>(libsodiumCrypto);
    const state = mockState();
    const client = makeClient(store, state);
    await client.setSeed(testEnclave());
    const [ins, stIns] = await client.insertRaw(
      encode({ type: "t", body: 1 }),
    );
    expect(stIns).toBe(Status.Success);
    if (!ins) throw new Error("missing head");
    const [prior, stPrior] = revFromHead(ins);
    expect(stPrior).toBe(Status.Success);
    if (!prior) throw new Error("missing prior");
    const [up, stUp] = await client.updateRaw(
      prior,
      encode({ type: "t", body: 2 }),
    );
    expect(stUp).toBe(Status.Success);
    expect(up).toBeDefined();
    if (!up) throw new Error("missing up head");
    const [prior2, stPrior2] = revFromHead(up);
    expect(stPrior2).toBe(Status.Success);
    if (!prior2) throw new Error("missing prior2");
    await client.delete({ prior: prior2 });
    const listed = Array.from(await store.messages.list());
    expect(listed.length).toBeGreaterThanOrEqual(2);
    for (const m of listed) {
      expect(m.apld).toBe(APLD_APPLIED);
    }
    expect(await store.messages.list({ apld: APLD_PENDING })).toHaveLength(0);
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
      idx: 0 };
    const client = makeClient(
      store,
      state,
      () => new LPCTransport(lpcHost),
    );
    await client.setSeed(testEnclave());
    await client.link(host, false);
    expect(await store.uploads.count()).toBe(0);
    await client.insertRaw(encode({ type: "t", body: "x" }));
    expect(await store.uploads.count()).toBe(1);
    expect(await store.messages.list({ apld: APLD_PENDING })).toHaveLength(0);
  });

  test("failed exec does not enqueue upload", async () => {
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
    await client.setSeed(testEnclave());
    await client.link(
      { handle: lpcHost, label: "h", idx: 0 },
      false,
    );
    await client.insertRaw(encode({ type: "t", body: "x" }));
    // App rejected the msg — do not push to hosts; terminal → not pending.
    expect(await store.uploads.count()).toBe(0);
    expect(await store.messages.list({ apld: APLD_PENDING })).toHaveLength(0);
    const listed = Array.from(await store.messages.list());
    expect(listed).toHaveLength(1);
    expect(listed[0].apld).toBe(APLD_ERROR);
    expect(listed[0].err).toBe(Status.InvalidMessage);
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
    await client.setSeed(testEnclave());
    await client.link(
      { handle: lpcHost, label: "h", idx: 0 },
      false,
    );
    await client.insertRaw(encode({ type: "t", body: "x" }));
    expect(await store.messages.list({ apld: APLD_PENDING })).toHaveLength(0);
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
    // list(APLD_PENDING) rebuilds heads from stored data (len from body).
    const stats = await client.drainApplyQueue();
    expect(stats).toEqual([Status.Success, Status.InvalidMessage]);
    expect(call).toBe(1);

    expect(await store.messages.list({ apld: APLD_PENDING })).toHaveLength(0);
    expect((await store.messages.get(h1))?.apld).toBe(APLD_APPLIED);
    const failed = await store.messages.get(h2);
    expect(failed?.apld).toBe(APLD_ERROR);
    expect(failed?.err).toBe(Status.InvalidMessage);
  });

  test("listMsgs/countMsgs expose failed archive rows", async () => {
    const store = new MemoryStore<IProtoHost>(libsodiumCrypto);
    const state = mockState(async (msgs) =>
      msgs.map(() => Status.InvalidMessage)
    );
    const client = makeClient(store, state);
    await client.insertRaw(encode({ type: "t", body: "poison" }));
    expect(await client.countMsgs(APLD_ERROR)).toBe(1);
    expect(await client.countMsgs(APLD_PENDING)).toBe(0);
    const failed = await client.listMsgs({ apld: APLD_ERROR });
    expect(failed).toHaveLength(1);
    expect(failed[0].err).toBe(Status.InvalidMessage);
    expect(failed[0].body).toBeDefined();
    const light = await client.listMsgs({ apld: APLD_ERROR, body: false });
    expect(light[0].body).toBeUndefined();
    expect(light[0].head.hsh).toBeUndefined();
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
      ts: new Date(0) });
    expect(eidStat).toBe(Status.Success);
    const head = { eid, off: 0, ctr: 0, len: 3 };
    const enc = new Encoder();
    enc.writeStruct(messageHeadCodec, head);
    const hash = await libsodiumCrypto.blake3(enc.result());
    await store.messages.add([{
      key: hash,
      data: { eid, body: new Uint8Array([1, 2, 3]), apld: APLD_PENDING } }]);

    expect(await store.messages.list({ apld: APLD_PENDING })).toHaveLength(1);
    const stats = await client.drainApplyQueue();
    expect(stats).toEqual([Status.Success]);
    expect(state.applied).toHaveLength(1);
    expect(await store.messages.list({ apld: APLD_PENDING })).toHaveLength(0);
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
    await client.setSeed(testEnclave());

    const [eid, eidStat] = makeEID({
      id: new Uint8Array(8).fill(2),
      ts: new Date(0) });
    expect(eidStat).toBe(Status.Success);
    const head = { eid, off: 0, ctr: 0, len: 1 };
    const enc = new Encoder();
    enc.writeStruct(messageHeadCodec, head);
    const hash = await libsodiumCrypto.blake3(enc.result());
    await store.messages.add([{
      key: hash,
      data: { eid, body: new Uint8Array([9]), apld: APLD_PENDING } }]);
    await store.hosts.add({ handle: lpcHost, label: "h", idx: 0 });

    expect(state.applied).toHaveLength(0);
    await client.connect(false, false);
    expect(state.applied).toHaveLength(1);
    expect(await store.messages.list({ apld: APLD_PENDING })).toHaveLength(0);
  });

  test("sync exec stage drains unapplied archive", async () => {
    const store = new MemoryStore<IProtoHost>(libsodiumCrypto);
    const order: string[] = [];
    const state = mockState(async (msgs) => {
      order.push("exec");
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
    await client.setSeed(testEnclave());
    await client.link(
      { handle: lpcHost, label: "h", idx: 0 },
      false,
    );
    await client.connect(false, false);

    const [eid, eidStat] = makeEID({
      id: new Uint8Array(8).fill(3),
      ts: new Date(0) });
    expect(eidStat).toBe(Status.Success);
    const head = { eid, off: 1, ctr: 0, len: 1 };
    const enc = new Encoder();
    enc.writeStruct(messageHeadCodec, head);
    const hash = await libsodiumCrypto.blake3(enc.result());
    await store.messages.add([{
      key: hash,
      data: { eid, off: 1, body: new Uint8Array([8]), apld: APLD_PENDING } }]);
    order.length = 0;

    const st = await client.sync();
    expect(st).toBe(Status.Success);
    expect(order).toContain("exec");
    expect(await store.messages.list({ apld: APLD_PENDING })).toHaveLength(0);
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
    await client.setSeed(testEnclave());

    const h = hashOf(50);
    await storePending(store, { hash: h, eid: eidOf(50) });

    await Promise.all([
      client.drainApplyQueue(),
      client.insertRaw(encode({ type: "t", body: 1 })),
    ]);
    expect(maxConcurrent).toBe(1);
    expect(await store.messages.list({ apld: APLD_PENDING })).toHaveLength(0);
  });

  test("transient DatabaseError stays pending for retry", async () => {
    const store = new MemoryStore<IProtoHost>(libsodiumCrypto);
    const state = mockState(async (msgs) =>
      msgs.map(() => Status.DatabaseError)
    );
    const client = makeClient(store, state);
    await client.setSeed(testEnclave());
    await client.insertRaw(encode({ type: "t", body: 1 }));
    expect(await store.messages.list({ apld: APLD_PENDING })).toHaveLength(1);
    // Retry drain still fails and stays pending (non-terminal)
    const stats = await client.drainApplyQueue();
    expect(stats).toEqual([Status.DatabaseError]);
    expect(await store.messages.list({ apld: APLD_PENDING })).toHaveLength(1);
  });

  test("terminal InvalidMessage marks e and is not retried", async () => {
    const store = new MemoryStore<IProtoHost>(libsodiumCrypto);
    const state = mockState(async (msgs) =>
      msgs.map(() => Status.InvalidMessage)
    );
    const client = makeClient(store, state);
    await client.setSeed(testEnclave());
    await client.insertRaw(encode({ type: "t", body: 1 }));
    expect(await store.messages.list({ apld: APLD_PENDING })).toHaveLength(0);
    const listed = Array.from(await store.messages.list());
    expect(listed[0].err).toBe(Status.InvalidMessage);
    // Drain finds nothing left to apply
    const stats = await client.drainApplyQueue();
    expect(stats).toEqual([]);
    expect(state.applied).toHaveLength(1); // only the insert path attempt
  });
});
