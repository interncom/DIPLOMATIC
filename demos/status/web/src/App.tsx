import './App.css'
import SeedConfig from './pages/seedConfig';
import { DiplomaticClient, idbStore, useStateWatcher, useClientState, useSyncOnResume, type IOp, opMapApplier, StateManager } from '@interncom/diplomatic'
import { useCallback, useState } from 'react';
import ClientStateBar from './clientStateBar';

interface IStatus {
  status: string;
  updatedAt: string;
}

const statusStore = {
  store(status: IStatus) {
    localStorage.setItem("status", status.status);
    localStorage.setItem("updatedAt", status.updatedAt);
  },
  load(): IStatus | undefined {
    const status = localStorage.getItem("status") ?? undefined;
    const updatedAt = localStorage.getItem("updatedAt") ?? undefined;
    if (!status || !updatedAt) {
      return undefined;
    }
    return { status, updatedAt };
  },
  async clear() {
    localStorage.removeItem("status");
  }
}

export interface IStatusOp extends IOp {
  type: "status";
  body: string;
}

const applier = opMapApplier<{ status: IStatusOp }>({
  "status": {
    check: (op: IOp): op is IStatusOp => {
      return op.type === "status" && typeof op.body === "string";
    },
    apply: async (op: IStatusOp) => {
      const curr = statusStore.load();
      if (!curr?.updatedAt || op.ts > curr.updatedAt) {
        const status = op.body;
        statusStore.store({ status, updatedAt: op.ts });
      }
    }
  }
});
const stateManager = new StateManager(applier, statusStore.clear)

const hostURL = "https://diplomatic-cloudflare-host.root-a00.workers.dev";
const store = idbStore;
const client = new DiplomaticClient({ store, stateManager });

export default function App() {
  useSyncOnResume(client);
  const state = useClientState(client);
  const link = useCallback(() => { client.registerAndConnect(hostURL) }, []);

  const status = useStateWatcher(stateManager, "status", statusStore.load);
  const [statusField, setStatusField] = useState("");
  const handleSubmit = useCallback((evt: React.FormEvent) => {
    evt.preventDefault();
    client.upsert("status", statusField);
    setStatusField("");
  }, [statusField]);

  if (!client || !state) {
    return null;
  }

  return (
    <>
      <ClientStateBar state={state} />
      {state.hasSeed ? (
        <>
          <h1>STATUS</h1>
          <div id="status-message">{status?.status}</div>
          <div id="status-timestamp">{status?.updatedAt}</div>
          <form onSubmit={handleSubmit}>
            <input id="status-input" type="text" value={statusField} onChange={(evt) => setStatusField(evt.target.value)} placeholder="Type a message ↵" />
          </form>
          {
            state.hasHost ? (
              <button type="button" onClick={client.disconnect}>UNLINK</button>
            ) : (
              <button type="button" onClick={link}>LINK</button>
            )
          }
          <button type="button" onClick={client.wipe}>EXIT</button>
        </>
      ) : (
        <SeedConfig client={client} />
      )}
    </>
  );
}
