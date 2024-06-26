import { useEffect } from "react";
import type DiplomaticClient from "./client";

export function usePollingSync(client: DiplomaticClient, intervalMillis: number) {
  useEffect(() => {
    async function poll() {
      console.log("Polling")
      await client.processDeltas();
    }

    const handle = setInterval(poll, intervalMillis);
    return () => {
      clearInterval(handle);
    }
  }, [client, intervalMillis])
}
