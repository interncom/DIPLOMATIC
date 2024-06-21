import { useCallback, useEffect, useState } from 'react';
import './App.css'
import DiplomaticClient from "./lib/client";
import { htob } from '../../cli/src/lib';
import { genOp, useStatus } from './lib';
import SeedConfig from './seedConfig';
import type { IOp } from '../../cli/src/types';

export interface IStatus {
  status: string;
  updatedAt: string;
}

function usePollingSync(client: DiplomaticClient | undefined, intervalMillis: number, updatedAt: string | undefined, apply: (delta: IOp<"status">) => void) {
  useEffect(() => {
    if (!client) {
      return;
    }

    async function poll() {
      if (!client) {
        return;
      }
      console.log("Polling")
      await client.processDeltas(updatedAt, apply);
    }

    const handle = setInterval(poll, intervalMillis);
    return () => {
      clearInterval(handle);
    }
  }, [client, intervalMillis, updatedAt, apply])
}

function App() {
  const [status, apply] = useStatus();

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

  usePollingSync(client, 100, status?.updatedAt, apply);

  // Status handling.
  const [statusField, setStatusField] = useState("");
  const handleSubmit = useCallback((evt: React.FormEvent) => {
    const op = genOp(statusField);
    apply(op);

    if (client) {
      client.putDelta(op);
    }

    evt.preventDefault();
  }, [statusField, apply, client]);

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
