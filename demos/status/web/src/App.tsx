import { useState, useCallback } from 'react';
import './App.css'
import {
  htob,
  IEntDB,
  MasterSeed,
  IStateManager,
  Status,
  useClient,
  useStateWatcher,
} from "@interncom/diplomatic";

const seed = htob("0123456789ABCDEF".repeat(4)) as MasterSeed;
const entType = "status";
const host = { handle: new URL("http://localhost:31337"), label: "host" };

function useLatestOfType<T>(
  type: string,
  stateMgr: IStateManager,
  entDB: IEntDB | undefined,
): T | undefined {
  return useStateWatcher(stateMgr, entType, async () => {
    if (!entDB) return;
    const [ents, stat] = await entDB.getEntities<T>({ type });
    if (stat !== Status.Success) return;
    ents?.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    return ents[0]?.body;
  });
}

export default function App() {
  const { client, entDB, stateMgr } = useClient({ host, seed });
  const status = useLatestOfType<string>(entType, stateMgr, entDB) ?? "";

  const [statusField, setStatusField] = useState("");
  const handleSubmit = useCallback(async (evt: React.FormEvent) => {
    evt.preventDefault();
    if (!client) return;
    await client.upsert({ type: "status", body: statusField });
    setStatusField("");
  }, [statusField, client]);

  return (
    <div style={{ width: "100vw", textAlign: "center" }}>
      <h1>STATUS</h1>
      <div id="status-message">{status}</div>
      <form onSubmit={handleSubmit}>
        <input id="status-input" type="text" value={statusField} onChange={(evt) => setStatusField(evt.target.value)} placeholder="Type a message ↵" />
      </form>
      <button type="button" onSubmit={handleSubmit}>Submit</button>
    </div>
  );
}
