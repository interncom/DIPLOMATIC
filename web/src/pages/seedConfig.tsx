import { useState, useCallback, FormEvent } from "react";
import { btoh, htob } from "../../../cli/src/lib";
import { generateSeed } from "../lib/auth";
import type DiplomaticClient from "../lib/client";

interface IProps {
  client: DiplomaticClient;
}
export default function SeedConfig({ client }: IProps) {
  const [seedString, setSeedString] = useState("");
  const [username, setUsername] = useState("default");

  const genSeed = useCallback(() => {
    const seed = generateSeed();
    const seedStr = btoh(seed);
    setSeedString(seedStr);
  }, []);

  const handleInitFormSubmit = useCallback((e: FormEvent) => {
    const seed = htob(seedString);
    client.setSeed(seed);

    // Trigger password save prompt.
    window.location.replace("/");

    e.preventDefault();
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
