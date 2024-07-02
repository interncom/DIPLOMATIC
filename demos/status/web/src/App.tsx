import './App.css'
import SeedConfig from './pages/seedConfig';
import Status from './pages/status';
import { DiplomaticClient, idbStore } from '@interncom/diplomatic'
import { stateMgr } from './appState';
import { useCallback, useState } from 'react';
import { useClientState, useSyncOnResume } from '@interncom/diplomatic';
import ClientStateBar from './clientStateBar';

export interface IStatus {
  status: string;
  updatedAt: string;
}

const hostURL = "https://diplomatic-cloudflare-host.root-a00.workers.dev";

const initClient = new DiplomaticClient({
  store: idbStore,
  stateManager: stateMgr,
});
export default function App() {
  const [client, setClient] = useState(initClient);
  const state = useClientState(client);
  useSyncOnResume(client);
  const logout = useCallback(async () => {
    await client.wipe();
    const newClient = new DiplomaticClient({
      store: idbStore,
      stateManager: stateMgr,
    });
    setClient(newClient);
  }, [client]);

  const register = useCallback(() => {
    client.register(hostURL)
      .then(async () => {
        await client.connect(new URL(hostURL));
        await client.sync();
      })
  }, [client]);


  if (!client || !state) {
    return null;
  }

  if (!state.hasSeed) {
    return (
      <>
        <SeedConfig client={client} />
        <ClientStateBar state={state} />
      </>
    );
  }

  return (
    <>
      <Status client={client} />
      <ClientStateBar state={state} />
      {state.hasHost ? undefined : (
        <div>
          <button type="button" onClick={register}>connect</button>
        </div>
      )}
      <div>
        <button type="button" onClick={logout}>logout</button>
      </div>
    </>
  );
}
