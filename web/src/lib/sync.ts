import { useEffect } from "react";
import type { IOp } from "../../../cli/src/types";
import type DiplomaticClient from "./client";

export function usePollingSync(client: DiplomaticClient | undefined, intervalMillis: number, apply: (delta: IOp<"status">) => void) {
  useEffect(() => {
    async function poll() {
      console.log("Polling")
      await client?.processDeltas(apply);
    }

    const handle = setInterval(poll, intervalMillis);
    return () => {
      clearInterval(handle);
    }
  }, [client, intervalMillis, apply])
}
