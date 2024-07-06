import './App.css'
import consts from './consts.json';
import { useCallback, useState } from 'react';
import { DiplomaticClient, idbStore, type IOp, opMapApplier, StateManager } from '@interncom/diplomatic'
import { ClientStatusBar, InitSeedView, useStateWatcher, useClientState, useSyncOnResume } from '@interncom/diplomatic';

interface IAppData {
  val: string;
  updatedAt: string;
}

const appStore = {
  store(data: IAppData) {
    localStorage.setItem("value", data.val);
    localStorage.setItem("updatedAt", data.updatedAt);
  },
  load(): IAppData | undefined {
    const val = localStorage.getItem("value") ?? undefined;
    const updatedAt = localStorage.getItem("updatedAt") ?? undefined;
    if (!val || !updatedAt) {
      return undefined;
    }
    return { val, updatedAt };
  },
  async clear() {
    localStorage.removeItem("value");
  }
}

// Customize this to your app.
export interface ICustomOp extends IOp {
  type: "custom";
  body: string;
}

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
const stateManager = new StateManager(applier, appStore.clear)
const client = new DiplomaticClient({ store: idbStore, stateManager });

const hostURL = consts.hostURL;

export default function App() {
  useSyncOnResume(client);
  const state = useClientState(client);
  const link = useCallback(() => { client.registerAndConnect(hostURL) }, []);

  const value = useStateWatcher(stateManager, "custom", appStore.load);
  const [valueField, setValueField] = useState("");
  const handleSubmit = useCallback((evt: React.FormEvent) => {
    evt.preventDefault();
    client.upsert("custom", valueField);
    setValueField("");
  }, [valueField]);

  if (!client || !state) {
    return null;
  }

  return (
    <>
      <ClientStatusBar state={state} />
      {state.hasSeed ? (
        <>
          <h1>APP</h1>
          <div id="value">{value?.val}</div>
          <div id="timestamp">{value?.updatedAt}</div>
          <form onSubmit={handleSubmit}>
            <input id="value-input" type="text" value={valueField} onChange={(evt) => setValueField(evt.target.value)} placeholder="Type a value ↵" />
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
