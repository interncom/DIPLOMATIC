import './App.css'
import SeedConfig from './pages/seedConfig';
import Status from './pages/status';
import { DiplomaticClient, idbStore } from '@interncom/diplomatic'
import { stateMgr } from './appState';
import { useCallback } from 'react';
import { useClientState, useSyncOnResume } from '@interncom/diplomatic';
import ClientStateBar from './clientStateBar';

const hostURL = "https://diplomatic-cloudflare-host.root-a00.workers.dev";
const store = idbStore;
const stateManager = stateMgr;
const client = new DiplomaticClient({ store, stateManager });

export default function App() {
  useSyncOnResume(client);
  const state = useClientState(client);
  const link = useCallback(() => { client.registerAndConnect(hostURL) }, []);

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
      {state.hasHost ? (
        <button type="button" onClick={client.disconnect}>unlink</button>
      ) : (
        <button type="button" onClick={link}>link</button>
      )}
      <button type="button" onClick={client.wipe}>logout</button>
    </>
  );
}
