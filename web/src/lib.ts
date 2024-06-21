import { useCallback, useState } from "react";
import type { IOp } from "../../cli/src/types";
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
    verb: 1,
    ver: 0,
    body: status,
  };
  return op;
}

export function apply(op: IOp<"status">) {
  const status = op.body;
  store({ status, updatedAt: op.ts });
}

export function useStatus(): [IStatus | undefined, (op: IOp<"status">) => void, () => void] {
  const [status, setStatus] = useState<IStatus>();
  const applier = useCallback((op: IOp<"status">) => {
    apply(op);
    const newStatus = load();
    setStatus(newStatus);
  }, []);
  const clear = useCallback(() => {
    setStatus(undefined);
  }, [])
  return [status, applier, clear];
}
