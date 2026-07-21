// Open a browser IClient.
//
// App-owned worker model:
// - Pass `worker` → protocol sync runs in that Worker instance.
// - Omit `worker` → SyncClient on the page (explicit, not a silent fallback).
// Worker failures throw; we never quietly degrade to main.
//
// With a worker: main owns local msg write + apply (shared message IDB + EntDB
// read/write for UI). Worker owns network sync and also writes EntDB; it only
// posts dirty/wiped signals across the boundary.

import { SyncClient } from "./client";
import crypto from "./crypto";
import { Clock, IClock } from "./shared/clock";
import { hostHTTPTransport } from "./shared/http";
import type { IStateManager } from "./shared/types";
import { openIDBStore } from "./stores/idb/store";
import type { IClient, IStore } from "./types";
import { WorkerClient } from "./worker/client";

/**
 * How to construct the Worker you pass to {@link openDiplomaticClient} /
 * {@link WorkerClient.connect} / `useClient`.
 *
 * The library accepts only a live `Worker` instance. Instantiation is bundler-
 * and hosting-specific — the app owns that step so DIPLOMATIC never guesses a
 * script URL that would 404 under a different tool.
 *
 * The worker entry is the package export `@interncom/diplomatic/worker`
 * (built as `worker.mjs` in the published package). It must run as a
 * **module** worker (`type: "module"`).
 *
 * ## Vite (recommended for SPA templates)
 *
 * ```ts
 * import DiplomaticWorker from "@interncom/diplomatic/worker?worker";
 * const worker = new DiplomaticWorker();
 * await openDiplomaticClient({ state, worker });
 * ```
 *
 * `?worker` makes Vite emit a real worker asset and a constructor. Create the
 * instance once (module scope or `useMemo`/`useRef`) — not on every render.
 *
 * ## webpack / Rollup / esbuild / Parcel (`new URL` + import.meta.url)
 *
 * Point at the package worker file so the bundler copies it next to the app:
 *
 * ```ts
 * const worker = new Worker(
 *   new URL("@interncom/diplomatic/worker", import.meta.url),
 *   { type: "module" },
 * );
 * ```
 *
 * If the package path does not resolve, import the built file explicitly:
 *
 * ```ts
 * const worker = new Worker(
 *   new URL(
 *     "../node_modules/@interncom/diplomatic/dist/worker.mjs",
 *     import.meta.url,
 *   ),
 *   { type: "module" },
 * );
 * ```
 *
 * (Exact relative path depends on your app layout; prefer the package export
 * when your bundler supports it.)
 *
 * ## Plain HTML / CDN / static hosting (no bundler)
 *
 * Host `worker.mjs` (from the package `dist/`) as a same-origin static asset,
 * then:
 *
 * ```html
 * <script type="module">
 *   import { openDiplomaticClient } from "https://cdn.example/diplomatic.js";
 *   const worker = new Worker("/path/to/worker.mjs", { type: "module" });
 *   const { client } = await openDiplomaticClient({ state, worker });
 * </script>
 * ```
 *
 * The worker script must be **same-origin** (or CORS-enabled for classic
 * workers; module workers generally need same-origin). Do not invent a path
 * into `node_modules` from the browser — copy or serve the built file.
 *
 * ## React (`useClient`)
 *
 * Same rules: build the Worker once, pass the instance:
 *
 * ```ts
 * import DiplomaticWorker from "@interncom/diplomatic/worker?worker";
 * const syncWorker = new DiplomaticWorker(); // module scope
 * useClient({ seed, host, worker: syncWorker });
 * ```
 *
 * ## Lifecycle
 *
 * Workers die with the page (tab close / full navigation). Mid-session death
 * is rare; if you recreate a Worker yourself, open a new client against it.
 * `dispose` / `WorkerClient.terminate` stops the worker DIPLOMATIC is using.
 */
type OpenDiplomaticClientBase = {
  state: IStateManager;
  clock?: IClock;
  /** Max wait for worker ready when using a worker (default 15s). */
  readyTimeoutMs?: number;
  /**
   * Debounce local write → worker sync (default `defaultSyncDebounceMs`).
   * Use `0` in tests for an immediate upload-queue handoff.
   */
  syncDebounceMs?: number;
};

/**
 * Worker path: protocol sync off the main thread. Main and worker both use
 * IndexedDB (shared durable state). A custom `store` is a type error and a
 * runtime error — the worker always opens IDB, so a MemoryStore (etc.) on
 * main would silently diverge.
 */
export type OpenDiplomaticClientWorkerOptions = OpenDiplomaticClientBase & {
  /**
   * App-constructed sync Worker (see module docs above for how to create it).
   * Misconfiguration or ready timeout throws — no silent main-thread fallback.
   */
  worker: Worker;
  store?: never;
};

/**
 * Main-thread path: SyncClient on the page. Optional custom store; default is
 * IndexedDB. No automatic memory fallback when IndexedDB is missing.
 */
export type OpenDiplomaticClientMainOptions = OpenDiplomaticClientBase & {
  worker?: undefined;
  /**
   * Protocol message store. Default: IndexedDB (`openIDBStore`).
   * Pass explicitly for non-IDB backends (e.g. `new MemoryStore(crypto)`).
   * Incompatible with `worker` (see {@link OpenDiplomaticClientWorkerOptions}).
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
 * - **Worker path:** pass `worker` (already constructed). Always IndexedDB.
 * - **Main path:** omit `worker` → SyncClient on the page; optional `store`.
 *
 * See {@link OpenDiplomaticClientOptions} for Worker instantiation recipes.
 */
export async function openDiplomaticClient(
  opts: OpenDiplomaticClientOptions,
): Promise<OpenedDiplomaticClient> {
  const clock = opts.clock ?? new Clock();

  // Belt for JS / type-cast callers: worker always shares IDB with the runtime.
  if (opts.worker !== undefined && customStore(opts) !== undefined) {
    throw new Error(
      `${logPrefix} worker path requires IndexedDB on both sides; ` +
        `do not pass store (got a custom store)`,
    );
  }

  if (opts.worker === undefined) {
    console.info(
      `${logPrefix} sync on main thread ` +
        `(no worker — app did not request a worker)`,
    );
    const store = await resolveStore(opts.store);
    return openMain(clock, opts.state, store);
  }

  if (typeof Worker === "undefined") {
    throw new Error(
      `${logPrefix} worker was provided but Worker API is unavailable`,
    );
  }

  const store = await resolveStore(undefined);
  console.info(`${logPrefix} attaching app-provided sync worker…`);
  const workerClient = await WorkerClient.connect(opts.state, store, {
    worker: opts.worker,
    readyTimeoutMs: opts.readyTimeoutMs,
    clock,
    syncDebounceMs: opts.syncDebounceMs,
  });
  await workerClient.ping();
  console.info(
    `${logPrefix} sync worker active ` +
      `(network + EntDB writes off main; local mutates on main; dirty signals only)`,
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
