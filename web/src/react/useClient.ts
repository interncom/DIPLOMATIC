import { useEffect, useState } from "react";
import { SyncClient } from "../client";
import { HostHandle, IHostConnectionInfo, MasterSeed } from "../shared/types";
import type {
  IDiplomaticClientState,
  IDiplomaticClientXferState,
  IStateManager,
} from "../types";
import libsodiumCrypto from "../crypto";
import { entStateManager } from "../entdb/entdb";
import { EntIDB, openEntIDB } from "../entdb/idb";
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
    async function handleOnline() {
      await client.connect();
      await client.sync();
    }
    globalThis.addEventListener("online", handleOnline);
    return () => {
      globalThis.removeEventListener("online", handleOnline);
    };
  }, [client]);
}

export function useClient(
  { clock = new Clock(), seed, host }: {
    clock?: IClock;
    seed?: MasterSeed;
    host?: IHostConnectionInfo<URL>;
  },
) {
  const [diplomaticState, setDiplomaticState] = useState<{
    client?: SyncClient<URL>;
    entDB?: EntIDB;
    stateMgr: IStateManager;
  }>({ stateMgr: nullStateManager });

  useEffect(() => {
    Promise.all([openIDBStore(libsodiumCrypto), openEntIDB()]).then(
      async ([store, entDB]) => {
        const entMgr = entStateManager(entDB);
        const client = new SyncClient(clock, entMgr, store, hostHTTPTransport);
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
