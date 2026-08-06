import { beforeEach, describe, expect, test } from "vitest";
import { MemoryHostStore } from "../src/stores/memory/hosts";

describe("MemoryHostStore.touch", () => {
  let hosts: MemoryHostStore<URL>;

  beforeEach(async () => {
    hosts = new MemoryHostStore();
    await hosts.add({
      label: "h",
      handle: new URL("http://localhost"),
      idx: 1,
    });
  });

  test("advances lastSeq when seq is greater", async () => {
    await hosts.touch("h", 3);
    expect((await hosts.get("h"))?.lastSeq).toBe(3);

    await hosts.touch("h", 10);
    expect((await hosts.get("h"))?.lastSeq).toBe(10);
  });

  test("does not rewind lastSeq when seq is lower", async () => {
    await hosts.touch("h", 10);
    await hosts.touch("h", 4);
    expect((await hosts.get("h"))?.lastSeq).toBe(10);
  });

  test("does not change lastSeq when seq is equal", async () => {
    await hosts.touch("h", 5);
    await hosts.touch("h", 5);
    expect((await hosts.get("h"))?.lastSeq).toBe(5);
  });

  test("is a no-op for unknown host", async () => {
    await hosts.touch("missing", 1);
    expect(await hosts.get("missing")).toBeUndefined();
  });

  test("starts at 0 and accepts first positive seq", async () => {
    expect((await hosts.get("h"))?.lastSeq).toBe(0);
    await hosts.touch("h", 1);
    expect((await hosts.get("h"))?.lastSeq).toBe(1);
  });
});

describe("MemoryHostStore.recordStats", () => {
  let hosts: MemoryHostStore<URL>;

  beforeEach(async () => {
    hosts = new MemoryHostStore();
    await hosts.add({
      label: "h",
      handle: new URL("http://localhost"),
      idx: 1,
    });
  });

  test("starts numBags/numDupes at 0", async () => {
    const row = await hosts.get("h");
    expect(row?.numBags).toBe(0);
    expect(row?.numDupes).toBe(0);
  });

  test("applies bag/dupe deltas with lastSeq in one update", async () => {
    await hosts.recordStats("h", {
      lastSeq: 5,
      bagDelta: 3,
      dupeDelta: 1,
    });
    const row = await hosts.get("h");
    expect(row?.lastSeq).toBe(5);
    expect(row?.numBags).toBe(3);
    expect(row?.numDupes).toBe(1);
  });

  test("absolute numBags/numDupes replace (reconcile)", async () => {
    await hosts.recordStats("h", { bagDelta: 10, dupeDelta: 2 });
    await hosts.recordStats("h", { numBags: 7, numDupes: 1 });
    const row = await hosts.get("h");
    expect(row?.numBags).toBe(7);
    expect(row?.numDupes).toBe(1);
  });

  test("lastSeq advances only (incremental); setLastSeq can rewind", async () => {
    await hosts.recordStats("h", { lastSeq: 10, bagDelta: 1 });
    await hosts.recordStats("h", { lastSeq: 4, bagDelta: 1 });
    let row = await hosts.get("h");
    expect(row?.lastSeq).toBe(10);
    expect(row?.numBags).toBe(2);

    await hosts.recordStats("h", { setLastSeq: 3, numBags: 3, numDupes: 0 });
    row = await hosts.get("h");
    expect(row?.lastSeq).toBe(3);
    expect(row?.numBags).toBe(3);
  });
});
