import { useState, useEffect, useCallback } from "react";
import DiplomaticClient, { DiplomaticClientState } from "./client";

export default function useClient(): [DiplomaticClient, DiplomaticClientState, () => void] {
  const [state, setState] = useState<DiplomaticClientState>("loading");
  const [client, setClient] = useState(new DiplomaticClient());
  useEffect(() => {
    setState(client.state);
    client.listener = setState;
  }, [client]);
  const reset = useCallback(() => {
    setClient(new DiplomaticClient());
    setState("loading");
  }, []);
  return [client, state, reset];
}
