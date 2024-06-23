import { useState, useCallback } from "react";
import type { IStatus } from "./App";

interface IProps {
  status: IStatus | undefined;
  onSetStatus: (statStr: string) => void;
  onLogout: () => void;
}
export default function Status({ status, onSetStatus, onLogout }: IProps) {
  const [statusField, setStatusField] = useState("");
  const handleSubmit = useCallback((evt: React.FormEvent) => {
    onSetStatus(statusField);
    evt.preventDefault();
  }, [onSetStatus, statusField]);

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
