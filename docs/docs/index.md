# DIPLOMATIC

<video src="https://pub-baf63544dce04e12a9502ae4f58bdc2b.r2.dev/diplomatic-status-demo-720.mov" controls />

## What

DIPLOMATIC is a framework for building single-user apps that work offline and sync multiple devices, all while end-to-end encrypting their data.

It lets developers focus on the unique functionality of their apps without worrying about how to manage data.

## How

DIPLOMATIC is an implementation of the Event Sourcing architecture. It models each change to an application's state as an object, called an *operation*, or *op* for short. Web developers may recognize this pattern from React's [`useReducer`](https://react.dev/learn/extracting-state-logic-into-a-reducer) hook. With DIPLOMATIC, app developers implement a reducer (called an "applier" in DIPLOMATIC) to process these change ops, and DIPLOMATIC handles queueing and relaying them between devices via an untrusted cloud host.

## Quickstart

### Initialize App

```shell
npm create @interncom/diplomatic
```

`cd` into the directory that creates.

```shell
npm install
npm run dev
```

### Customize

Edit the `src/App.tsx` in the directory that creates. You'll want to change the operation type name `"custom"` to something that describes the type of data your application operates on. You may have multiple operation types.

### StateManager

Edit the `applier` to update your application state in response to operations of whatever types your app needs. Change the `check` and `apply` functions to suit your application logic. `check` verifies that an `IOp` is of a more-specific operation type. `apply` takes an operation of that more-specific type and updates the application state appropriately based on the operation's `body`.

```typescript
const applier = opMapApplier<{ status: ICustomOp }>({
  "custom": {
    check: (op: IOp): op is ICustomOp => {
      return op.type === "custom" && typeof op.body === "string";
    },
    apply: async (op: ICustomOp) => {
      const curr = appStore.load();
      if (!curr?.updatedAt || op.ts > curr.updatedAt) {
        const val = op.body;
        appStore.store({ val, updatedAt: op.ts });
      }
    }
  }
});
```

### UI

Observe state changes in response to operations of a particular type with the `useStateWatcher` hook, and modify app state by calling the client's `upsert` method, which generates a mutation operation (an `UPSERT` rather than a `DELETE`—the only two operation "verbs").

```typescript
import { useStateWatcher } from '@interncom/diplomatic'
export default function App() {
  const data = useStateWatcher(stateMgr, "custom", () => database.data)
  const update = (newData) => client.upsert("custom", newData)

  // ...
}
```

Build an application UI that visualizes the application state and provides the user control mechanisms which trigger `client.upsert` calls to alter the database via operation objects. DIPLOMATIC handles relaying these operations between clients via a cloud host, and also calls the local `applier` defined above with them, to keep all clients in sync.

## Core Features

- Works offline.
- Syncs multiple devices.
- End-to-end encrypts data.
