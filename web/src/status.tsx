import { useState, useCallback } from "react";
import type { IStatus } from "./App";
import DiplomaticClient from "./lib/client";
import { IOp } from "../../cli/src/types";
import { usePollingSync } from "./lib/sync";
import { genOp } from "./appState";

interface IProps {
  client: DiplomaticClient;
  apply: (op: IOp<"status">) => void;
  status: IStatus | undefined;
  onLogout: () => void;
}
export default function Status({ client, apply, status, onLogout }: IProps) {
  const [statusField, setStatusField] = useState("");
  const handleSubmit = useCallback((evt: React.FormEvent) => {
    const op = genOp(statusField);
    apply(op);
    client?.putDelta(op);
    evt.preventDefault();
  }, [statusField]);

  usePollingSync(client, 1000, apply);

  return (
    <>
      <h1>STATUS</h1>
      <h2>{status?.status} ({status?.updatedAt})</h2>
      <form onSubmit={handleSubmit}>
        <input type="text" value={statusField} onChange={(evt) => setStatusField(evt.target.value)} />
      </form>
      <div>
        <button type="button" onClick={onLogout}>logout</button>
      </div>
    </>
  )
}
