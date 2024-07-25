import { IonPage, IonContent, IonHeader, IonTitle, IonToolbar, IonBackButton, IonButtons } from "@ionic/react";
import InitSeedView from "./Init";
import { client } from "../client";

export default function Auth() {
  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonButtons slot="start">
            <IonBackButton />
          </IonButtons>
          <IonTitle>Auth</IonTitle>
        </IonToolbar>
      </IonHeader>
      <IonContent className="ion-padding" color="light">
        <InitSeedView client={client} path="/" />
      </IonContent>
    </IonPage>
  );
}
