import { IonPage, IonContent, IonHeader, IonTitle, IonToolbar, IonButton, IonButtons, IonIcon, IonList, IonFooter, IonItem, IonInput, IonCheckbox } from "@ionic/react";
import { useCallback, useState } from 'react';
import { htob, EntityDB, btoh } from '@interncom/diplomatic'
import { useStateWatcher, useClientState, useSyncOnResume } from '@interncom/diplomatic';
import Todo from './Todo';
import '../App.css'
import { cogOutline } from "ionicons/icons";
import { client, stateManager } from "../client";
import ClientStatusBar from "./StatusBar";

export interface ITodo {
  text: string;
  done?: boolean;
}
export const opType = 'todo';

async function getTodos() {
  const todos = await EntityDB.db.getAllFromIndex(EntityDB.entityTableName, EntityDB.typeIndexName, IDBKeyRange.only(opType));
  todos.sort((t1, t2) => t1.createdAt.getTime() - t2.createdAt.getTime());
  return todos;
}

export default function Home() {
  useSyncOnResume(client);
  const state = useClientState(client);

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

  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonButtons slot="end">
            <IonButton routerLink="/config"><IonIcon icon={cogOutline} /></IonButton>
          </IonButtons>
          <IonTitle>TODO</IonTitle>
        </IonToolbar>
      </IonHeader>
      <IonFooter>
        <IonToolbar>
          {state !== undefined ? <ClientStatusBar state={state} /> : undefined}
        </IonToolbar>
      </IonFooter>
      <IonContent className="ion-padding">
        {state?.hasSeed ? (
          <>
            <IonList>
              {todos?.map((ent) => {
                const todo = ent.body as ITodo;
                const hex = btoh(ent.eid);
                return <Todo key={hex} eid={hex} todo={todo} onChange={handleChange} onDelete={handleDelete} />;
              })}
              <form onSubmit={handleSubmit}>
                <IonItem lines="full">
                  <IonCheckbox slot="start" aria-label="Toggle completion" disabled checked={false} />
                  <IonInput id="value-input" type="text" value={valueField} onIonInput={(evt) => setValueField(evt.target.value as string)} placeholder="Type a new todo ↵" style={{ width: "100%", boxSizing: 'border-box', padding: 4 }} />
                </IonItem>
              </form>
            </IonList>
          </>
        ) : (
          <IonButton size="large" routerLink="/auth">Login</IonButton>
        )}
      </IonContent>
    </IonPage>
  );
}
