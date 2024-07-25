import { DiplomaticClient, libsodiumCrypto, btoh, htob } from "@interncom/diplomatic";
import { IonButton, IonIcon, IonInput, IonItem, IonList } from "@ionic/react";
import { useState, useCallback, type FormEvent } from "react";
import { keyOutline, personOutline } from "ionicons/icons";

interface IProps {
  client: DiplomaticClient;
  path: string; // Where to navigate after setting seed.
}
export default function InitSeedView({ client, path }: IProps) {
  const [seedString, setSeedString] = useState("");
  const [username, setUsername] = useState("");

  const genSeed = useCallback(async () => {
    const seed = await libsodiumCrypto.gen256BitSecureRandomSeed();
    const seedStr = btoh(seed);
    setSeedString(seedStr);
  }, []);

  const handleInitFormSubmit = useCallback(async (e: FormEvent) => {
    e.preventDefault();

    const seed = htob(seedString);
    await client.setSeed(seed);

    // Trigger password save prompt.
    window.location.replace(path);
  }, [seedString, client, path]);

  return (
    <form id="seed" action="/" method="get" onSubmit={handleInitFormSubmit} style={{ display: "flex", flexDirection: "column" }}>
      <IonList inset>
        <IonItem>
          <IonButton fill="clear" expand="full" style={{ width: "100%" }} size="large" onClick={genSeed}>Generate Seed</IonButton>
        </IonItem>
      </IonList>
      <IonList inset style={{ marginTop: 24 }}>
        <IonItem>
          <IonIcon icon={keyOutline} slot="start" />
          <IonInput name="password" type="password" autocomplete="new-password" placeholder="Push generate to pick a seed" value={seedString} onIonInput={(e) => setSeedString(e.target.value as string)} />
        </IonItem>
        <IonItem>
          <IonIcon icon={personOutline} slot="start" />
          <IonInput name="username" type="text" autocomplete="username" placeholder="Choose an account name (not shared)" onIonInput={(e) => setUsername(e.target.value as string)} required />
        </IonItem>
        <IonItem>
          <IonButton fill="clear" expand="full" style={{ width: "100%" }} type="submit" size="large" disabled={!seedString || !username}>Login</IonButton>
        </IonItem>
      </IonList>
    </form>
  )
}
