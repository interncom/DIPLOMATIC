import { useCallback, useState } from "react";
import { Verb, type IOp } from "../../cli/src/types";
import type { IStatus } from "./App";

export function store(status: IStatus) {
  localStorage.setItem("status", status.status);
  localStorage.setItem("updatedAt", new Date().toISOString());
}

export function load(): IStatus | undefined {
  const status = localStorage.getItem("status") ?? undefined;
  const updatedAt = localStorage.getItem("updatedAt") ?? undefined;
  if (!status || !updatedAt) {
    return undefined;
  }
  return { status, updatedAt };
}

export function genOp(status: string): IOp<"status"> {
  const op: IOp<"status"> = {
    ts: new Date().toISOString(),
    type: "status",
    verb: Verb.UPSERT,
    ver: 0,
    body: status,
  };
  return op;
}

// Applier MUST transactionally ignore deltas upserting entities modified after the delta timestamp.
export function apply(op: IOp<"status">) {
  const curr = load();
  if (!curr?.updatedAt || op.ts > curr.updatedAt) {
    const status = op.body;
    store({ status, updatedAt: op.ts });
  }
}

export function useStatus(): [IStatus | undefined, (op: IOp<"status">) => void] {
  const [status, setStatus] = useState<IStatus>();
  const applier = useCallback((op: IOp<"status">) => {
    apply(op);
    const newStatus = load();
    setStatus(newStatus);
  }, []);
  return [status, applier];
}
