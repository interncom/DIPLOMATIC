// Tests realm counters and the realm label stored on ents and messages.

import { describe, expect, test } from "vitest";
import { SyncClient } from "../src/client";
import libsodiumCrypto from "../src/crypto";
import { EntDBMemory } from "../src/entdb/memory";
import { MockClock } from "../src/shared/clock";
import { makeEID } from "../src/shared/codecs/eid";
import { Status } from "../src/shared/consts";
import { Enclave } from "../src/shared/crypto/enclave";
import type { IProtoHost } from "../src/shared/types";
import { MemoryRealmStore } from "../src/stores/memory/realms";
import { MemoryStore } from "../src/stores/memory/store";
import { advanceRealm, decodeRealm, realmLabel } from "../src/stores/realm";
import { nullStateManager } from "../src/state";
import { APLD_PENDING } from "../src/types";

function enclave(): Enclave {
  const [e, st] = Enclave.fromBytes(new Uint8Array(32).fill(4));
  if (st !== Status.Success || e === undefined) {
    throw new Error(`enclave ${st}`);
  }
  return e;
}

describe("advanceRealm", () => {
  test("a higher counter keeps the previous one", () => {
    const [first, s1] = advanceRealm("inbox", undefined, 0);
    expect(s1).toBe(Status.Success);
    expect(first).toEqual({ label: "inbox", index: 0 });
    const [next, s2] = advanceRealm("inbox", first, 1);
    expect(s2).toBe(Status.Success);
    expect(next).toEqual({ label: "inbox", index: 1, prior: [0] });
  });

  test("the same counter leaves prior in place", () => {
    const held = [0];
    const [next, st] = advanceRealm(
      "inbox",
      { label: "inbox", index: 1, prior: held },
      1,
    );
    expect(st).toBe(Status.Success);
    expect(next?.prior).toEqual([0]);
    held.push(9);
    expect(next?.prior).toEqual([0]);
  });

  test("a lower counter is rejected", () => {
    const [next, st] = advanceRealm(
      "inbox",
      { label: "inbox", index: 2, prior: [0] },
      1,
    );
    expect(st).toBe(Status.InvalidParam);
    expect(next).toBeUndefined();
  });

  test("decodeRealm drops a row whose prior is not counters", () => {
    expect(decodeRealm({ label: "inbox", index: 1, prior: ["x"] })).toBe(
      undefined,
    );
    expect(decodeRealm({ label: "inbox", index: 1 })).toEqual({
      label: "inbox",
      index: 1,
    });
    expect(decodeRealm({ label: "inbox", seq: 1 })).toBeUndefined();
  });
});

describe("MemoryRealmStore", () => {
  test("a counter bump keeps the previous one", async () => {
    const realms = new MemoryRealmStore();
    expect(await realms.put("calendar", 0)).toBe(Status.Success);
    expect(await realms.put("calendar", 2)).toBe(Status.Success);
    expect(await realms.get("calendar")).toEqual({
      label: "calendar",
      index: 2,
      prior: [0],
    });
    const got = await realms.get("calendar");
    got?.prior?.push(5);
    expect((await realms.get("calendar"))?.prior).toEqual([0]);
    await realms.wipe();
    expect(await realms.list()).toEqual([]);
  });

  test("another store is another account", async () => {
    const a = new MemoryRealmStore();
    const b = new MemoryRealmStore();
    expect(await a.put("calendar", 1)).toBe(Status.Success);
    expect(await b.list()).toEqual([]);
  });
});

describe("realm label on ents and messages", () => {
  test("the default realm is omitted and a label is kept", async () => {
    const [eid, est] = makeEID({
      id: new Uint8Array(8).fill(3),
      ts: new Date(1),
    });
    if (est !== Status.Success || eid === undefined) {
      expect(est).toBe(Status.Success);
      return;
    }
    const db = new EntDBMemory();
    const base = {
      eid,
      type: "note",
      body: { n: 1 },
      createdAt: new Date(1),
      updatedAt: new Date(1),
      ctr: 0,
    };
    const blank = { ...base };
    Object.assign(blank, { rlm: "" });
    db.put(blank);
    const [omitted, ost] = await db.getEnt(eid);
    expect(ost).toBe(Status.Success);
    expect(omitted?.rlm).toBeUndefined();
    const inbox = realmLabel("inbox");
    expect(inbox).toBe("inbox");
    if (inbox === undefined) return;
    db.put({ ...base, rlm: inbox });
    const [kept, kst] = await db.getEnt(eid);
    expect(kst).toBe(Status.Success);
    expect(kept?.rlm).toBe("inbox");

    const store = new MemoryStore<IProtoHost>(libsodiumCrypto);
    const hash = await libsodiumCrypto.blake3(new Uint8Array([1]));
    const emptyRow = { eid, apld: APLD_PENDING };
    Object.assign(emptyRow, { rlm: "" });
    await store.messages.add([{
      key: hash,
      data: emptyRow,
    }]);
    expect((await store.messages.get(hash))?.rlm).toBeUndefined();
    await store.messages.add([{
      key: hash,
      data: { eid, apld: APLD_PENDING, rlm: inbox },
    }]);
    expect((await store.messages.get(hash))?.rlm).toBe("inbox");
  });

  test("opening an account copies the realms table", async () => {
    const store = new MemoryStore<IProtoHost>(libsodiumCrypto);
    expect(await store.realms.put("inbox", 0)).toBe(Status.Success);
    expect(await store.realms.put("inbox", 1)).toBe(Status.Success);
    const client = new SyncClient(
      new MockClock(),
      nullStateManager,
      store,
      () => {
        throw new Error("no transport");
      },
      libsodiumCrypto,
    );
    expect(await client.setSeed(enclave())).toBe(Status.Success);
    expect(client.selected()?.realms).toEqual([
      { label: "inbox", index: 1, prior: [0] },
    ]);
    expect(await store.realms.put("calendar", 0)).toBe(Status.Success);
    expect(await client.sync()).toBe(Status.Success);
    expect(client.selected()?.realms).toEqual([
      { label: "inbox", index: 1, prior: [0] },
      { label: "calendar", index: 0 },
    ]);
    await client.wipe({ seed: true, msgs: false, ents: false, meta: false });
    expect(await store.realms.list()).toEqual([]);
    expect(client.selected()).toBeUndefined();
  });
});
