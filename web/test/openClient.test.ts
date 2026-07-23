import { describe, expect, test, vi } from "vitest";
import crypto from "../src/crypto";
import {
  openDiplomaticClient,
  type OpenDiplomaticClientOptions,
} from "../src/openClient";
import { nullStateManager } from "../src/state";
import { Status } from "../src/shared/consts";
import { MemoryStore } from "../src/stores/memory/store";

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

/**
 * Worker that answers RPC but posts no unsolicited `ready` / `clientState`.
 * Simulates early Worker construction where those events were dropped before
 * `onmessage` was attached.
 */
function mockWorkerRpcOnly(opts?: {
  hasSeed?: boolean;
  hasHost?: boolean;
  connected?: boolean;
}): Worker {
  const hasSeed = opts?.hasSeed ?? false;
  const hasHost = opts?.hasHost ?? false;
  const connected = opts?.connected ?? false;
  const w: {
    postMessage: (data: unknown) => void;
    terminate: ReturnType<typeof vi.fn>;
    onmessage: ((ev: MessageEvent<unknown>) => void) | null;
    onerror: ((ev: ErrorEvent) => void) | null;
    onmessageerror: ((ev: MessageEvent) => void) | null;
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
        if (op === "getClientState") {
          handler({
            data: {
              kind: "reply",
              id,
              ok: true,
              result: { hasSeed, hasHost, connected },
            },
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
                progress: { phase: "idle" },
              },
            },
          } as MessageEvent<unknown>);
        }
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
    // Type system rejects this; cast exercises the runtime guard for JS callers.
    const bad = {
      state: nullStateManager,
      worker: mockWorker(),
      store: new MemoryStore(crypto),
    } as unknown as OpenDiplomaticClientOptions;
    await expect(openDiplomaticClient(bad)).rejects.toThrow(
      /worker path requires IndexedDB/,
    );
  });

  test("throws when worker given but Worker API missing", async () => {
    const prev = globalThis.Worker;
    // @ts-expect-error test override
    globalThis.Worker = undefined;
    try {
      await expect(
        openDiplomaticClient({
          state: nullStateManager,
          worker: mockWorker(),
        }),
      ).rejects.toThrow(/Worker API is unavailable/);
    } finally {
      globalThis.Worker = prev;
    }
  });

  test("throws when worker never becomes ready (no silent fallback)", async () => {
    if (typeof indexedDB === "undefined") {
      // Worker path always opens IDB; without it we fail earlier (covered above).
      return;
    }
    if (typeof Worker === "undefined") {
      // @ts-expect-error minimal stub
      globalThis.Worker = class {};
    }
    await expect(
      openDiplomaticClient({
        state: {
          apply: async (msgs) => msgs.map(() => Status.Success),
          clear: async () => Status.Success,
          notify() {},
          on() {},
          off() {},
        },
        readyTimeoutMs: 50,
        worker: mockWorker(),
      }),
    ).rejects.toThrow(/ready timeout/);
  });

  test("connects when ready was missed but probe ping replies", async () => {
    if (typeof indexedDB === "undefined") {
      return;
    }
    if (typeof Worker === "undefined") {
      // @ts-expect-error minimal stub
      globalThis.Worker = class {};
    }
    const opened = await openDiplomaticClient({
      state: {
        apply: async (msgs) => msgs.map(() => Status.Success),
        clear: async () => Status.Success,
        notify() {},
        on() {},
        off() {},
      },
      readyTimeoutMs: 2_000,
      worker: mockWorkerRpcOnly(),
    });
    expect(opened.mode).toBe("worker");
    opened.dispose();
  });

  test("hydrates hasSeed after missed ready/clientState events", async () => {
    if (typeof indexedDB === "undefined") {
      return;
    }
    if (typeof Worker === "undefined") {
      // @ts-expect-error minimal stub
      globalThis.Worker = class {};
    }
    // Worker reports seed present via getClientState only (no unsolicited push).
    // Without post-ready hydration, clientState would stay hasSeed:false and
    // authenticated apps would flash the init UI.
    const opened = await openDiplomaticClient({
      state: {
        apply: async (msgs) => msgs.map(() => Status.Success),
        clear: async () => Status.Success,
        notify() {},
        on() {},
        off() {},
      },
      readyTimeoutMs: 2_000,
      worker: mockWorkerRpcOnly({ hasSeed: true, hasHost: true }),
    });
    expect(opened.mode).toBe("worker");
    const state = await opened.client.clientState.get();
    expect(state.hasSeed).toBe(true);
    expect(state.hasHost).toBe(true);
    opened.dispose();
  });
});
