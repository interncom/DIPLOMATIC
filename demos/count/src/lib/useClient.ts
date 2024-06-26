import { useState, useEffect, useCallback } from "react";
import DiplomaticClient, { type IDiplomaticClientParams } from "./client";
import type { Applier, DiplomaticClientState, IClientStateStore } from "./types";
import { usePollingSync } from "./sync";

const initialState: DiplomaticClientState = "loading";
interface IClientHookParams extends IDiplomaticClientParams {
  refreshInterval?: number;
}

export default function useClient(params: IClientHookParams): [DiplomaticClient, DiplomaticClientState, () => void] {
  const [state, setState] = useState<DiplomaticClientState>(initialState);
  const [client, setClient] = useState(new DiplomaticClient(params));
  useEffect(() => {
    client.listener = setState;
  }, [client]);
  const reset = useCallback(() => {
    setClient(new DiplomaticClient(params));
    setState(initialState);
  }, [params]);
  usePollingSync(client, params.refreshInterval ?? -1)
  return [client, state, reset];
}
