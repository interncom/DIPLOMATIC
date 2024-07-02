import './App.css'
import SeedConfig from './pages/seedConfig';
import Status from './pages/status';
import HostConfig from './pages/hostConfig';
import { DiplomaticClient, idbStore } from '@interncom/diplomatic'
import { stateMgr } from './appState';
import { useCallback, useEffect, useState } from 'react';
import { useClientState } from '@interncom/diplomatic';

export interface IStatus {
  status: string;
  updatedAt: string;
}

function useSyncOnResume(client: DiplomaticClient) {
  useEffect(() => {
    function handleOnline() {
      client.sync();
    }
    window.addEventListener('online', handleOnline);
    return () => {
      window.removeEventListener('online', handleOnline);
    }
  }, [client]);
}

const initClient = new DiplomaticClient({
  store: idbStore,
  stateManager: stateMgr,
});
export default function App() {
  const [client, setClient] = useState(initClient);
  const state = useClientState(client);
  useSyncOnResume(client);
  const handleLogout = useCallback(async () => {
    await client.store.wipe();
    setClient(new DiplomaticClient({
      store: idbStore,
      stateManager: stateMgr,
    }));
  }, [client]);

  if (!client) {
    return null;
  }

  switch (state) {
    case "loading":
      return null;
    case "seedless":
      return <SeedConfig client={client} />;
    case "hostless":
      return <HostConfig client={client} />;
    case "ready":
      return <Status client={client} onLogout={handleLogout} />;
  }
}
