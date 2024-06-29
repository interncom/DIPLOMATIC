import { useState, useEffect, useCallback, useMemo } from "react";
import DiplomaticClient, { type IDiplomaticClientParams } from "./client";
import type { DiplomaticClientState, IClientStateStore } from "./types";
import { usePollingSync } from "./sync";
import { localStorageStore } from "./localStorageStore";

const initialState: DiplomaticClientState = "loading";
interface IClientHookParams extends Omit<IDiplomaticClientParams, "store"> {
  refreshInterval?: number;
  store?: IClientStateStore;
}

export default function useClient(params: IClientHookParams): [DiplomaticClient, DiplomaticClientState, () => void] {
  const [state, setState] = useState<DiplomaticClientState>(initialState);
  console.log("rendering useClient")
  const fullParams = useMemo(() => ({ store: localStorageStore, ...params }),
    [params],
  );
  const [client, setClient] = useState(new DiplomaticClient(fullParams));
  useEffect(() => {
    client.listener = setState;
  }, [client]);
  const reset = useCallback(() => {
    setClient(new DiplomaticClient(fullParams));
    setState(initialState);
  }, [fullParams]);
  usePollingSync(client, params.refreshInterval ?? 1000)
  return [client, state, reset];
}
