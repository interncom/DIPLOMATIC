import { useEffect, useState } from "react";
import type { IDiplomaticClientParams } from "../client";
import type {
  IClientStateStore,
  IDiplomaticClientState,
  IDiplomaticClientXferState,
} from "../types";
import type DiplomaticClient from "../client";

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
    };
  }, [client]);
  return state;
}

export function useClientXferState(client: DiplomaticClient) {
  const [state, setState] = useState<IDiplomaticClientXferState>();
  useEffect(() => {
    async function updateState() {
      const state = await client.getXferState();
      setState(state);
    }
    client.xferListener = updateState;
    updateState();
    return () => {
      client.xferListener = undefined;
    };
  }, [client]);
  return state;
}

export function useSyncOnResume(client: DiplomaticClient) {
  useEffect(() => {
    async function handleOnline() {
      if (client.hostURL) {
        await client.connect(client.hostURL);
      }
      await client.sync();
    }
    window.addEventListener("online", handleOnline);
    return () => {
      window.removeEventListener("online", handleOnline);
    };
  }, [client]);
}
