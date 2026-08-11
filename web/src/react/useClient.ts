import { useEffect, useState } from "react";
import { openEntDB } from "../entdb/cached";
import { entStateManager, IEntDB } from "../entdb/entdb";
import { openDiplomaticClient } from "../openClient";
import { Clock, IClock } from "../shared/clock";
import type { Enclave } from "../shared/crypto/enclave";
import { IHostConnectionInfo, IStateManager } from "../shared/types";
import { nullStateManager } from "../state";
import type {
  IClient,
  IDiplomaticClientState,
  IDiplomaticClientXferState,
  IStore,
} from "../types";

export function useClientState(
  client: Pick<IClient<URL>, "clientState">,
) {
  const [state, setState] = useState<IDiplomaticClientState>();
  useEffect(() => {
    async function updateState() {
      const state = await client.clientState.get();
      setState(state);
    }
    const unsubscribe = client.clientState.listen(updateState);
    updateState();
    return () => {
      unsubscribe();
    };
  }, [client]);
  return state;
}

export function useClientXferState(
  client: Pick<IClient<URL>, "xferState">,
) {
  const [state, setState] = useState<IDiplomaticClientXferState>();
  useEffect(() => {
    async function updateState() {
      const state = await client.xferState.get();
      setState(state);
    }
    const unsubscribe = client.xferState.listen(updateState);
    updateState();
    return () => {
      unsubscribe();
    };
  }, [client]);
  return state;
}

export function useSyncOnResume(
  client: Pick<IClient<URL>, "connect" | "sync">,
) {
  useEffect(() => {
    async function reconnectAndSync() {
      try {
        await client.connect();
        await client.sync();
      } catch (err) {
        console.error("reconnectAndSync failed", err);
      }
    }

    function handleOnline() {
      reconnectAndSync();
    }

    function handleVisibilityChange() {
      if (
        typeof document !== "undefined" &&
        document.visibilityState === "visible"
      ) {
        reconnectAndSync();
      }
    }

    function handleFocus() {
      reconnectAndSync();
    }

    globalThis.addEventListener("online", handleOnline);
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", handleVisibilityChange);
    }
    globalThis.addEventListener("focus", handleFocus);
    globalThis.addEventListener("pageshow", handleFocus);

    return () => {
      globalThis.removeEventListener("online", handleOnline);
      if (typeof document !== "undefined") {
        document.removeEventListener(
          "visibilitychange",
          handleVisibilityChange,
        );
      }
      globalThis.removeEventListener("focus", handleFocus);
      globalThis.removeEventListener("pageshow", handleFocus);
    };
  }, [client]);
}

type UseClientBase = {
  clock?: IClock;
  /** Session enclave (master seed stays inside Enclave). */
  seed?: Enclave;
  host?: IHostConnectionInfo<URL>;
  readyTimeoutMs?: number;
};

/**
 * Worker path: IndexedDB on main; sync Worker appears on setSeed via Enclave.
 * Custom `store` is forbidden so durable state cannot diverge.
 *
 * ```ts
 * useClient({ worker: true, seed, host });
 * ```
 */
export type UseClientWorkerOptions = UseClientBase & {
  /** Worker-mode client; Enclave.spawnSyncWorker runs inside setSeed. */
  worker: true;
  store?: never;
};

/**
 * Main-thread path. Optional custom store; default IndexedDB.
 */
export type UseClientMainOptions = UseClientBase & {
  worker?: undefined | false;
  /**
   * Protocol store override. Default: IndexedDB. Pass explicitly for
   * MemoryStore or other backends. Incompatible with `worker: true`.
   */
  store?: IStore<URL>;
};

export type UseClientOptions = UseClientWorkerOptions | UseClientMainOptions;

export function useClient(opts: UseClientOptions = {}) {
  const clock = opts.clock ?? new Clock();
  const { seed, host, readyTimeoutMs } = opts;
  const useWorker = opts.worker === true;
  const store = "store" in opts ? opts.store : undefined;

  const [diplomaticState, setDiplomaticState] = useState<{
    client?: IClient<URL>;
    entDB?: IEntDB;
    stateMgr: IStateManager;
    mode?: "worker" | "main";
    /** Set when open/init fails (e.g. misconfigured worker). */
    error?: Error;
  }>({ stateMgr: nullStateManager });

  useEffect(() => {
    let cancelled = false;
    let dispose: (() => void) | undefined;

    (async () => {
      const entDB = await openEntDB();
      if (cancelled) return;
      const entMgr = entStateManager(entDB);

      // Narrow so worker+store cannot be passed together (mirrors options union).
      const opened = useWorker
        ? await openDiplomaticClient({
          state: entMgr,
          clock,
          worker: true,
          readyTimeoutMs,
        })
        : await openDiplomaticClient({
          state: entMgr,
          clock,
          store,
          readyTimeoutMs,
        });
      if (cancelled) {
        opened.dispose();
        return;
      }
      dispose = opened.dispose;
      const { client, mode } = opened;

      if (seed) {
        await client.setSeed(seed);
      }
      if (host) {
        await client.link(host);
      }
      if (cancelled) {
        dispose();
        return;
      }
      setDiplomaticState({
        client,
        entDB,
        stateMgr: entMgr,
        mode,
        error: undefined,
      });
    })().catch((err) => {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error("[DIPLOMATIC] useClient init failed", error);
      if (!cancelled) {
        setDiplomaticState((prev) => ({
          ...prev,
          client: undefined,
          error,
        }));
      }
    });

    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [clock, seed, host, useWorker, store, readyTimeoutMs]);

  return diplomaticState;
}
