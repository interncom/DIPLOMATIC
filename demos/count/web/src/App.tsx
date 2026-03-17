import { Clock, EntIDB, IDBStore, IStateManager, MasterSeed, Status, SyncClient, entStateManager, hostHTTPTransport, htob, libsodiumCrypto, nullStateManager, openIDBStore, useStateWatcher } from '@interncom/diplomatic';
import { useCallback, useEffect, useState } from 'react';

async function initStoreAndEntDB() {
  // TODO: make async genIDBStore() function to condense to one line.
  const idb = await openIDBStore();
  const store = new IDBStore(idb, libsodiumCrypto);

  // TODO: make async openEntDB() function to condense to one line.
  const entDB = new EntIDB();
  await entDB.init();

  return { store, entDB };
}

const seed = htob("0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF") as MasterSeed;
const entType = "count";

export default function App() {
  // TODO: make these a composite state object and set all at once.
  const [client, setClient] = useState<SyncClient<URL>>();
  const [entDB, setEntityDB] = useState<EntIDB>();
  const [stateMgr, setStateMgr] = useState<IStateManager>(nullStateManager);

  useEffect(() => {
    initStoreAndEntDB().then(async ({ store, entDB }) => {
      const stateManager = entStateManager(entDB);
      const clock = new Clock();
      const client = new SyncClient(clock, stateManager, store, hostHTTPTransport);
      await client.setSeed(seed);
      const url = new URL("http://localhost:31337");
      await client.link({ handle: url, label: "host" });

      // TODO: make these a composite state object and set all at once.
      setClient(client);
      setEntityDB(entDB);
      setStateMgr(stateManager);
    });
  }, []);

  // TODO: implement sort and limit on EntDB EntitiesQuery so this can be a one-liner.
  const getLatestCount = useCallback(async () => {
    if (!entDB) return 0;
    const [ents, stat] = await entDB.getAllOfType<number>(entType);
    if (stat !== Status.Success) return 0;
    if (ents.length === 0) return 0;
    ents.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    return ents[0].body;
  }, [entDB]);

  const count = useStateWatcher(stateMgr, entType, getLatestCount);

  const inc = useCallback(async () => {
    if (!client) return;
    const prev = count ?? 0;
    await client.upsert({ type: entType, body: prev + 1 });
  }, [client, count]);

  return (
    <div style={{ width: "100vw", textAlign: "center" }}>
      <h1>COUNT</h1>
      <h2>{count}</h2>
      <button type="button" onClick={inc}>+1</button>
    </div>
  )
}
