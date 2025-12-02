import type { ICrypto, KeyPair } from "./types.ts";
import {
  sigBytes,
  shaBytes,
  idxBytes,
  pubKeyBytes,
  keyPathBytes,
} from "./consts.ts";

// ISigProof is a signature and data necessary to verify it.
// The layout is:
// - keypath (8 bytes)
// - derivation index (8 bytes)
// - pubkey (32 bytes)
// - ed25519 signature (64 bytes)
export type EncodedSigProvenData = Uint8Array;
export interface ISigProof {
  keyPath: string;
  idx: number;
  pubKey: Uint8Array;
  sig: Uint8Array;
}
export interface ISigProvenData extends ISigProof {
  data: Uint8Array;
}

export async function sigProof(
  seed: Uint8Array,
  keyPath: string,
  idx: number,
  data: Uint8Array,
  crypto: ICrypto,
): Promise<ISigProof> {
  const keyPair = await crypto.deriveEd25519KeyPair(seed, keyPath, idx);
  const sig = await crypto.signEd25519(data, keyPair.privateKey);
  return {
    keyPath,
    idx,
    pubKey: keyPair.publicKey,
    sig,
  };
}

const sigProofDataBytes = keyPathBytes + idxBytes + pubKeyBytes + sigBytes;

export function encodeSigProvenData(
  spdata: ISigProvenData,
  crypto: ICrypto,
): EncodedSigProvenData {
  const encoded = new Uint8Array(sigProofDataBytes + spdata.data.length);

  const view = new DataView(encoded.buffer, encoded.byteOffset);

  // First 8 bytes of keyPath string, padded with null bytes
  const encoder = new TextEncoder();
  const keyPathBytes = encoder.encode(spdata.keyPath.slice(0, 8));
  for (let i = 0; i < 8; i++) {
    encoded[i] = i < keyPathBytes.length ? keyPathBytes[i] : 0;
  }

  // idx as an 8 byte integer
  view.setBigUint64(8, BigInt(spdata.idx), false);

  // spdata.pubKey (32 bytes)
  encoded.set(spdata.pubKey, 16);

  // spdata.sig (64 bytes)
  encoded.set(spdata.sig, 48);

  // spdata.data
  encoded.set(spdata.data, sigProofDataBytes);

  return encoded;
}

export function decodeSigProvenData(
  encoded: EncodedSigProvenData,
): ISigProvenData {
  if (encoded.length < sigProofDataBytes) {
    throw new Error("Encoded data too short");
  }

  const view = new DataView(encoded.buffer, encoded.byteOffset);

  // Decode keyPath: first 8 bytes as string, trim trailing nulls
  const decoder = new TextDecoder();
  const keyPathBytes = encoded.slice(0, 8);
  let keyPath = decoder.decode(keyPathBytes).replace(/\0+$/, ""); // Trim trailing nulls

  // Decode idx: 8 bytes starting at offset 8
  const idx = Number(view.getBigUint64(8, false));

  // Decode pubKey: 32 bytes starting at offset 16
  const pubKey = encoded.slice(16, 48);

  // Decode sig: 64 bytes starting at offset 48
  const sig = encoded.slice(48, 112);

  // Decode data: remaining bytes after 112
  const data = encoded.slice(112);

  return {
    keyPath,
    idx,
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
  // Verify pubKey match.
  const keyPair = await crypto.deriveEd25519KeyPair(
    seed,
    spdata.keyPath,
    spdata.idx,
  );
  const pubKeysMatch = uint8ArraysEqual(keyPair.publicKey, spdata.pubKey);
  if (!pubKeysMatch) {
    return false;
  }

  // Verify sig match.
  return crypto.checkSigEd25519(spdata.sig, spdata.data, spdata.pubKey);
}
