import { describe, expect, test } from "vitest";
import { checksumHashes, cmpBytes } from "../src/shared/checksum";
import libsodiumCrypto from "../src/crypto";
import type { Hash } from "../src/shared/types";
import { bytesEqual } from "../src/shared/binary";
import { MemoryStore } from "../src/stores/memory/store";
import { SyncClient } from "../src/client";
import type { IStateManager, MasterSeed } from "../src/shared/types";
import { Status } from "../src/shared/consts";
import { APLD_APPLIED } from "../src/types";

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

describe("checksumHashes", () => {
  test("empty set is blake3 of empty", async () => {
    const a = await checksumHashes([], libsodiumCrypto);
    const b = await libsodiumCrypto.blake3(new Uint8Array(0));
    expect(bytesEqual(a, b)).toBe(true);
  });

  test("order of input does not matter", async () => {
    const x = h(Array(32).fill(1));
    const y = h(Array(32).fill(2));
    const z = h(Array(32).fill(3));
    const c1 = await checksumHashes([x, y, z], libsodiumCrypto);
    const c2 = await checksumHashes([z, x, y], libsodiumCrypto);
    expect(bytesEqual(c1, c2)).toBe(true);
  });

  test("matches blake3 of sorted concat", async () => {
    const lo = h(Array(32).fill(1));
    const hi = h(Array(32).fill(9));
    // Input high-first; sorted should be lo then hi.
    const got = await checksumHashes([hi, lo], libsodiumCrypto);
    const buf = new Uint8Array(64);
    buf.set(lo, 0);
    buf.set(hi, 32);
    const want = await libsodiumCrypto.blake3(buf);
    expect(bytesEqual(got, want)).toBe(true);
  });

  test("different sets differ", async () => {
    const a = await checksumHashes([h(Array(32).fill(1))], libsodiumCrypto);
    const b = await checksumHashes([h(Array(32).fill(2))], libsodiumCrypto);
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
    const expectC = await checksumHashes([k2, k1], libsodiumCrypto);
    expect(bytesEqual(c, expectC)).toBe(true);

    await store.messages.del([k1]);
    const c2 = await client.msgcheck();
    const expectC2 = await checksumHashes([k2], libsodiumCrypto);
    expect(bytesEqual(c2, expectC2)).toBe(true);
  });
});
