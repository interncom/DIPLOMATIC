import { StateManager, useStateWatcher, idbStore, DiplomaticClient, Verb } from '@interncom/diplomatic'

const appState = { count: 0 };
const stateMgr = new StateManager(async (op) => {
  if (op.type === "count" && op.verb === Verb.UPSERT && typeof op.body === "number") {
    appState.count = op.body;
  }
}, async () => { appState.count = 0 })

const client = new DiplomaticClient({
  seed: "0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF",
  hostURL: "https://diplomatic-cloudflare-host.root-a00.workers.dev",
  // hostURL: "http://localhost:3311",
  // hostURL: "http://localhost:8787",
  stateManager: stateMgr,
  store: idbStore,
});

export default function App() {
  const count = useStateWatcher(stateMgr, "count", async () => appState.count)
  const inc = () => client.upsert("count", (count ?? 0) + 1, new Uint8Array())

  return (
    <div style={{ width: "100vw", textAlign: "center" }}>
      <h1>COUNT</h1>
      <h2>{count}</h2>
      <button type="button" onClick={inc}>+1</button>
    </div>
  )
}
