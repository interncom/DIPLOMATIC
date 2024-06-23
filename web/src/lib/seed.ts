import { btoh, htob } from "../../../cli/src/lib";

export function loadSeed(): Uint8Array | undefined {
  const storedSeed = localStorage.getItem("seedHex");
  if (storedSeed) {
    const seed = htob(storedSeed);
    return seed;
  }
}

export function storeSeed(seed: Uint8Array) {
  const seedString = btoh(seed);
  localStorage.setItem("seedHex", seedString);
}
