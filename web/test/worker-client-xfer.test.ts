import { describe, expect, test, vi } from "vitest";
import { WorkerClient } from "../src/worker/client";
import { MemoryStore } from "../src/stores/memory/store";
import libsodiumCrypto from "../src/crypto";
import type { MasterSeed } from "../src/shared/seed";
import type { IHostConnectionInfo, IStateManager } from "../src/shared/types";
import { Status } from "../src/shared/consts";
import { EncodedMessage } from "../src/shared/message";

/**
 * Worker that answers RPC but never posts unsolicited xferState.
 * Models offline: sync may be requested, but queue updates only come from
 * main-thread local apply — which is the path under test.
 */
function mockWorkerRpcOnly(): Worker {
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
        if (!handler) return;
        if (op === "ping") {
          handler({
            data: { kind: "reply", id, ok: true, result: "pong" } } as MessageEvent<unknown>);
          return;
        }
        if (op === "getClientState") {
          handler({
            data: {
              kind: "reply",
              id,
              ok: true,
              result: {
                hasSeed: true,
                hasHost: true,
                connected: false } } } as MessageEvent<unknown>);
          return;
        }
        if (op === "getXferState") {
          // Stale worker snapshot (offline / events dropped): still 0.
          handler({
            data: {
              kind: "reply",
              id,
              ok: true,
              result: {
                numUploads: 0,
                numDownloads: 0,
                progress: { phase: "idle" } } } } as MessageEvent<unknown>);
          return;
        }
        // link / setSeed / sync / etc. — ack without posting xferState
        handler({
          data: { kind: "reply", id, ok: true, result: Status.Success } } as MessageEvent<unknown>);
      });
    },
    terminate: vi.fn(),
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: () => true };
  return w as unknown as Worker;
}

function waitFor(
  pred: () => boolean | Promise<boolean>,
  timeoutMs = 2000,
): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        if (await pred()) {
          resolve();
          return;
        }
      } catch (e) {
        reject(e);
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error("waitFor timeout"));
        return;
      }
      queueMicrotask(tick);
    };
    void tick();
  });
}

describe("WorkerClient xferState", () => {
  test("local offline write updates numUploads without worker xfer events", async () => {
    const store = new MemoryStore<URL>(libsodiumCrypto);
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
      off() {} };

    const client = await WorkerClient.connect(state, store, {
      worker: mockWorkerRpcOnly(),
      syncDebounceMs: 0 });

    try {
      const seed = new Uint8Array(32).fill(1) as MasterSeed;
      await client.setSeed(seed);
      const host: IHostConnectionInfo<URL> = {
        handle: new URL("http://localhost"),
        label: "host",
        idx: 0 };
      // connect=false so we only link in shared store (worker still gets RPC).
      await client.link(host, false);

      const before = await client.xferState.get();
      expect(before.numUploads).toBe(0);

      let heard = 0;
      const unlisten = client.xferState.listen(() => {
        heard += 1;
      });

      const body: EncodedMessage = new Uint8Array([1, 2, 3]);
      const [, st] = await client.insertRaw(body);
      expect(st).toBe(Status.Success);

      // Shared store has the upload immediately after local apply.
      expect(await store.uploads.count()).toBe(1);

      // Façade must surface it even though the worker never posted xferState
      // (the offline / failed-peek case that previously left Sync UI at 0).
      await waitFor(async () => {
        const xfer = await client.xferState.get();
        return xfer.numUploads === 1;
      });
      expect(heard).toBeGreaterThan(0);

      const after = await client.xferState.get();
      expect(after.numUploads).toBe(1);
      expect(after.numDownloads).toBe(0);
      // Local enqueue must not clobber worker progress channel defaults.
      expect(after.progress).toEqual({ phase: "idle" });

      unlisten();
    } finally {
      client.terminate();
    }
  });
});
