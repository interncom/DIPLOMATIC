import {
  Clock,
  EntIDB,
  entStateManager,
  hostHTTPTransport,
  htob,
  IStateManager,
  libsodiumCrypto,
  MasterSeed,
  nullStateManager,
  openEntIDB,
  openIDBStore,
  Status,
  SyncClient,
  useStateWatcher,
} from "@interncom/diplomatic";
import { useCallback, useEffect, useState } from "react";

const seed = htob("0123456789ABCDEF".repeat(4)) as MasterSeed;
const entType = "count";
const hostURL = new URL("http://localhost:31337");
const clock = new Clock();

export default function App() {
  const [{ client, entDB, stateMgr }, setDiplomaticState] = useState<{
    client?: SyncClient<URL>;
    entDB?: EntIDB;
    stateMgr: IStateManager;
  }>({ stateMgr: nullStateManager });

  useEffect(() => {
    Promise.all([openIDBStore(libsodiumCrypto), openEntIDB()]).then(
      async ([store, entDB]) => {
        const entMgr = entStateManager(entDB);
        const client = new SyncClient(clock, entMgr, store, hostHTTPTransport);
        await client.setSeed(seed);
        await client.link({ handle: hostURL, label: "host" });
        setDiplomaticState({ client, entDB, stateMgr: entMgr });
      },
    );
  }, []);

  const count = useStateWatcher(stateMgr, entType, async () => {
    if (!entDB) return 0;
    const [ents, stat] = await entDB.getAllOfType<number>(entType);
    if (stat !== Status.Success) return 0;
    if (ents.length === 0) return 0;
    ents.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    return ents[0].body;
  });

  const inc = useCallback(async () => {
    const prev = count ?? 0;
    await client?.upsert({ type: entType, body: prev + 1 });
  }, [client, count]);

  return (
    <div style={{ width: "100vw", textAlign: "center" }}>
      <h1>COUNT</h1>
      <h2>{count}</h2>
      <button type="button" onClick={inc}>+1</button>
    </div>
  );
}
