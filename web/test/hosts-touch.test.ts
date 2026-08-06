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

  test("lastSeq advances only; setLastSeq can rewind", async () => {
    await hosts.recordStats("h", { lastSeq: 10 });
    await hosts.recordStats("h", { lastSeq: 4 });
    let row = await hosts.get("h");
    expect(row?.lastSeq).toBe(10);

    await hosts.recordStats("h", { setLastSeq: 3 });
    row = await hosts.get("h");
    expect(row?.lastSeq).toBe(3);
  });
});
