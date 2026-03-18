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

const seed = htob(
  "0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF",
) as MasterSeed;
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
  );
}
