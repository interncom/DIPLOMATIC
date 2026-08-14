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
import { WorkerClient } from "../src/worker/client";

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
    vi.spyOn(Enclave.prototype, "spawnSyncWorker").mockReturnValue(w);
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
    vi.spyOn(Enclave.prototype, "spawnSyncWorker").mockImplementation(
      (opts) => {
        queueMicrotask(() => {
          const handler = w.onmessage;
          if (!handler) return;
          handler({
            data: {
              kind: "reply",
              id: opts.id,
              ok: true,
              result: undefined,
            },
          } as MessageEvent<unknown>);
        });
        return w;
      },
    );
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

  test("worker connected events do not clear hasSeed", async () => {
    const store = new MemoryStore(crypto);
    const w = mockWorkerRpcOnly();
    vi.spyOn(Enclave.prototype, "spawnSyncWorker").mockImplementation(
      (opts) => {
        queueMicrotask(() => {
          const handler = w.onmessage;
          if (!handler) return;
          handler({
            data: { kind: "clientState", connected: false },
          } as MessageEvent<unknown>);
          handler({
            data: {
              kind: "reply",
              id: opts.id,
              ok: true,
              result: undefined,
            },
          } as MessageEvent<unknown>);
        });
        return w;
      },
    );
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
          data: { kind: "clientState", connected: true },
        } as MessageEvent<unknown>);
      }
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((v) => v === true)).toBe(true);
      const state = await client.clientState.get();
      expect(state.hasSeed).toBe(true);
      expect(state.connected).toBe(true);
    } finally {
      stop();
      client.terminate();
    }
  });
});
