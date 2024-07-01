import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import type { IDiplomaticClientParams } from "./client";
import type { DiplomaticClientState, IClientStateStore } from "./types";
// import { usePollingSync } from "./sync";
import { localStorageStore } from "./localStorageStore";
import type { StateManager } from "./state";
import type DiplomaticClient from "./client";

const initialState: DiplomaticClientState = "loading";
interface IClientHookParams extends Omit<IDiplomaticClientParams, "store"> {
  refreshInterval?: number;
  store?: IClientStateStore;
}

// export default function useClient(
//   store: IClientStateStore,
//   stateManager: StateManager,
//   seed?: string | Uint8Array,
//   hostURL?: string,
//   hostID?: string,
// ): [DiplomaticClient | undefined, DiplomaticClientState, () => void] {
//   const [state, setState] = useState<DiplomaticClientState>(initialState);
//   console.log("rendering useClient")
//   const clientRef = useRef(new DiplomaticClient({
//     store: localStorageStore,
//     stateManager: stateManager,
//     seed: seed,
//     hostURL: hostURL,
//     hostID: hostID,
//   }));
//   clientRef.current.listener = setState;
//   // const reset = useCallback(() => {
//   //   const c = new DiplomaticClient(fullParams);
//   //   c.listener = setState;
//   //   setClient(c);
//   //   setState(initialState);
//   // }, [fullParams]);
//   const reset = useCallback(() => null, []);
//   // usePollingSync(client, params.refreshInterval ?? 1000)
//   return [clientRef.current, state, reset];
// }

export function useClientState(client: DiplomaticClient) {
  const [state, setState] = useState<DiplomaticClientState>(initialState);
  useEffect(() => {
    setState(client.state);
    client.listener = setState;
  }, [client]);
  return state;
}
