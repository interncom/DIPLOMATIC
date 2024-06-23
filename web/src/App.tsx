import { useCallback } from 'react';
import './App.css'
import { genOp, useStatus } from './appState';
import SeedConfig from './seedConfig';
import { usePollingSync } from './lib/sync';
import Status from './status';
import HostConfig from './hostConfig';
import useClient from './lib/useClient';

export interface IStatus {
  status: string;
  updatedAt: string;
}

export default function App() {
  const [status, apply, clearStatus] = useStatus();
  const [client, state, resetClient] = useClient();

  usePollingSync(client, 1000, apply);

  // Status handling.
  const handleSetStatus = useCallback((statStr: string) => {
    const op = genOp(statStr);
    apply(op);
    client?.putDelta(op);
  }, [apply, client])

  function handleLogout() {
    localStorage.clear();
    resetClient();
    clearStatus();
  }

  switch (state) {
    case "loading":
      return null;
    case "seedless":
      return <SeedConfig client={client} />;
    case "hostless":
      return <HostConfig client={client} />;
    case "ready":
      return <Status status={status} onSetStatus={handleSetStatus} onLogout={handleLogout} />;
  }
}
