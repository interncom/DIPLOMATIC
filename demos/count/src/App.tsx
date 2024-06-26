import './App.css'
import useClient from './lib/useClient'
import { StateManager, useStateWatcher } from './lib/state'

const appState = { count: 0 };
const stateMgr = new StateManager((op) => {
  if (op.type === "count" && typeof op.body === "number") {
    appState.count = op.body;
  }
})

export default function App() {
  const [client] = useClient({
    seed: "0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF",
    hostURL: "https://diplomatic-cloudflare-host.root-a00.workers.dev",
    stateManager: stateMgr,
  })
  const count = useStateWatcher(stateMgr, "count", () => appState.count)
  const inc = () => client.upsert("count", count + 1)

  return (
    <>
      <h1>COUNT</h1>
      <h2>{count}</h2>
      <button type="button" onClick={inc}>+1</button>
    </>
  )
}
