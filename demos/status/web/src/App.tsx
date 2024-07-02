import './App.css'
import SeedConfig from './pages/seedConfig';
import { DiplomaticClient, idbStore, useStateWatcher } from '@interncom/diplomatic'
import { stateMgr } from './appState';
import { useCallback, useState } from 'react';
import { useClientState, useSyncOnResume } from '@interncom/diplomatic';
import ClientStateBar from './clientStateBar';
import { load } from './models/status';
import { genOp } from './ops/status';

const hostURL = "https://diplomatic-cloudflare-host.root-a00.workers.dev";
const store = idbStore;
const stateManager = stateMgr;
const client = new DiplomaticClient({ store, stateManager });

export default function App() {
  useSyncOnResume(client);
  const state = useClientState(client);
  const link = useCallback(() => { client.registerAndConnect(hostURL) }, []);

  const status = useStateWatcher(stateMgr, "status", () => load())
  const [statusField, setStatusField] = useState("");
  const handleSubmit = useCallback((evt: React.FormEvent) => {
    evt.preventDefault();
    const op = genOp(statusField);
    client.apply(op)
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
            <input id="status-input" type="text" value={statusField} onChange={(evt) => setStatusField(evt.target.value)} placeholder="Type a status message" />
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
