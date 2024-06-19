import { useState, useCallback } from "react";
import { btoh, htob } from "../../cli/src/lib";
import { generateSeed } from "./auth";

interface IProps {
  setSeed: (seed: Uint8Array) => void;
}
export default function SeedConfig({ setSeed }: IProps) {
  const [seedString, setSeedString] = useState("");

  const genSeed = useCallback(() => {
    const seed = generateSeed();
    const seedStr = btoh(seed);
    setSeedString(seedStr);
  }, []);

  const handleInitFormSubmit = useCallback(() => {
    const seed = htob(seedString);
    setSeed(seed);
    localStorage.setItem("seedHex", seedString);
  }, [seedString, setSeed]);

  return (
    <div>
      <h1>Initialize</h1>
      <form onSubmit={handleInitFormSubmit} style={{ display: "flex", flexDirection: "column" }}>
        <input type="text" value={seedString} onChange={(e) => setSeedString(e.target.value)} />
        <button type="submit">Store</button>
        <button type="button" onClick={genSeed}>Generate</button>
      </form>
    </div>
  )
}
