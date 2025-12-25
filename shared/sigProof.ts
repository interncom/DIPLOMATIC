import type { ICrypto, DerivationSeed } from "./types.ts";
import { sigBytes, pubKeyBytes } from "./consts.ts";
import { Encoder, Decoder } from "./codec.ts";

// ISigProof is a signature and data necessary to verify it.
// The layout is:
// - pubkey (32 bytes)
// - ed25519 signature (64 bytes)
export type EncodedSigProvenData = Uint8Array;

export interface ISigProof {
  pubKey: Uint8Array;
  sig: Uint8Array;
}
export interface ISigProvenData extends ISigProof {
  data: Uint8Array;
}

export async function sigProof(
  derivationSeed: DerivationSeed,
  data: Uint8Array,
  crypto: ICrypto,
): Promise<ISigProof> {
  const keyPair = await crypto.deriveEd25519KeyPair(derivationSeed);
  const sig = await crypto.signEd25519(data, keyPair.privateKey);
  return {
    pubKey: keyPair.publicKey,
    sig,
  };
}

export function encodeSigProvenData(
  spdata: ISigProvenData,
  crypto: ICrypto,
): EncodedSigProvenData {
  const encoder = new Encoder();
  encoder.writeBytes(spdata.pubKey);
  encoder.writeBytes(spdata.sig);
  encoder.writeBytes(spdata.data);
  return encoder.result();
}

export function decodeSigProvenData(
  encoded: EncodedSigProvenData,
): ISigProvenData {
  const decoder = new Decoder(encoded);
  const pubKey = decoder.readBytes(pubKeyBytes);
  const sig = decoder.readBytes(sigBytes);
  const data = decoder.readBytes(encoded.length - decoder.consumed());
  return {
    pubKey,
    sig,
    data,
  };
}

function uint8ArraysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export async function verifySigProvenData(
  seed: Uint8Array,
  spdata: ISigProvenData,
  crypto: ICrypto,
): Promise<boolean> {
  // Verify sig match.
  return crypto.checkSigEd25519(spdata.sig, spdata.data, spdata.pubKey);
}
