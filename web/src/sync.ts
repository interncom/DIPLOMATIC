import { useEffect } from "react";
import type DiplomaticClient from "./client";

export function usePollingSync(client: DiplomaticClient, intervalMillis: number) {
  useEffect(() => {
    if (intervalMillis <= 0) {
      return;
    }
    async function poll() {
      console.log("Polling")
      await client.sync();
    }

    poll();
    const handle = setInterval(poll, intervalMillis);
    return () => {
      clearInterval(handle);
    }
  }, [client, intervalMillis])
}
