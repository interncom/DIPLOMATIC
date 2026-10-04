// Tests an IndexedDB protocol store before its data database is open.

import { describe, expect, test } from "vitest";
import crypto from "../src/crypto";
import { makeEID } from "../src/shared/codecs/eid";
import { Status } from "../src/shared/consts";
import { nullSubMeta } from "../src/shared/types";
import { err } from "../src/shared/valstat";
import { IDBStore } from "../src/stores/idb/store";
import type { IAccountStore } from "../src/types";
import { APLD_PENDING } from "../src/types";

function account(): IAccountStore {
  return {
    async save() {
      return err(Status.InvalidParam);
    },
    async wipe() {},
  };
}

describe("IDBStore with no data database", () => {
  test("reads are empty and writes return a status", async () => {
    const store = new IDBStore(account(), crypto, async () => undefined);
    expect(await store.hosts.list()).toEqual([]);
    expect(await store.hosts.get("h")).toBeUndefined();
    await store.hosts.add({
      handle: new URL("http://localhost"),
      label: "h",
      idx: 0,
    });
    expect(
      await store.hosts.set("h", {
        subscription: nullSubMeta,
        clockOffset: 0,
      }),
    ).toBe(Status.NotFound);
    expect(await store.uploads.count()).toBe(0);
    expect(await store.downloads.count()).toBe(0);
    expect([...(await store.downloads.list())]).toEqual([]);
    expect(await store.realms.list()).toEqual([]);
    expect(await store.realms.put("inbox", 1)).toBe(Status.NotFound);
    expect(await store.messages.count()).toBe(0);
    expect(await store.messages.list()).toEqual([]);
    const hash = await crypto.blake3(new Uint8Array([1]));
    expect(await store.messages.has(hash)).toBe(false);
    const [eid, est] = makeEID({ id: new Uint8Array([2]), ts: new Date(1) });
    expect(est).toBe(Status.Success);
    if (est !== Status.Success || eid === undefined) return;
    expect(
      await store.messages.add([{
        key: hash,
        data: { eid, apld: APLD_PENDING },
      }]),
    ).toEqual([Status.DatabaseError]);
    expect(await store.bind("")).toBe(Status.NotFound);
    const [names, nst] = await store.prepareWorker("");
    expect(nst).toBe(Status.NotFound);
    expect(names).toBeUndefined();
    store.close();
    expect(await store.hosts.list()).toEqual([]);
    await store.wipe();
  });

  test("prepareWorker needs an account catalog", async () => {
    const store = new IDBStore(account(), crypto, async () => "data-x");
    const [names, nst] = await store.prepareWorker("a");
    expect(nst).toBe(Status.InvalidParam);
    expect(names).toBeUndefined();
  });

  test("a worker store with no database cannot bind", async () => {
    const store = new IDBStore(account(), crypto);
    expect(await store.bind("")).toBe(Status.NotFound);
  });
});
