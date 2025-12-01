// Envelope is the encrypted message, wrapped with data to support the relay protocol across untrusted hosts.

// Op Layout:
// === Plaintext Section [106 bytes] ===
// IDX - host keypair derivation index (0 until rotated) [2 bytes]
// SIG - Ed25519 signature of HASH, using host-specific keypair (determined by IDX) [64 bytes]
// HASH - SHA256 hash of LEN ++ PATH ++ CIPHERHEAD [32 bytes]
// LEN - Byte length of KEYPATH + CIPHERHEAD + CIPHERTEXT [8 bytes]
// === Encrypted Section [76 + LEN bytes] ===
// KEYPATH - Derivation path for encryption key [8 bytes]
// CIPHERHEAD [68 bytes]
// CIPHERTEXT [LEN bytes]

// CIPHERHEAD Layout [68 bytes]
// EID - Entity ID [16 bytes]
// CLK - Wall clock [8 bytes]
// CTR - Counter (CLK ++ CTR form the Hybrid Logical Clock HLC) [4 bytes]
// SHA - SHA256 hash of CIPHERBODY [32 bytes]
// LEN - body size in bytes [8 bytes]
// CIPHERBODY - MSGPACK-encoded application-specific representation of entity [LEN bytes]

// The plaintext header section is only for client/host communication.
// It is host-specific (IDX and SIG).
// The client discards it after downloading and successfully decrypting the op.

// Client only needs to retain KEYPATH, EID, CLK, CTR [36 bytes].
// Rest of the data it can regenerate dynamically.

import type { ICrypto, KeyPair } from "./types.ts";
import { lenBytes, EncryptedMessage, EncodedMessage } from "./message.ts";
import type { ISigProof } from "./sigProof.ts";
import {
  sigBytes,
  shaBytes,
  idxBytes,
  pubKeyBytes,
  keyPathBytes,
} from "./consts.ts";

// Offsets for encoding/decoding
const keyPathOffset = 0;
const idxOffset = keyPathOffset + keyPathBytes;
const pubKeyOffset = idxOffset + idxBytes;
const sigOffset = pubKeyOffset + pubKeyBytes;
const hshOffset = sigOffset + sigBytes;
const lenOffset = hshOffset + shaBytes;
const msgOffset = lenOffset + lenBytes;

export interface IEnvelope extends ISigProof {
  hsh: Uint8Array;
  len: number;
  msg: EncryptedMessage;
}

type EncodedEnvelope = Uint8Array;

const fixedBytes = msgOffset;

export async function encodeEnvelope(op: IEnvelope): Promise<EncodedMessage> {
  const encoded = new Uint8Array(fixedBytes + op.msg.length);

  const view = new DataView(encoded.buffer, encoded.byteOffset);

  // keyPath
  const encoder = new TextEncoder();
  const keyPathBytesData = encoder.encode(op.keyPath.slice(0, keyPathBytes));
  for (let i = 0; i < keyPathBytes; i++) {
    encoded[keyPathOffset + i] =
      i < keyPathBytesData.length ? keyPathBytesData[i] : 0;
  }

  // idx
  view.setBigUint64(idxOffset, BigInt(op.idx), false);

  // pubKey
  encoded.set(op.pubKey, pubKeyOffset);

  // sig
  encoded.set(op.sig, sigOffset);

  // hsh
  encoded.set(op.hsh, hshOffset);

  // len
  view.setBigUint64(lenOffset, BigInt(op.len), false);

  // msg
  encoded.set(op.msg, msgOffset);

  return encoded;
}

export async function makeEnvelope(
  idx: number,
  keyPair: KeyPair, // Based on hostIdx (for rotation)
  cipherOp: EncryptedMessage,
  crypto: ICrypto,
): Promise<IEnvelope> {
  const keyPath = "";
  const keyPathBytesData = new TextEncoder().encode(keyPath.slice(0, 8));
  const len = keyPathBytes + cipherOp.length;

  const hashSrc = new Uint8Array(len);
  hashSrc.set(keyPathBytesData.slice(0, 8), 0);
  hashSrc.set(cipherOp, keyPathBytes);
  const hash = await crypto.sha256Hash(hashSrc);

  const sig = await crypto.signEd25519(hash, keyPair.privateKey);
  return {
    keyPath,
    idx,
    pubKey: keyPair.publicKey,
    sig,
    hsh: hash,
    len,
    msg: cipherOp,
  };
}

export function decodeEnvelope(encoded: EncodedEnvelope): IEnvelope {
  const view = new DataView(encoded.buffer, encoded.byteOffset);

  // keyPath
  const decoder = new TextDecoder();
  let keyPath = decoder
    .decode(encoded.slice(keyPathOffset, keyPathBytes))
    .replace(/\0+$/, "");

  // idx
  const idx = Number(view.getBigUint64(idxOffset, false));

  // pubKey
  const pubKey = encoded.slice(pubKeyOffset, pubKeyOffset + pubKeyBytes);

  // sig
  const sig = encoded.slice(sigOffset, sigOffset + sigBytes);

  // hsh
  const hsh = encoded.slice(hshOffset, hshOffset + shaBytes);

  // len
  const len = Number(view.getBigUint64(lenOffset, false));

  // msg
  const msg = encoded.slice(msgOffset);

  return { keyPath, idx, pubKey, sig, hsh, len, msg };
}
