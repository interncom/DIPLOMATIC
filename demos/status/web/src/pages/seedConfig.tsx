import { btoh, type DiplomaticClient, htob, libsodiumCrypto } from "@interncom/diplomatic";
import { useState, useCallback, type FormEvent } from "react";

interface IProps {
  client: DiplomaticClient;
}
export default function SeedConfig({ client }: IProps) {
  const [seedString, setSeedString] = useState("");
  const [username, setUsername] = useState("default");

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
    window.location.replace("/");
  }, [seedString, client]);

  return (
    <div>
      <h1>Initialize</h1>
      <form action="/" method="get" onSubmit={handleInitFormSubmit} style={{ display: "flex", flexDirection: "column" }}>
        <input name="username" type="text" autoComplete="username" placeholder={username} onChange={(e) => setUsername(e.target.value)} required />
        <input name="password" type="password" autoComplete="new-password" value={seedString} onChange={(e) => setSeedString(e.target.value)} />
        <button type="submit">Store</button>
        <button type="button" onClick={genSeed}>Generate</button>
      </form>
    </div>
  )
}
