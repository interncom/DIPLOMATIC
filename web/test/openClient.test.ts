import { afterEach, describe, expect, test, vi } from "vitest";
import crypto from "../src/crypto";
import {
  openDiplomaticClient,
  type OpenDiplomaticClientOptions,
} from "../src/openClient";
import { nullStateManager } from "../src/state";
import { Status } from "../src/shared/consts";
import { Enclave } from "../src/shared/crypto/enclave";
import { MemoryStore } from "../src/stores/memory/store";
import { spawnDiplomaticSyncWorker } from "../src/shared/worker/spawn";
import { WorkerClient } from "../src/worker/client";

vi.mock("../src/shared/worker/spawn", async (importOriginal) => {
  const orig = await importOriginal<
    typeof import("../src/shared/worker/spawn")
  >();
  return {
    ...orig,
    spawnDiplomaticSyncWorker: vi.fn(),
    postToDiplomaticWorker: (worker: Worker, data: unknown) => {
      worker.postMessage(data);
    },
  };
});

function mockWorker(): Worker {
  return {
    postMessage: vi.fn(),
    terminate: vi.fn(),
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: () => true,
  } as unknown as Worker;
}

/** Worker that acks RPC (setSeed, getXferState, …). */
function mockWorkerRpcOnly(): Worker {
  const w: {
    postMessage: (data: unknown) => void;
    terminate: ReturnType<typeof vi.fn>;
    onmessage: ((ev: MessageEvent<unknown>) => void) | null;
    onerror: ((ev: ErrorEvent) => void) | null;
    onmessageerror: ((ev: MessageEvent<unknown>) => void) | null;
    addEventListener: ReturnType<typeof vi.fn>;
    removeEventListener: ReturnType<typeof vi.fn>;
    dispatchEvent: () => boolean;
  } = {
    postMessage(data: unknown) {
      if (
        !data ||
        typeof data !== "object" ||
        !("op" in data) ||
        !("id" in data) ||
        typeof data.id !== "number"
      ) {
        return;
      }
      const id = data.id;
      const op = data.op;
      queueMicrotask(() => {
        const handler = w.onmessage;
        if (!handler) {
          return;
        }
        if (op === "ping") {
          handler({
            data: { kind: "reply", id, ok: true, result: "pong" },
          } as MessageEvent<unknown>);
          return;
        }
        if (op === "getXferState") {
          handler({
            data: {
              kind: "reply",
              id,
              ok: true,
              result: {
                numUploads: 0,
                numDownloads: 0,
                progress: {
                  phase: "idle",
                  startedAt: 0,
                  updatedAt: 0,
                },
              },
            },
          } as MessageEvent<unknown>);
          return;
        }
        handler({
          data: { kind: "reply", id, ok: true, result: undefined },
        } as MessageEvent<unknown>);
      });
    },
    terminate: vi.fn(),
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: () => true,
  };
  return w as unknown as Worker;
}

function enclaveOrThrow(): Enclave {
  const [enclave, st] = Enclave.fromBytes(new Uint8Array(32).fill(1));
  if (st !== Status.Success || enclave === undefined) {
    throw new Error(`enclave ${st}`);
  }
  return enclave;
}

describe("openDiplomaticClient", () => {
  test("main thread when no worker is configured (intentional)", async () => {
    const opened = await openDiplomaticClient({
      state: nullStateManager,
      store: new MemoryStore(crypto),
    });
    expect(opened.mode).toBe("main");
    opened.dispose();
  });

  test("throws when default store needs IndexedDB but it is missing", async () => {
    const prev = globalThis.indexedDB;
    // @ts-expect-error test override
    globalThis.indexedDB = undefined;
    try {
      await expect(
        openDiplomaticClient({
          state: nullStateManager,
        }),
      ).rejects.toThrow(/IndexedDB is unavailable/);
    } finally {
      globalThis.indexedDB = prev;
    }
  });

  test("throws when worker is paired with a custom store (runtime belt)", async () => {
    const bad = {
      state: nullStateManager,
      worker: true,
      store: new MemoryStore(crypto),
    } as unknown as OpenDiplomaticClientOptions;
    await expect(openDiplomaticClient(bad)).rejects.toThrow(
      /worker path requires IndexedDB/,
    );
  });

  test("throws when worker: true but Worker API missing", async () => {
    const prev = globalThis.Worker;
    // @ts-expect-error test override
    globalThis.Worker = undefined;
    try {
      await expect(
        openDiplomaticClient({
          state: nullStateManager,
          worker: true,
        }),
      ).rejects.toThrow(/Worker API is unavailable/);
    } finally {
      globalThis.Worker = prev;
    }
  });
});

describe("WorkerClient open / setSeed", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("open hydrates from store without spawning a worker", async () => {
    const store = new MemoryStore(crypto);
    const client = await WorkerClient.open(nullStateManager, store, {
      syncDebounceMs: 0,
    });
    try {
      const state = await client.clientState.get();
      expect(state.hasSeed).toBe(false);
      expect(state.hasHost).toBe(false);
      await expect(client.ping()).rejects.toThrow(/no sync worker/);
    } finally {
      client.terminate();
    }
  });

  test("setSeed times out when spawned worker never replies", async () => {
    const store = new MemoryStore(crypto);
    const w = mockWorker();
    vi.mocked(spawnDiplomaticSyncWorker).mockReturnValue(w);
    const client = await WorkerClient.open(nullStateManager, store, {
      readyTimeoutMs: 50,
      syncDebounceMs: 0,
    });
    try {
      await expect(client.setSeed(enclaveOrThrow())).rejects.toThrow(
        /setSeed worker timeout/,
      );
    } finally {
      client.terminate();
    }
  });

  test("setSeed binds Enclave-spawned worker; seed/host stay local", async () => {
    const store = new MemoryStore(crypto);
    const w = mockWorkerRpcOnly();
    vi.mocked(spawnDiplomaticSyncWorker).mockReturnValue(w);
    const client = await WorkerClient.open(nullStateManager, store, {
      syncDebounceMs: 0,
    });
    try {
      await client.setSeed(enclaveOrThrow());
      let state = await client.clientState.get();
      expect(state.hasSeed).toBe(true);
      expect(state.hasHost).toBe(false);
      expect(state.connected).toBe(false);
      await client.link({
        handle: new URL("http://localhost"),
        label: "host",
        idx: 0,
      }, false);
      state = await client.clientState.get();
      expect(state.hasHost).toBe(true);
      expect(state.hasSeed).toBe(true);
      await client.ping();
    } finally {
      client.terminate();
    }
  });

  test("connect and sync during setSeed wait until the worker adopts", async () => {
    const store = new MemoryStore(crypto);
    const ops: string[] = [];
    const waiting: (() => void)[] = [];
    const w: {
      postMessage: (data: unknown) => void;
      terminate: ReturnType<typeof vi.fn>;
      onmessage: ((ev: MessageEvent<unknown>) => void) | null;
      onerror: ((ev: ErrorEvent) => void) | null;
      onmessageerror: ((ev: MessageEvent<unknown>) => void) | null;
      addEventListener: ReturnType<typeof vi.fn>;
      removeEventListener: ReturnType<typeof vi.fn>;
      dispatchEvent: () => boolean;
    } = {
      postMessage(data: unknown) {
        if (!data || typeof data !== "object") return;
        if (!("op" in data) || !("id" in data)) return;
        if (typeof data.op !== "string" || typeof data.id !== "number") return;
        const id = data.id;
        const op = data.op;
        ops.push(op);
        const reply = () => {
          queueMicrotask(() => {
            const handler = w.onmessage;
            if (!handler) return;
            const result = op === "getXferState"
              ? {
                numUploads: 0,
                numDownloads: 0,
                progress: {
                  phase: "idle",
                  startedAt: 0,
                  updatedAt: 0,
                },
              }
              : undefined;
            handler({
              data: { kind: "reply", id, ok: true, result },
            } as MessageEvent<unknown>);
          });
        };
        if (op === "setSeed") {
          waiting.push(reply);
          return;
        }
        reply();
      },
      terminate: vi.fn(),
      onmessage: null,
      onerror: null,
      onmessageerror: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: () => true,
    };
    vi.mocked(spawnDiplomaticSyncWorker).mockReturnValue(
      w as unknown as Worker,
    );
    const client = await WorkerClient.open(nullStateManager, store, {
      syncDebounceMs: 0,
    });
    try {
      const setP = client.setSeed(enclaveOrThrow());
      for (let i = 0; i < 20 && !ops.includes("setSeed"); i++) {
        await new Promise((r) => setTimeout(r, 0));
      }
      expect(ops).toEqual(["setSeed"]);
      let syncDone = false;
      const connectP = client.connect();
      const syncP = client.sync().then((st) => {
        syncDone = true;
        return st;
      });
      await new Promise((r) => setTimeout(r, 0));
      expect(syncDone).toBe(false);
      expect(ops).toEqual(["setSeed"]);
      const queued = waiting.splice(0);
      for (const reply of queued) reply();
      await setP;
      await connectP;
      expect(await syncP).toBe(Status.Success);
      expect(ops).toEqual(["setSeed", "getXferState", "connect", "sync"]);
    } finally {
      client.terminate();
    }
  });

  test("worker connected events do not clear hasSeed", async () => {
    const store = new MemoryStore(crypto);
    const w = mockWorkerRpcOnly();
    vi.mocked(spawnDiplomaticSyncWorker).mockReturnValue(w);
    const client = await WorkerClient.open(nullStateManager, store, {
      syncDebounceMs: 0,
    });
    const seen: boolean[] = [];
    const stop = client.clientState.listen((s) => {
      seen.push(s.hasSeed);
    });
    try {
      await client.setSeed(enclaveOrThrow());
      const handler = w.onmessage;
      if (handler) {
        handler({
          data: {
            kind: "clientState",
            connected: true,
            connectedHosts: ["host"],
          },
        } as MessageEvent<unknown>);
      }
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((v) => v === true)).toBe(true);
      const state = await client.clientState.get();
      expect(state.hasSeed).toBe(true);
      expect(state.connected).toBe(true);
      expect(state.connectedHosts).toEqual(["host"]);
      if (handler) {
        handler({
          data: {
            kind: "clientState",
            connected: true,
            connectedHosts: ["host", "other"],
          },
        } as MessageEvent<unknown>);
      }
      expect((await client.clientState.get()).connectedHosts).toEqual([
        "host",
        "other",
      ]);
    } finally {
      stop();
      client.terminate();
    }
  });
});
