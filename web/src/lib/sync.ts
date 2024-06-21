import { useEffect } from "react";
import type { IOp } from "../../../cli/src/types";
import type DiplomaticClient from "./client";

export function usePollingSync(client: DiplomaticClient | undefined, intervalMillis: number, updatedAt: string | undefined, apply: (delta: IOp<"status">) => void) {
  useEffect(() => {
    if (!client) {
      return;
    }

    async function poll() {
      if (!client) {
        return;
      }
      console.log("Polling")
      await client.processDeltas(updatedAt, apply);
    }

    const handle = setInterval(poll, intervalMillis);
    return () => {
      clearInterval(handle);
    }
  }, [client, intervalMillis, updatedAt, apply])
}
