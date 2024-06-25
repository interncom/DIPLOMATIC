import { useState, useEffect, useCallback } from "react";
import DiplomaticClient from "./client";
import type { Applier, DiplomaticClientState, IClientStateStore } from "./types";

const initialState: DiplomaticClientState = "loading";

export default function useClient(store: IClientStateStore, applier: Applier): [DiplomaticClient, DiplomaticClientState, () => void] {
  const [state, setState] = useState<DiplomaticClientState>(initialState);
  const [client, setClient] = useState(new DiplomaticClient(store, applier));
  useEffect(() => {
    client.listener = setState;
  }, [client]);
  const reset = useCallback(() => {
    setClient(new DiplomaticClient(store, applier));
    setState(initialState);
  }, [store, applier]);
  return [client, state, reset];
}
