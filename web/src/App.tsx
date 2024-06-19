import { useCallback, useEffect, useState } from 'react';
import './App.css'
import DiplomaticClient from "./client";
import { deriveAuthKeyPair } from './auth';
import { decrypt, deriveEncryptionKey, encrypt, serialize } from './crypto-browser';
import { htob } from '../../cli/src/lib';
import { load, genOp, apply } from './lib';
import SeedConfig from './seedConfig';
import { decode } from '@msgpack/msgpack';

export interface IStatus {
  status: string;
  updatedAt: string;
}

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

  // Encryption config.
  const encKey = seed ? deriveEncryptionKey(seed) : undefined;

  // Host config.
  const hostURL = "http://localhost:3311";
  const hostID = "id123";
  const keyPair = seed ? deriveAuthKeyPair(hostID, seed) : undefined;
  const client = new DiplomaticClient(new URL(hostURL));
  useEffect(() => {
    // TODO: make the client store keypairs.
    if (keyPair) {
      client.register(keyPair.publicKey, "tok123");

      if (encKey) {
        client.getDeltaPaths(new Date(0), keyPair).then(async (resp) => {
          for (const path of resp.paths) {
            const cipher = await client.getDelta(path, keyPair);
            const deltaPack = decrypt(cipher, encKey)
            const delta = decode(deltaPack) as any;
            if (!status?.updatedAt || delta.ts > status.updatedAt) {
              apply(delta);
            }
            console.log("delta", delta, status?.updatedAt);
          }
        })
      }
    }
  }, [keyPair, client, encKey, status])

  // Status handling.
  const [statusField, setStatusField] = useState("");
  const handleSubmit = useCallback((evt: React.FormEvent) => {
    const op = genOp(statusField);
    apply(op);

    if (encKey && keyPair) {
      const opPack = serialize(op);
      const cipherOp = encrypt(opPack, encKey);
      client.putDelta(cipherOp, keyPair)
    }

    const newStatus = load();
    setStatus(newStatus);

    evt.preventDefault();
  }, [statusField, client.putDelta, encKey, keyPair]);

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
