import { useState, useEffect, useCallback } from "react";
import DiplomaticClient from "./client";
import { DiplomaticClientState, IClientStateStore } from "./types";

const initialState: DiplomaticClientState = "loading";

export default function useClient(store: IClientStateStore): [DiplomaticClient, DiplomaticClientState, () => void] {
  const [state, setState] = useState<DiplomaticClientState>(initialState);
  const [client, setClient] = useState(new DiplomaticClient(store));
  useEffect(() => {
    client.listener = setState;
  }, [client]);
  const reset = useCallback(() => {
    setClient(new DiplomaticClient(store));
    setState(initialState);
  }, []);
  return [client, state, reset];
}
