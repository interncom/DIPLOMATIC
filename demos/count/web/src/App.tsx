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

  const getLatestCount = useCallback(async () => {
    if (!entDB) return 0;
    const [ents, stat] = await entDB.getAllOfType<number>("count");
    if (stat !== Status.Success) {
      return 0;
    }
    if (ents.length === 0) return 0;
    ents.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    return ents[0].body;
  }, [entDB]);

  const count = useStateWatcher(stateMgr, "count", getLatestCount);

  const inc = useCallback(async () => {
    if (!client) return;
    const prev = count ?? 0;
    await client.upsert({ type: "count", body: prev + 1 });
    console.log("inserted")
    try {
      await client.sync();
    } catch (err) {
      console.error("syncerr", err);
    }
    console.log("synced")
  }, [client, count]);

  return (
    <div style={{ width: "100vw", textAlign: "center" }}>
      <h1>COUNT</h1>
      <h2>{count}</h2>
      <button type="button" onClick={inc}>+1</button>
    </div>
  )
}
