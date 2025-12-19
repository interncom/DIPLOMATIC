import type { ICrypto, DerivationSeed } from "./types.ts";
import {
  sigProof,
  encodeSigProvenData,
  type EncodedSigProvenData,
} from "./sigProof.ts";

// timestampAuthProof authenticates with a sigproven timestamp.
// The sigproof demonstrates control of the pubKey.
// Host ientifies users by their pubkeys.
export async function timestampAuthProof(
  derivationSeed: DerivationSeed,
  ts: Date,
  crypto: ICrypto,
): Promise<EncodedSigProvenData> {
  const timestampMs = ts.getTime();
  const encodedTs = new Uint8Array(8);
  new DataView(encodedTs.buffer).setBigUint64(0, BigInt(timestampMs), false);
  const spdata = {
    ...(await sigProof(derivationSeed, encodedTs, crypto)),
    data: encodedTs,
  };
  const encoded = await encodeSigProvenData(spdata, crypto);
  return encoded;
}
