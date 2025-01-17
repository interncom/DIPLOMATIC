# diplomatic

Secure sync layer for web apps.

## Usage

```tsx
import { StateManager, useStateWatcher, localStorageStore, DiplomaticClient } from '@interncom/diplomatic'

const appState = { count: 0 };
const stateMgr = new StateManager(async (op) => {
  if (op.type === "count" && typeof op.body === "number") {
    appState.count = op.body;
  }
})

const client = new DiplomaticClient({
  seed: "0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF",
  hostURL: "https://diplomatic-cloudflare-host.root-a00.workers.dev",
  stateManager: stateMgr,
  store: localStorageStore,
});

export default function App() {
  const count = useStateWatcher(stateMgr, "count", () => appState.count)
  const inc = () => client.upsert("count", count + 1)

  return (
    <div style={{ width: "100vw", textAlign: "center" }}>
      <h1>COUNT</h1>
      <h2>{count}</h2>
      <button onClick={inc}>+1</button>
    </div>
  )
}
```

## Development

To deploy npm package: `npm run build && npm run tsc && npm publish --public`.
