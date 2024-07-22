import './App.css'
import consts from './consts.json';
import { useCallback, useState } from 'react';
import { DiplomaticClient, htob, idbStore, EntityDB, btoh } from '@interncom/diplomatic'
import { ClientStatusBar, InitSeedView, useStateWatcher, useClientState, useSyncOnResume } from '@interncom/diplomatic';
import Entry from './Entry';

export interface IEntry {
  text: string;
}
const opType = 'entry';

const stateManager = EntityDB.stateManager;
const client = new DiplomaticClient({ store: idbStore, stateManager });

const hostURL = consts.hostURL;

async function getEntries() {
  const entries = await EntityDB.db.getAllFromIndex(EntityDB.entityTableName, EntityDB.typeIndexName, IDBKeyRange.only(opType));
  return entries.sort((ent1, ent2) => new Date(ent1.createdAt).getTime() - new Date(ent2.createdAt).getTime());
}

export default function App() {
  useSyncOnResume(client);
  const state = useClientState(client);
  const link = useCallback(() => { client.registerAndConnect(hostURL) }, []);

  const entries = useStateWatcher(stateManager, opType, getEntries);
  const [valueField, setValueField] = useState("");
  const handleSubmit = useCallback(async (evt: React.FormEvent) => {
    evt.preventDefault();
    const entry: IEntry = { text: valueField };
    client.upsert<IEntry>(opType, entry);
    setValueField("");
  }, [valueField]);

  const handleChange = useCallback(async (eid: string, entry: IEntry) => {
    client.upsert<IEntry>(opType, entry, htob(eid));
  }, []);

  const handleDelete = useCallback(async (eid: string) => {
    client.delete(opType, htob(eid));
  }, []);

  if (!client || !state) {
    return null;
  }

  return (
    <>
      <ClientStatusBar state={state} />
      {state.hasSeed ? (
        <>
          <h1>DIARY</h1>
          {entries?.map((ent) => {
            const hex = btoh(ent.eid);
            return <Entry key={hex} entity={ent as EntityDB.IEntity<IEntry>} onChange={handleChange} onDelete={handleDelete} />;
          })}
          <form onSubmit={handleSubmit} style={{ marginBottom: 48, marginTop: 18 }}>
            <input id="value-input" type="text" value={valueField} onChange={(evt) => setValueField(evt.target.value)} placeholder="Type a new entry ↵" style={{ width: "100%", boxSizing: 'border-box', padding: 4 }} />
          </form>
          {
            state.hasHost
              ? <button type="button" onClick={client.disconnect}>UNLINK</button>
              : <button type="button" onClick={link}>LINK</button>
          }
          <button type="button" onClick={client.wipe}>EXIT</button>
        </>
      ) : (
        <InitSeedView client={client} path="/" />
      )}
    </>
  );
}
