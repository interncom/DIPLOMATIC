import { useCallback, useEffect, useState } from 'react';
import './App.css'
import DiplomaticClient from "./lib/client";
import { htob } from '../../cli/src/lib';
import { load, genOp, apply } from './lib';
import SeedConfig from './seedConfig';

export interface IStatus {
  status: string;
  updatedAt: string;
}

// function usePollingSync(intervalMillis: number, keyPair?: KeyPair) {
// }

function App() {
  const [status, setStatus] = useState(load());

  // Seed config.
  const [seed, setSeed] = useState<Uint8Array>();
  useEffect(() => {
    const storedSeed = localStorage.getItem("seedHex");
    // TODO: check validity.
    if (storedSeed) {
      const seed = htob(storedSeed);
      setSeed(seed);
    }
  }, []);

  // Host config.
  const [client, setClient] = useState<DiplomaticClient>();
  useEffect(() => {
    async function register() {
      if (!seed) {
        return;
      }
      const hostURL = "http://localhost:3311";
      const client = new DiplomaticClient(seed);
      await client.register(hostURL)
      setClient(client);
    }

    register().catch((err) => {
      console.error("Registering client", err);
    });
  }, [seed]);


  useEffect(() => {
    // TODO: make the client store keypairs.
    if (!client) {
      return;
    }
    client.getDeltas(new Date(0)).then(deltas => {
      for (const delta of deltas) {
        if (!status?.updatedAt || delta.ts > status.updatedAt) {
          apply(delta);
        }
        console.log("delta", delta, status?.updatedAt);
      }
    });
  }, [client, status])

  // Status handling.
  const [statusField, setStatusField] = useState("");
  const handleSubmit = useCallback((evt: React.FormEvent) => {
    const op = genOp(statusField);
    apply(op);

    if (client) {
      client.putDelta(op);
    }

    const newStatus = load();
    setStatus(newStatus);

    evt.preventDefault();
  }, [statusField, client]);

  if (!seed) {
    return <SeedConfig setSeed={setSeed} />
  }

  return (
    <>
      <h1>STATUS</h1>
      <h2>{status?.status} ({status?.updatedAt})</h2>
      <form onSubmit={handleSubmit}>
        <input type="text" value={statusField} onChange={(evt) => setStatusField(evt.target.value)} />
      </form>
    </>
  )
}

export default App
