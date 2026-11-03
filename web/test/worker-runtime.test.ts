// Connect waits until the worker adopts the seed.

import { describe, expect, test, vi } from "vitest";
import { WorkerRuntime } from "../src/worker/runtime";

const gate = vi.hoisted(() => {
  const log: string[] = [];
  let release: (() => void) | undefined;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    log,
    hold,
    release() {
      const go = release;
      release = undefined;
      if (go) go();
    },
  };
});

vi.mock("../src/stores/idb/store", () => ({
  IDBStore: class IDBStore {},
  openBoundStore: async () => ({
    async bind() {
      gate.log.push("bind");
      await gate.hold;
      gate.log.push("bound");
      return 0;
    },
    hosts: {
      async list() {
        gate.log.push("hosts");
        return [];
      },
    },
    realms: {
      async list() {
        gate.log.push("realms");
        return [];
      },
    },
    messages: {
      async list() {
        gate.log.push("msgs");
        return [];
      },
    },
    uploads: {
      async count() {
        return 0;
      },
    },
    downloads: {
      async count() {
        return 0;
      },
    },
  }),
}));

vi.mock("../src/entdb/cached", () => ({
  openEntDB: async () => ({
    apply: async () => ({ stats: [], types: [], eids: [] }),
    clear: async () => 0,
  }),
}));

describe("WorkerRuntime seed gate", () => {
  test("connect does not run until setSeed adopts", async () => {
    const runtime = new WorkerRuntime(() => {});
    await runtime.handle({
      id: 0,
      op: "bind",
      label: "",
      data: "data",
      ents: "ents",
    });
    const setP = runtime.handle({
      id: 1,
      op: "setSeed",
      seed: new Uint8Array(32).fill(7),
    });
    const connP = runtime.handle({
      id: 2,
      op: "connect",
      listen: false,
      sync: false,
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(gate.log).toContain("bind");
    expect(gate.log).not.toContain("msgs");
    gate.release();
    await setP;
    await connP;
    const boundAt = gate.log.indexOf("bound");
    const msgsAt = gate.log.indexOf("msgs");
    expect(boundAt).toBeGreaterThanOrEqual(0);
    expect(msgsAt).toBeGreaterThan(boundAt);
  });
});
