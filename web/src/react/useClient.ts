import { useEffect, useState } from "react";
import { SyncClient } from "../client";
import {
  HostHandle,
  IHostConnectionInfo,
  IStateManager,
  MasterSeed,
} from "../shared/types";
import type {
  IDiplomaticClientState,
  IDiplomaticClientXferState,
} from "../types";
import crypto from "../crypto";
import { entStateManager, IEntDB } from "../entdb/entdb";
import { openEntIDB } from "../entdb/idb";
import { nullStateManager } from "../state";
import { openIDBStore } from "../stores/idb/store";
import { Clock, IClock } from "../shared/clock";
import { hostHTTPTransport } from "../shared/http";

export function useClientState<Handle extends HostHandle>(
  client: SyncClient<Handle>,
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

export function useClientXferState<Handle extends HostHandle>(
  client: SyncClient<Handle>,
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

export function useSyncOnResume<Handle extends HostHandle>(
  client: SyncClient<Handle>,
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


  { clock = new Clock(), seed, host }: {
    clock?: IClock;
    seed?: MasterSeed;
    host?: IHostConnectionInfo<URL>;
  },
) {
  const [diplomaticState, setDiplomaticState] = useState<{
    client?: SyncClient<URL>;
    entDB?: IEntDB;
    stateMgr: IStateManager;
  }>({ stateMgr: nullStateManager });

  useEffect(() => {
    Promise.all([openIDBStore(crypto), openEntIDB()]).then(
      async ([store, entDB]) => {
        const entMgr = entStateManager(entDB);
        const client = new SyncClient(
          clock,
          entMgr,
          store,
          hostHTTPTransport,
          crypto,
        );
        if (seed) {
          await client.setSeed(seed);
        }
        if (host) {
          await client.link(host);
        }
        setDiplomaticState({ client, entDB, stateMgr: entMgr });
      },
    );
  }, [clock, seed]);
  return diplomaticState;
}
