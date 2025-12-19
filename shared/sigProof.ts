import type { ICrypto, DerivationSeed } from "./types.ts";
import { sigBytes, pubKeyBytes } from "./consts.ts";

// ISigProof is a signature and data necessary to verify it.
// The layout is:
// - pubkey (32 bytes)
// - ed25519 signature (64 bytes)
export type EncodedSigProvenData = Uint8Array;

const pubKeyOffset = 0;
const sigOffset = pubKeyOffset + pubKeyBytes;
const dataOffset = sigOffset + sigBytes;
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
  const keyPair =
    await crypto.deriveEd25519KeyPairFromDerivationSeed(derivationSeed);
  const sig = await crypto.signEd25519(data, keyPair.privateKey);
  return {
    pubKey: keyPair.publicKey,
    sig,
  };
}

const sigProofDataBytes = pubKeyBytes + sigBytes;

export function encodeSigProvenData(
  spdata: ISigProvenData,
  crypto: ICrypto,
): EncodedSigProvenData {
  const encoded = new Uint8Array(sigProofDataBytes + spdata.data.length);

  // spdata.pubKey (32 bytes)
  encoded.set(spdata.pubKey, pubKeyOffset);

  // spdata.sig (64 bytes)
  encoded.set(spdata.sig, sigOffset);

  // spdata.data
  encoded.set(spdata.data, dataOffset);

  return encoded;
}

export function decodeSigProvenData(
  encoded: EncodedSigProvenData,
): ISigProvenData {
  if (encoded.length < sigProofDataBytes) {
    throw new Error("Encoded data too short");
  }

  // Decode pubKey: 32 bytes starting at offset 0
  const pubKey = encoded.slice(pubKeyOffset, pubKeyOffset + pubKeyBytes);

  // Decode sig: 64 bytes starting at offset 32
  const sig = encoded.slice(sigOffset, sigOffset + sigBytes);

  // Decode data: remaining bytes after 96
  const data = encoded.slice(sigProofDataBytes);

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
