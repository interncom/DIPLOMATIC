import { IClock } from "./clock.ts";
import { Encoder } from "./codec.ts";
import { type IAuthTimestamp } from "./codecs/authTimestamp.ts";
import { clockToleranceMs, Status } from "./consts.ts";
import type { ICrypto, IHostCrypto, KeyPair } from "./types.ts";

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
  clock: IClock,
): Promise<Status> {
  const currentTime = clock.now().getTime();
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
