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
});
