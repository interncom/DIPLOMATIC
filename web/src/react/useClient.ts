import { useEffect, useState } from "react";
import type { SyncClient } from "../client";
import { HostHandle } from "../shared/types";
import type {
  IDiplomaticClientState,
  IDiplomaticClientXferState,
} from "../types";

export function useClientState<Handle extends HostHandle>(
  client: SyncClient<Handle>,
) {
  const [state, setState] = useState<IDiplomaticClientState>();
  useEffect(() => {
    async function updateState() {
      const state = await client.clientState.get();
      setState(state);
    }
    const unsubscribe = client.clientState.listen(updateState);
    updateState();
    return () => {
      unsubscribe();
    };
  }, [client]);
  return state;
}

export function useClientXferState<Handle extends HostHandle>(
  client: SyncClient<Handle>,
) {
  const [state, setState] = useState<IDiplomaticClientXferState>();
  useEffect(() => {
    async function updateState() {
      const state = await client.xferState.get();
      setState(state);
    }
    const unsubscribe = client.xferState.listen(updateState);
    updateState();
    return () => {
      unsubscribe();
    };
  }, [client]);
  return state;
}

export function useSyncOnResume<Handle extends HostHandle>(
  client: SyncClient<Handle>,
) {
  useEffect(() => {
    async function handleOnline() {
      await client.connect();
      await client.sync();
    }
    window.addEventListener("online", handleOnline);
    return () => {
      window.removeEventListener("online", handleOnline);
    };
  }, [client]);
}
