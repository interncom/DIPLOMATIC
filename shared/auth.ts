import type { ICrypto, IHostCrypto, KeyPair, PublicKey } from "./types.ts";
import { Decoder, Encoder } from "./codec.ts";
import { clockToleranceMs, Status } from "./consts.ts";
import {
  authTimestampCodec,
  type IAuthTimestamp,
} from "./codecs/authTimestamp.ts";

export type EncodedAuthTimestamp = Uint8Array;

// timestampAuthProof authenticates with a sigproven timestamp.
// The sigproof demonstrates control of the pubKey.
// Host identifies users by their pubkeys.
// Server can reject for timestamp too far from its clock.
// In that case, signal to user that clock is out of sync.
// Clocks must be synchronized to ensure correct op order.

export async function makeAuthTimestamp(
  keys: KeyPair,
  ts: Date,
  crypto: ICrypto,
): Promise<IAuthTimestamp> {
  const enc = new Encoder();
  enc.writeDate(ts);
  const encodedTs = enc.result();
  const sig = await crypto.signEd25519(encodedTs, keys.privateKey);
  return {
    pubKey: keys.publicKey,
    sig,
    timestamp: ts,
  };
}

export async function validateAuthTimestamp(
  authTS: IAuthTimestamp,
  crypto: IHostCrypto,
): Promise<Status> {
  const currentTime = Date.now();
  const tsTime = authTS.timestamp.getTime();
  const diff = Math.abs(currentTime - tsTime);
  if (diff > clockToleranceMs) {
    return Status.ClockOutOfSync;
  }
  const enc = new Encoder();
  enc.writeDate(authTS.timestamp);
  const data = enc.result();
  const sigValid = await crypto.checkSigEd25519(
    authTS.sig,
    data,
    authTS.pubKey,
  );
  if (!sigValid) {
    return Status.InvalidSignature;
  }
  return Status.Success;
}

export async function validateTsAuth(
  tsAuthBytes: Uint8Array,
  crypto: IHostCrypto,
): Promise<[PublicKey, Status]> {
  const dec = new Decoder(tsAuthBytes);
  const authTS = authTimestampCodec.decode(dec);
  const status = await validateAuthTimestamp(authTS, crypto);
  return [authTS.pubKey, status];
}
