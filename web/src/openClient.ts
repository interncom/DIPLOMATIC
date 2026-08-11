// Open a browser IClient.
//
// - `worker: true` → worker-mode façade (main local writes + IDB). Sync Worker
//   is created only on setSeed via Enclave.spawnSyncWorker.
// - Omit worker → SyncClient on the page (explicit, not a silent fallback).
// Worker failures throw; we never quietly degrade to main.
//
// With a worker: main owns local msg write + apply (shared message IDB + EntDB
// for UI). Worker owns network sync and also writes EntDB; it only posts
// dirty/wiped signals across the boundary.

import { SyncClient } from "./client";
import crypto from "./crypto";
import { Clock, IClock } from "./shared/clock";
import { hostHTTPTransport } from "./shared/http";
import type { IStateManager } from "./shared/types";
import { openIDBStore } from "./stores/idb/store";
import type { IClient, IStore } from "./types";
import { WorkerClient } from "./worker/client";

type OpenDiplomaticClientBase = {
  state: IStateManager;
  clock?: IClock;
  /** Max wait for setSeed → Enclave.spawnSyncWorker handshake (default 15s). */
  readyTimeoutMs?: number;
  /**
   * Debounce local write → worker sync (default `defaultSyncDebounceMs`).
   * Use `0` in tests for an immediate upload-queue handoff.
   */
  syncDebounceMs?: number;
};

/**
 * Worker path: protocol sync off the main thread after setSeed. Main and worker
 * both use IndexedDB. Custom `store` is forbidden (worker always opens IDB).
 *
 * No worker is spawned at open. Only {@link Enclave.spawnSyncWorker} (from
 * setSeed) creates a worker and injects seed.
 *
 * CSP: allow `worker-src blob:` (or `script-src blob:`) if you use a strict CSP.
 */
export type OpenDiplomaticClientWorkerOptions = OpenDiplomaticClientBase & {
  /** Request a library-managed sync worker. */
  worker: true;
  store?: never;
};

/**
 * Main-thread path: SyncClient on the page. Optional custom store; default is
 * IndexedDB.
 */
export type OpenDiplomaticClientMainOptions = OpenDiplomaticClientBase & {
  worker?: undefined | false;
  /**
   * Protocol message store. Default: IndexedDB (`openIDBStore`).
   * Pass explicitly for non-IDB backends (e.g. `new MemoryStore(crypto)`).
   * Incompatible with `worker: true`.
   */
  store?: IStore<URL>;
};

export type OpenDiplomaticClientOptions =
  | OpenDiplomaticClientWorkerOptions
  | OpenDiplomaticClientMainOptions;

export type OpenedDiplomaticClient = {
  client: IClient<URL>;
  /** Where protocol sync is running. */
  mode: "worker" | "main";
  /** Tear down worker or disconnect main client. */
  dispose: () => void;
};

const logPrefix = "[DIPLOMATIC]";

/**
 * Open a browser client.
 *
 * - **Worker path:** `worker: true` — façade ready; Worker appears on setSeed.
 * - **Main path:** omit `worker` → SyncClient on the page; optional `store`.
 */
export async function openDiplomaticClient(
  opts: OpenDiplomaticClientOptions,
): Promise<OpenedDiplomaticClient> {
  const clock = opts.clock ?? new Clock();

  if (opts.worker === true && customStore(opts) !== undefined) {
    throw new Error(
      `${logPrefix} worker path requires IndexedDB on both sides; ` +
        `do not pass store (got a custom store)`,
    );
  }

  if (opts.worker !== true) {
    console.info(
      `${logPrefix} sync on main thread ` +
        `(no worker — app did not request a worker)`,
    );
    const store = await resolveStore(opts.store);
    return openMain(clock, opts.state, store);
  }

  if (typeof Worker === "undefined") {
    throw new Error(
      `${logPrefix} worker: true but Worker API is unavailable`,
    );
  }

  const store = await resolveStore(undefined);
  // No Worker yet — Enclave.spawnSyncWorker runs inside client.setSeed.
  const workerClient = await WorkerClient.open(opts.state, store, {
    readyTimeoutMs: opts.readyTimeoutMs,
    clock,
    syncDebounceMs: opts.syncDebounceMs,
  });
  console.info(
    `${logPrefix} worker-mode client open ` +
      `(sync Worker starts on setSeed via Enclave)`,
  );
  return {
    client: workerClient,
    mode: "worker",
    dispose: () => {
      console.info(`${logPrefix} terminating sync worker`);
      workerClient.terminate();
    },
  };
}

/** Custom store if present (main path only; worker path forbids it). */
function customStore(
  opts: OpenDiplomaticClientOptions,
): IStore<URL> | undefined {
  if ("store" in opts) {
    return opts.store;
  }
  return undefined;
}

async function openMain(
  clock: IClock,
  state: IStateManager,
  store: IStore<URL>,
): Promise<OpenedDiplomaticClient> {
  const main = new SyncClient(
    clock,
    state,
    store,
    hostHTTPTransport,
    crypto,
  );
  return {
    client: main,
    mode: "main",
    dispose: () => {
      void main.disconnect();
    },
  };
}

/**
 * Default store is IndexedDB. Non-IDB backends must be passed in explicitly —
 * we never silently fall back to an in-memory store.
 */
async function resolveStore(
  store: IStore<URL> | undefined,
): Promise<IStore<URL>> {
  if (store !== undefined) {
    return store;
  }
  if (typeof indexedDB === "undefined") {
    throw new Error(
      `${logPrefix} IndexedDB is unavailable; pass store explicitly ` +
        `(e.g. new MemoryStore(crypto))`,
    );
  }
  return openIDBStore(crypto);
}
