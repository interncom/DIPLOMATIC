import './App.css'
import { useCallback, useState } from 'react';
import { DiplomaticClient, idbStore, type IOp, opMapApplier, StateManager } from '@interncom/diplomatic'
import { ClientStatusBar, InitSeedView, useStateWatcher, useClientState, useSyncOnResume } from '@interncom/diplomatic';
import { IUpsertOp, Verb } from '@interncom/diplomatic';

interface IStatus {
  status: string;
  updatedAt: string;
}

const statusStore = {
  async store(status: IStatus) {
    localStorage.setItem("status", status.status);
    localStorage.setItem("updatedAt", status.updatedAt);
  },
  async load(): Promise<IStatus | undefined> {
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

export interface IStatusOp extends IUpsertOp {
  type: "status";
  body: string;
}

const applier = opMapApplier<{ status: IStatusOp }>({
  "status": {
    check: (op: IOp): op is IStatusOp => {
      return op.type === "status" && op.verb === Verb.UPSERT && typeof op.body === "string";
    },
    apply: async (op: IStatusOp) => {
      const curr = await statusStore.load();
      if (!curr?.updatedAt || op.ts > curr.updatedAt) {
        const status = op.body;
        statusStore.store({ status, updatedAt: op.ts });
      }
    }
  }
});
const stateManager = new StateManager(applier, statusStore.clear)
const client = new DiplomaticClient({ store: idbStore, stateManager });

const hostURL = "https://diplomatic-cloudflare-host.root-a00.workers.dev";

export default function App() {
  useSyncOnResume(client);
  const state = useClientState(client);
  const link = useCallback(() => { client.registerAndConnect(hostURL) }, []);

  const status = useStateWatcher(stateManager, "status", statusStore.load);
  const [statusField, setStatusField] = useState("");
  const handleSubmit = useCallback((evt: React.FormEvent) => {
    evt.preventDefault();
    client.upsert("status", statusField, new Uint8Array());
    setStatusField("");
  }, [statusField]);

  if (!client || !state) {
    return null;
  }

  return (
    <>
      <ClientStatusBar state={state} />
      {state.hasSeed ? (
        <>
          <h1>STATUS</h1>
          <div id="status-message">{status?.status}</div>
          <div id="status-timestamp">{status?.updatedAt}</div>
          <form onSubmit={handleSubmit}>
            <input id="status-input" type="text" value={statusField} onChange={(evt) => setStatusField(evt.target.value)} placeholder="Type a message ↵" />
          </form>
          {
            state.hasHost
              ? <button type="button" onClick={client.disconnect}>UNLINK</button>
              : <button type="button" onClick={link}>LINK</button>
          }
          <button type="button" onClick={client.wipe}>EXIT</button>
        </>
      ) : (
        <InitSeedView client={client} path="/" />
      )}
    </>
  );
}
