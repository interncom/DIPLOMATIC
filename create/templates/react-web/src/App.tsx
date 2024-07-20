import './App.css'
import consts from './consts.json';
import { useCallback, useState } from 'react';
import { DiplomaticClient, htob, idbStore, EntityDB, btoh } from '@interncom/diplomatic'
import { ClientStatusBar, InitSeedView, useStateWatcher, useClientState, useSyncOnResume } from '@interncom/diplomatic';
import Todo from './Todo';

export interface ITodo {
  text: string;
  done?: boolean;
}
const opType = 'todo';

const stateManager = EntityDB.stateManager;
const client = new DiplomaticClient({ store: idbStore, stateManager });

const hostURL = consts.hostURL;

async function getTodos() {
  return EntityDB.db.getAllFromIndex(EntityDB.entityTableName, EntityDB.typeIndexName, IDBKeyRange.only(opType));
}

export default function App() {
  useSyncOnResume(client);
  const state = useClientState(client);
  const link = useCallback(() => { client.registerAndConnect(hostURL) }, []);

  const todos = useStateWatcher(stateManager, opType, getTodos);
  const [valueField, setValueField] = useState("");
  const handleSubmit = useCallback(async (evt: React.FormEvent) => {
    evt.preventDefault();
    const todo: ITodo = { text: valueField };
    client.upsert<ITodo>(opType, todo);
    setValueField("");
  }, [valueField]);

  const handleChange = useCallback(async (eid: string, text: string, done: boolean) => {
    const todo: ITodo = { text, done };
    client.upsert<ITodo>(opType, todo, htob(eid));
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
          <h1>TODO</h1>
          {todos?.map((ent) => {
            const todo = ent.body as ITodo;
            const hex = btoh(ent.eid);
            return <Todo key={hex} eid={hex} todo={todo} onChange={handleChange} onDelete={handleDelete} />;
          })}
          <form onSubmit={handleSubmit} style={{ marginBottom: 48, marginTop: 18 }}>
            <input id="value-input" type="text" value={valueField} onChange={(evt) => setValueField(evt.target.value)} placeholder="Type a todo ↵" style={{ width: "100%", boxSizing: 'border-box', padding: 4 }} />
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
