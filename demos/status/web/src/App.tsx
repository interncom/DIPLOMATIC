import './App.css'
import { useCallback, useEffect, useState } from 'react';
import { SyncClient, EntIDB, entStateManager, IDBStore, openIDBStore, hostHTTPTransport, Clock, useStateWatcher, MasterSeed, libsodiumCrypto, Status, StateManager, nullStateManager, IStateManager, htob } from '@interncom/diplomatic'

async function initStoreAndEntDB() {
  const idb = await openIDBStore();
  const store = new IDBStore(idb, libsodiumCrypto);
  const entDB = new EntIDB();
  await entDB.init();
  return { store, entDB };
}

const seed = htob("0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF") as MasterSeed;

export default function App() {
  const [client, setClient] = useState<SyncClient<URL>>();
  const [entDB, setEntityDB] = useState<EntIDB>();
  const [stateMgr, setStateMgr] = useState<IStateManager>(nullStateManager);

  useEffect(() => {
    initStoreAndEntDB().then(async ({ store, entDB }) => {
      const stateManager = entStateManager(entDB);
      const clock = new Clock();
      const client = new SyncClient(clock, stateManager, store, hostHTTPTransport);
      await client.setSeed(seed);
      await client.link({ handle: new URL("http://localhost:31337"), label: "host", idx: 0 });
      await client.connect();
      await client.sync();

      setClient(client);
      setEntityDB(entDB);
      setStateMgr(stateManager);
    });
  }, []);

  const getLatestStatus = useCallback(async () => {
    if (!entDB) return "";
    const [ents, stat] = await entDB.getAllOfType<string>("status");
    if (stat !== Status.Success) {
      return "";
    }
    if (ents.length === 0) return "";
    ents.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    return ents[0].body;
  }, [entDB]);

  const status = useStateWatcher(stateMgr, "status", getLatestStatus);
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
