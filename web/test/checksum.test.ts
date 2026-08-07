import { describe, expect, test } from "vitest";
import { checksumEntRevs, checksumSet, cmpBytes } from "../src/shared/checksum";
import libsodiumCrypto from "../src/crypto";
import type { Hash, IEntRev } from "../src/shared/types";
import { bytesEqual } from "../src/shared/binary";
import { MemoryStore } from "../src/stores/memory/store";
import { SyncClient } from "../src/client";
import type { IStateManager, MasterSeed } from "../src/shared/types";
import { Status } from "../src/shared/consts";
import { APLD_APPLIED } from "../src/types";
import { EntDBMemory } from "../src/entdb/memory";
import { makeEID } from "../src/shared/codecs/eid";

function h(bytes: number[]): Hash {
  return new Uint8Array(bytes) as Hash;
}

describe("cmpBytes", () => {
  test("orders lexicographically", () => {
    expect(cmpBytes(h([1, 2]), h([1, 3]))).toBeLessThan(0);
    expect(cmpBytes(h([2]), h([1, 9]))).toBeGreaterThan(0);
    expect(cmpBytes(h([1, 2]), h([1, 2]))).toBe(0);
    expect(cmpBytes(h([1]), h([1, 0]))).toBeLessThan(0);
  });
});

describe("checksumSet", () => {
  test("empty set is blake3 of empty", async () => {
    const a = await checksumSet([], libsodiumCrypto);
    const b = await libsodiumCrypto.blake3(new Uint8Array(0));
    expect(bytesEqual(a, b)).toBe(true);
  });

  test("order of input does not matter", async () => {
    const x = h(Array(32).fill(1));
    const y = h(Array(32).fill(2));
    const z = h(Array(32).fill(3));
    const c1 = await checksumSet([x, y, z], libsodiumCrypto);
    const c2 = await checksumSet([z, x, y], libsodiumCrypto);
    expect(bytesEqual(c1, c2)).toBe(true);
  });

  test("matches blake3 of sorted concat", async () => {
    const lo = h(Array(32).fill(1));
    const hi = h(Array(32).fill(9));
    // Input high-first; sorted should be lo then hi.
    const got = await checksumSet([hi, lo], libsodiumCrypto);
    const buf = new Uint8Array(64);
    buf.set(lo, 0);
    buf.set(hi, 32);
    const want = await libsodiumCrypto.blake3(buf);
    expect(bytesEqual(got, want)).toBe(true);
  });

  test("different sets differ", async () => {
    const a = await checksumSet([h(Array(32).fill(1))], libsodiumCrypto);
    const b = await checksumSet([h(Array(32).fill(2))], libsodiumCrypto);
    expect(bytesEqual(a, b)).toBe(false);
  });
});

describe("client.msgcheck", () => {
  test("tracks archive membership", async () => {
    const store = new MemoryStore(libsodiumCrypto);
    const state: IStateManager = {
      async apply(msgs) {
        return msgs.map(() => Status.Success);
      },
      async clear() {
        return Status.Success;
      },
      notify() {},
      async refresh() {},
      on() {},
      off() {},
    };
    const client = new SyncClient(
      { now: () => new Date(0) },
      state,
      store,
      () => {
        throw new Error("no transport");
      },
      libsodiumCrypto,
    );
    await client.setSeed(new Uint8Array(32).fill(7) as MasterSeed);

    const empty = await client.msgcheck();
    expect(bytesEqual(empty, await libsodiumCrypto.blake3(new Uint8Array(0))))
      .toBe(true);

    const k1 = h(Array(32).fill(0x11));
    const k2 = h(Array(32).fill(0x22));
    await store.messages.add([
      {
        key: k1,
        data: {
          eid: new Uint8Array(16).fill(1),
          apld: APLD_APPLIED,
        },
      },
      {
        key: k2,
        data: {
          eid: new Uint8Array(16).fill(2),
          apld: APLD_APPLIED,
        },
      },
    ]);

    const c = await client.msgcheck();
    const expectC = await checksumSet([k2, k1], libsodiumCrypto);
    expect(bytesEqual(c, expectC)).toBe(true);

    await store.messages.del([k1]);
    const c2 = await client.msgcheck();
    const expectC2 = await checksumSet([k2], libsodiumCrypto);
    expect(bytesEqual(c2, expectC2)).toBe(true);
  });
});

describe("entDB.checksum", () => {
  test("frontier changes with apply; order-independent", async () => {
    const entDB = new EntDBMemory();
    const [empty, stEmpty] = await entDB.checksum(libsodiumCrypto);
    expect(stEmpty).toBe(Status.Success);
    expect(bytesEqual(empty!, await libsodiumCrypto.blake3(new Uint8Array(0))))
      .toBe(true);

    const [eid, stEid] = makeEID({
      id: new Uint8Array(8).fill(9),
      ts: new Date(1000),
    });
    expect(stEid).toBe(Status.Success);
    if (!eid) return;

    await entDB.apply([{
      eid,
      off: 50,
      ctr: 0,
      type: "todo",
      body: { t: "a" },
    }]);

    const [c1, st1] = await entDB.checksum(libsodiumCrypto);
    expect(st1).toBe(Status.Success);
    const rev: IEntRev = {
      eid,
      updatedAt: new Date(1050),
      ctr: 0,
    };
    const [expect1, stE1] = await checksumEntRevs([rev], libsodiumCrypto);
    expect(stE1).toBe(Status.Success);
    expect(bytesEqual(c1!, expect1!)).toBe(true);

    // Update changes frontier.
    await entDB.apply([{
      eid,
      off: 100,
      ctr: 1,
      type: "todo",
      body: { t: "b" },
    }]);
    const [c2, st2] = await entDB.checksum(libsodiumCrypto);
    expect(st2).toBe(Status.Success);
    expect(bytesEqual(c1!, c2!)).toBe(false);

    // Delete leaves a permanent tombstone in the frontier.
    await entDB.apply([{ eid, off: 150, ctr: 2 }]);
    const [c3, st3] = await entDB.checksum(libsodiumCrypto);
    expect(st3).toBe(Status.Success);
    expect(bytesEqual(c2!, c3!)).toBe(false);
    const [expectTomb, stT] = await checksumEntRevs([{
      eid,
      updatedAt: new Date(1150),
      ctr: 2,
    }], libsodiumCrypto);
    expect(stT).toBe(Status.Success);
    expect(bytesEqual(c3!, expectTomb!)).toBe(true);
  });
});
