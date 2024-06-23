import './App.css'
import SeedConfig from './pages/seedConfig';
import Status from './pages/status';
import HostConfig from './pages/hostConfig';
import useClient from './lib/useClient';
import { localStorageStore } from './lib/localStorageStore';

export interface IStatus {
  status: string;
  updatedAt: string;
}

export default function App() {
  const [client, state, resetClient] = useClient(localStorageStore);

  function handleLogout() {
    localStorage.clear();
    resetClient();
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
