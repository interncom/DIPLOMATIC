import { useState, useCallback } from "react";
import DiplomaticClient from "../lib/client";
import { usePollingSync } from "../lib/sync";
import { genOp } from "../ops/status";
import { useStatus } from "../models/status";

interface IProps {
  client: DiplomaticClient;
  onLogout: () => void;
}
export default function Status({ client, onLogout }: IProps) {
  const [status, refresh] = useStatus();
  usePollingSync(client, 1000);

  const [statusField, setStatusField] = useState("");
  const handleSubmit = useCallback((evt: React.FormEvent) => {
    const op = genOp(statusField);
    client.apply(op)
      .then(refresh);
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
