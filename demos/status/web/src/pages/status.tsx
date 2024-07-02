import { useState, useCallback } from "react";
import { genOp } from "../ops/status";
import { load } from "../models/status";
import { useStateWatcher, type DiplomaticClient } from "@interncom/diplomatic";
import { stateMgr } from "../appState";

interface IProps {
  client: DiplomaticClient;
}
export default function Status({ client }: IProps) {
  const status = useStateWatcher(stateMgr, "status", () => load())

  const [statusField, setStatusField] = useState("");
  const handleSubmit = useCallback((evt: React.FormEvent) => {
    evt.preventDefault();
    const op = genOp(statusField);
    client.apply(op)
  }, [statusField, client]);

  return (
    <>
      <h1>STATUS</h1>
      <h2>{status?.status} ({status?.updatedAt})</h2>
      <form onSubmit={handleSubmit}>
        <input type="text" value={statusField} onChange={(evt) => setStatusField(evt.target.value)} />
      </form>
    </>
  )
}
