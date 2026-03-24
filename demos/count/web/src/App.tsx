import {
  htob,
  IEntDB,
  IStateManager,
  MasterSeed,
  Status,
  useClient,
  useStateWatcher,
} from "@interncom/diplomatic";

const seed = htob("0123456789ABCDEF".repeat(4)) as MasterSeed;
const entType = "count";
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
  const count = useLatestOfType<number>(entType, stateMgr, entDB) ?? 0;
  const inc = () => client?.upsert<number>({ type: entType, body: count + 1 });

  return (
    <div style={{ width: "100vw", textAlign: "center" }}>
      <h1>COUNT</h1>
      <h2>{count}</h2>
      <button type="button" onClick={inc}>+1</button>
    </div>
  );
}
