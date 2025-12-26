import type { ICrypto, DerivationSeed } from "./types.ts";
import {
  sigProof,
  encodeSigProvenData,
  type EncodedSigProvenData,
} from "./sigProof.ts";
import { Encoder } from "./codec.ts";

// timestampAuthProof authenticates with a sigproven timestamp.
// The sigproof demonstrates control of the pubKey.
// Host ientifies users by their pubkeys.
// Server can reject for timestamp too far from its clock.
// In that case, signal to user that clock is out of sync.
// Clocks must be synchronized to ensure correct op order.
export async function timestampAuthProof(
  derivationSeed: DerivationSeed,
  ts: Date,
  crypto: ICrypto,
): Promise<EncodedSigProvenData> {
  const enc = new Encoder();
  enc.writeDate(ts);
  const encodedTs = enc.result();
  const spdata = {
    ...(await sigProof(derivationSeed, encodedTs, crypto)),
    data: encodedTs,
  };
  const encoded = await encodeSigProvenData(spdata, crypto);
  return encoded;
}
