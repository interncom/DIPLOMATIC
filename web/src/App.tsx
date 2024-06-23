import './App.css'
import SeedConfig from './seedConfig';
import Status from './status';
import HostConfig from './hostConfig';
import useClient from './lib/useClient';

export interface IStatus {
  status: string;
  updatedAt: string;
}

export default function App() {
  const [client, state, resetClient] = useClient();

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
