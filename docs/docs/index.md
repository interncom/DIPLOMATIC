# DIPLOMATIC

<video src="https://pub-baf63544dce04e12a9502ae4f58bdc2b.r2.dev/diplomatic-status-demo-720.mov" controls />

## What

DIPLOMATIC is a framework for building single-user apps that work offline and sync multiple devices, all while end-to-end encrypting their data.

It lets developers focus on the unique functionality of their apps without worrying about how to manage data.

## How

DIPLOMATIC is an implementation of the Event Sourcing architecture. It models each change to an application's state as an object, called an *operation*, or *op* for short. Web developers may recognize this pattern from React's [`useReducer`](https://react.dev/learn/extracting-state-logic-into-a-reducer) hook. With DIPLOMATIC, app developers implement a reducer (called an "applier" in DIPLOMATIC) to process these change ops, and DIPLOMATIC handles queueing and relaying them between devices via an untrusted cloud host.

## Quickstart

```shell
npm install --save @interncom/diplomatic
```

DIPLOMATIC requires [ES Modules](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Modules) support. If you're using [Vite](https://vitejs.dev), you'll need these lines in your `defineConfig` object:

```javascript
build: {
  target: 'es2022',
},
optimizeDeps: { esbuildOptions: { target: 'es2022' } },
```

Create a `StateManager`:

```typescript
import { StateManager } from '@interncom/diplomatic'
const database = { /* ... */ };
const stateMgr = new StateManager(
  async (op) => {
    // Update app database based upon op.type and op.body.
  },
  async () => {
    // Clear app database.
  },
)
```

Initialize a `DiplomaticClient`, with a 64-char hex seed string, a host URL (this one is a demo server, but you can host your own), the state manager you just defined, and `idbStore`:

```typescript
import { DiplomaticClient, idbStore } from '@interncom/diplomatic'
const client = new DiplomaticClient({
  seed: "0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF",
  hostURL: "https://diplomatic-cloudflare-host.root-a00.workers.dev",
  stateManager: stateMgr,
  store: idbStore,
})
```

Observe state changes in response to operations of a particular type with the `useStateWatcher` hook, and modify app state by calling the client's `upsert` method.

```typescript
import { useStateWatcher } from '@interncom/diplomatic'
export default function App() {
  const data = useStateWatcher(stateMgr, "op-type", () => database.data)
  const update = (newData) => client.upsert("op-type", newData)

  // ...
}
```

## Core Features

- Works offline.
- Syncs multiple devices.
- End-to-end encrypts data.
