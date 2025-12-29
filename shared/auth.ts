import type { ICrypto, IHostCrypto, KeyPair, PublicKey } from "./types.ts";
import { Decoder, Encoder } from "./codec.ts";
import { clockToleranceMs, Status } from "./consts.ts";
import {
  authTimestampCodec,
  type IAuthTimestamp,
} from "./codecs/authTimestamp.ts";

export type EncodedAuthTimestamp = Uint8Array;
export { authTimestampCodec, type IAuthTimestamp };

// timestampAuthProof authenticates with a sigproven timestamp.
// The sigproof demonstrates control of the pubKey.
// Host identifies users by their pubkeys.
// Server can reject for timestamp too far from its clock.
// In that case, signal to user that clock is out of sync.
// Clocks must be synchronized to ensure correct op order.

export async function timestampAuthProof(
  keyPair: KeyPair,
  ts: Date,
  crypto: ICrypto,
): Promise<EncodedAuthTimestamp> {
  const enc = new Encoder();
  enc.writeDate(ts);
  const encodedTs = enc.result();
  const sig = await crypto.signEd25519(encodedTs, keyPair.privateKey);
  const authTs: IAuthTimestamp = {
    pubKey: keyPair.publicKey,
    sig,
    timestamp: ts,
  };
  const finalEnc = new Encoder();
  authTimestampCodec.encode(finalEnc, authTs);
  return finalEnc.result();
}

export async function validateTsAuth(
  tsAuthBytes: Uint8Array,
  crypto: IHostCrypto,
): Promise<[PublicKey, Status]> {
  const dec = new Decoder(tsAuthBytes);
  const authTs = authTimestampCodec.decode(dec);
  const currentTime = Date.now();
  const tsTime = authTs.timestamp.getTime();
  const diff = Math.abs(currentTime - tsTime);
  if (diff > clockToleranceMs) {
    return [new Uint8Array(0) as PublicKey, Status.ClockOutOfSync];
  }
  const enc = new Encoder();
  enc.writeDate(authTs.timestamp);
  const data = enc.result();
  const sigValid = await crypto.checkSigEd25519(
    authTs.sig,
    data,
    authTs.pubKey,
  );
  if (!sigValid) {
    return [new Uint8Array(0) as PublicKey, Status.InvalidSignature];
  }
  return [authTs.pubKey, Status.Success];
}
