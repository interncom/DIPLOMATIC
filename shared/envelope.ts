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

const sigBytes = 64;
const shaBytes = 32;
const idxBytes = 4;
const keyPathBytes = 8;

export interface IEnvelope {
  sig: Uint8Array;
  hsh: Uint8Array;
  len: number;
  msg: EncryptedMessage;
}

type EncodedEnvelope = Uint8Array;

export async function encodeEnvelope(
  idx: number,
  op: IEnvelope,
): Promise<EncodedMessage> {
  const encoded = new Uint8Array(
    idxBytes + sigBytes + shaBytes + lenBytes + op.msg.length,
  );

  const view = new DataView(encoded.buffer, encoded.byteOffset);
  view.setUint32(0, idx, false);
  encoded.set(op.sig, idxBytes);
  encoded.set(op.hsh, idxBytes + sigBytes);
  view.setBigUint64(idxBytes + sigBytes + shaBytes, BigInt(op.len), false);
  encoded.set(op.msg, idxBytes + sigBytes + shaBytes + lenBytes);
  return encoded;
}

export async function makeEnvelope(
  keyPair: KeyPair, // Based on hostIdx (for rotation)
  cipherOp: EncryptedMessage,
  crypto: ICrypto,
): Promise<IEnvelope> {
  const keyPath = new Uint8Array(8).fill(0);
  const len = keyPathBytes + cipherOp.length;

  const hashSrc = new Uint8Array(len);
  hashSrc.set(keyPath, 0);
  hashSrc.set(cipherOp, keyPathBytes);
  const hash = await crypto.sha256Hash(hashSrc);

  const sig = await crypto.signEd25519(hash, keyPair.privateKey);
  return {
    sig,
    hsh: hash,
    len,
    msg: cipherOp,
  };
}

export async function decodeEnvelope(
  encoded: EncodedEnvelope,
): Promise<IEnvelope> {
  const view = new DataView(encoded.buffer, encoded.byteOffset);
  // const idx = view.getUint32(0, false); // Not needed in IProtoOpHost
  const sig = encoded.slice(idxBytes, idxBytes + sigBytes);
  const hash = encoded.slice(
    idxBytes + sigBytes,
    idxBytes + sigBytes + shaBytes,
  );
  const len = Number(view.getBigUint64(idxBytes + sigBytes + shaBytes, false));
  const cipherOp = encoded.slice(idxBytes + sigBytes + shaBytes + lenBytes);
  return { sig, hsh: hash, len, msg: cipherOp };
}
