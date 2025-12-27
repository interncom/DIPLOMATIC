import type { ICrypto, IHostCrypto, KeyPair, PublicKey } from "./types.ts";
import {
  sigProof,
  decodeSigProvenData,
  encodeSigProvenData,
  type EncodedSigProvenData,
} from "./sigProof.ts";
import { Encoder } from "./codec.ts";
import { Status, clockToleranceMs } from "./consts.ts";

// timestampAuthProof authenticates with a sigproven timestamp.
// The sigproof demonstrates control of the pubKey.
// Host ientifies users by their pubkeys.
// Server can reject for timestamp too far from its clock.
// In that case, signal to user that clock is out of sync.
// Clocks must be synchronized to ensure correct op order.
export async function timestampAuthProof(
  keyPair: KeyPair,
  ts: Date,
  crypto: ICrypto,
): Promise<EncodedSigProvenData> {
  const enc = new Encoder();
  enc.writeDate(ts);
  const encodedTs = enc.result();
  const spdata = {
    ...(await sigProof(keyPair, encodedTs, crypto)),
    data: encodedTs,
  };
  const encoded = await encodeSigProvenData(spdata, crypto);
  return encoded;
}

export async function validateTsAuth(
  tsAuthBytes: Uint8Array,
  crypto: IHostCrypto,
): Promise<[PublicKey, Status]> {
  const tsAuth = decodeSigProvenData(tsAuthBytes);
  const timestampMs = new DataView(tsAuth.data.buffer).getBigUint64(0, false);
  const currentTime = Date.now();
  const diff = Math.abs(currentTime - Number(timestampMs));
  if (diff > clockToleranceMs) {
    return [new Uint8Array(0) as PublicKey, Status.ClockOutOfSync];
  }
  const { sig, data, pubKey } = tsAuth;
  const sigValid = await crypto.checkSigEd25519(sig, data, pubKey);
  if (!sigValid) {
    return [new Uint8Array(0) as PublicKey, Status.InvalidSignature];
  }
  return [tsAuth.pubKey, Status.Success];
}
