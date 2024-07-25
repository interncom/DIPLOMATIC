import { IonPage, IonContent, IonHeader, IonTitle, IonToolbar, IonBackButton, IonButtons, IonList, IonItem, IonLabel, IonInput, IonNote, IonFooter } from "@ionic/react";
import consts from '../consts.json';
import { useCallback, useEffect, useState } from 'react';
import { idbStore } from '@interncom/diplomatic'
import { useClientState, useSyncOnResume } from '@interncom/diplomatic';
import '../App.css'
import { client } from "../client";
import ClientStatusBar from "./StatusBar";

export default function Config() {
  useSyncOnResume(client);
  const state = useClientState(client);
  const link = useCallback(() => { client.registerAndConnect(consts.hostURL) }, []);

  const [numOps, setNumOps] = useState<number>();
  useEffect(() => {
    idbStore.listOps().then(ops => setNumOps(ops.length));
  }, []);

  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonButtons slot="start">
            <IonBackButton defaultHref="/" />
          </IonButtons>
          <IonTitle>Config</IonTitle>
        </IonToolbar>
      </IonHeader>
      <IonFooter>
        <IonToolbar>
          {state !== undefined ? <ClientStatusBar state={state} /> : undefined}
        </IonToolbar>
      </IonFooter>
      <IonContent className="ion-padding" color="light">
        <>
          <IonLabel style={{ display: "flex", alignSelf: "left", marginLeft: 32, marginTop: 24 }}>Host</IonLabel>
          <IonList inset style={{ marginTop: 4 }}>
            <IonItem>
              <IonLabel>URL</IonLabel>
              <IonInput disabled style={{ textAlign: "right" }} value={consts.hostURL} />
            </IonItem>
            {
              state?.hasSeed ?
                state.hasHost
                  ? <IonItem button detail={false} onClick={client.disconnect}>UNLINK</IonItem>
                  : <IonItem button detail={false} onClick={link}>LINK</IonItem>
                : undefined
            }
          </IonList>
          <IonLabel style={{ display: "flex", alignSelf: "left", marginLeft: 32, marginTop: 24 }}>Data</IonLabel>
          <IonList inset style={{ marginTop: 4 }}>
            <IonItem>
              <IonLabel>Ops</IonLabel>
              <IonNote>{numOps}</IonNote>
            </IonItem>
            <IonItem>
              <IonLabel>Uploads</IonLabel>
              <IonNote>{state?.numUploads}</IonNote>
            </IonItem>
            <IonItem>
              <IonLabel>Downloads</IonLabel>
              <IonNote>{state?.numDownloads}</IonNote>
            </IonItem>
            {state?.hasSeed ? (
              <>
                <IonItem button detail={false} onClick={() => alert('hi')}>Import</IonItem>
                <IonItem button detail={false} onClick={() => client.export('todo')}>Export</IonItem>
              </>
            ) : undefined}
          </IonList>
          <IonList inset style={{ marginTop: 32 }}>
            <IonItem button detail={false} onClick={() => {
              client.wipe();
              location.pathname = "/auth";
            }}>EXIT</IonItem>
          </IonList>
        </>
      </IonContent>
    </IonPage>
  );
}
