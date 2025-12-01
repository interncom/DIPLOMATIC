import type { ICrypto, KeyPair } from "./types.ts";
import { sigProof, encodeSigProvenData, type ISigProof } from "./sigProof.ts";

// timestampAuthProof authenticates with a sigproven timestamp.
// The sigproof demonstrates control of the pubKey.
// Host ientifies users by their pubkeys.
export async function timestampAuthProof(
  seed: Uint8Array,
  keyPath: string,
  idx: number,
  ts: Date,
  crypto: ICrypto,
): Promise<EncodedSigProvenData> {
  const timestampMs = ts.getTime();
  const encodedTs = new Uint8Array(8);
  new DataView(encodedTs.buffer).setBigUint64(0, BigInt(timestampMs), false);
  const spdata = {
    ...(await sigProof(seed, keyPath, idx, encodedTs, crypto)),
    data: encodedTs,
  };
  const encoded = await encodeSigProvenData(spdata, crypto);
  return encoded;
}
