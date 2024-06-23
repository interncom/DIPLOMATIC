import { useState, useEffect, useCallback } from "react";
import DiplomaticClient, { DiplomaticClientState, IClientStateStore } from "./client";

export default function useClient(store: IClientStateStore): [DiplomaticClient, DiplomaticClientState, () => void] {
  const [state, setState] = useState<DiplomaticClientState>("loading");
  const [client, setClient] = useState(new DiplomaticClient(store));
  useEffect(() => {
    setState(client.state);
    client.listener = setState;
  }, [client]);
  const reset = useCallback(() => {
    setClient(new DiplomaticClient(store));
    setState("loading");
  }, []);
  return [client, state, reset];
}
