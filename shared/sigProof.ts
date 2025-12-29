import type { ICrypto, KeyPair, PublicKey } from "./types.ts";
import { pubKeyBytes, sigBytes } from "./consts.ts";
import { Decoder, Encoder } from "./codec.ts";

// ISigProof is a signature and data necessary to verify it.
// The layout is:
// - pubkey (32 bytes)
// - ed25519 signature (64 bytes)
export type EncodedSigProvenData = Uint8Array;

export interface ISigProof {
  pubKey: PublicKey;
  sig: Uint8Array;
}
export interface ISigProvenData extends ISigProof {
  data: Uint8Array;
}

export async function sigProof(
  keyPair: KeyPair,
  data: Uint8Array,
  crypto: ICrypto,
): Promise<ISigProof> {
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
  const enc = new Encoder();
  enc.writeBytes(spdata.pubKey);
  enc.writeBytes(spdata.sig);
  enc.writeBytes(spdata.data);
  return enc.result();
}

export function decodeSigProvenData(
  encoded: EncodedSigProvenData,
): ISigProvenData {
  const dec = new Decoder(encoded);
  const pubKey = dec.readBytes(pubKeyBytes) as PublicKey;
  const sig = dec.readBytes(sigBytes);
  const data = dec.readBytes(encoded.length - dec.consumed());
  return {
    pubKey,
    sig,
    data,
  };
}

export async function verifySigProvenData(
  seed: Uint8Array,
  spdata: ISigProvenData,
  crypto: ICrypto,
): Promise<boolean> {
  // Verify sig match.
  return crypto.checkSigEd25519(spdata.sig, spdata.data, spdata.pubKey);
}
