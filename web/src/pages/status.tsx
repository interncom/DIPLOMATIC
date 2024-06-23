import { useState, useCallback } from "react";
import DiplomaticClient from "../lib/client";
import { usePollingSync } from "../lib/sync";
import { genOp, useStatus } from "../appState";

interface IProps {
  client: DiplomaticClient;
  onLogout: () => void;
}
export default function Status({ client, onLogout }: IProps) {
  const [status, apply] = useStatus();
  usePollingSync(client, 1000, apply);

  const [statusField, setStatusField] = useState("");
  const handleSubmit = useCallback((evt: React.FormEvent) => {
    const op = genOp(statusField);
    // TODO: combine these two lines by having the client know how to apply ops.
    // Then it can enqueue the op for sync and immediately apply it locally.
    apply(op);
    client?.putDelta(op);
    evt.preventDefault();
  }, [statusField]);

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
