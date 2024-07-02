import { useState, useEffect } from "react";
import type { IDiplomaticClientParams } from "./client";
import type { IDiplomaticClientState, IClientStateStore } from "./types";
import type DiplomaticClient from "./client";

interface IClientHookParams extends Omit<IDiplomaticClientParams, "store"> {
  refreshInterval?: number;
  store?: IClientStateStore;
}

export function useClientState(client: DiplomaticClient) {
  const [state, setState] = useState<IDiplomaticClientState>();
  useEffect(() => {
    async function updateState() {
      const state = await client.getState();
      setState(state);
    }
    client.listener = updateState;
    updateState();
    return () => {
      client.listener = undefined;
    }
  }, [client]);
  return state;
}

export function useSyncOnResume(client: DiplomaticClient) {
  useEffect(() => {
    function handleOnline() {
      client.sync();
    }
    window.addEventListener('online', handleOnline);
    return () => {
      window.removeEventListener('online', handleOnline);
    }
  }, [client]);
}
