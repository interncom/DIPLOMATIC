import { useState, useEffect, useCallback } from "react";
import DiplomaticClient, { type IDiplomaticClientParams } from "./client";
import type { DiplomaticClientState, IClientStateStore } from "./types";
import { usePollingSync } from "./sync";
import { localStorageStore } from "./localStorageStore";

const initialState: DiplomaticClientState = "loading";
interface IClientHookParams extends IDiplomaticClientParams {
  refreshInterval?: number;
  store?: IClientStateStore;
}

export default function useClient(params: IClientHookParams): [DiplomaticClient, DiplomaticClientState, () => void] {
  const [state, setState] = useState<DiplomaticClientState>(initialState);
  const [client, setClient] = useState(new DiplomaticClient({ store: localStorageStore, ...params }));
  useEffect(() => {
    client.listener = setState;
  }, [client]);
  const reset = useCallback(() => {
    setClient(new DiplomaticClient(params));
    setState(initialState);
  }, [params]);
  usePollingSync(client, params.refreshInterval ?? 1000)
  return [client, state, reset];
}
