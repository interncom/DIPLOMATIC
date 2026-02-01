import { StateManager, useStateWatcher, Status, IOp, genWebClient } from '@interncom/diplomatic'

const appState = { count: 0 };
const stateMgr = new StateManager(async (op: IOp) => {
  if (op.type === "count" && typeof op.body === "number") {
    appState.count = op.body;
  }
  return Status.Success;
}, async () => {
  appState.count = 0;
  return Status.Success;
})


const url = new URL("http://localhost:3311");
const { client, setSeed } = await genWebClient(stateMgr, url);
await setSeed("0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF")

const eid = new Uint8Array(16).fill(0);
const clk = new Date(0);

export default function App() {
  const count = useStateWatcher(stateMgr, "count", async () => {
    console.log("state watch", appState)
    return appState.count;
  })
  const inc = async () => {
    const prev = count ?? 0;
    await client.upsert({ type: "count", body: prev + 1, eid, clk, off: prev + 1 });
    console.log("inserted")
    try {
      await client.sync();
    } catch (err) {
      console.error("syncerr", err);
    }
    console.log("synced")
  }

  return (
    <div style={{ width: "100vw", textAlign: "center" }}>
      <h1>COUNT</h1>
      <h2>{count}</h2>
      <button type="button" onClick={inc}>+1</button>
    </div>
  )
}
