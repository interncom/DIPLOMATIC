// Envelope is the encrypted message, wrapped with data to support the relay protocol across untrusted hosts.

// === Implicit data (client identifies with host using pubkey, so it already knows this data is implicit in any response to that pubkey) ===
// If relayed indirectly, this data must also be included with the envelope.
// KEYPATH - host keypair derivation keypath [8 bytes]
// IDX - host keypair derivation index (0 until rotated) [8 bytes]
// PUBKEY - host keypair pubkey [32 bytes]

// === Envelope Section [104 bytes] ===
// SIG - Ed25519 signature of MSGHASH, using keypair implied by pubkey client authenticates to host with [64 bytes]
// MSGHASH - SHA256 hash of MSGLEN ++ MSGKEYPATH ++ CIPHERHEAD [32 bytes]
// MSGLEN - Byte length of KEYPATH + CIPHERHEAD + CIPHERTEXT [8 bytes]

// The signed hash and sigproof allow an envelope to be trusted by the client
// regardless of whether it was transmitted over a trusted channel. The envelope
// itself contains its own bona fides.

// === Message Section [44 + LEN bytes + 16 bytes encryption overhead] ===
// MSGKEYPATH - Derivation path for encryption key (truncated SHA256 hash of EID ++ CLK ++ CTR ++ LEN) [8 bytes]
// == Encrypted Section ==
// EID - Entity ID [16 bytes]
// CLK - Wall clock [8 bytes]
// CTR - Counter (CLK ++ CTR form the Hybrid Logical Clock HLC) [4 bytes]
// LEN - body size in bytes [8 bytes]
// BOD - MSGPACK-encoded, application-specific representation of entity [LEN bytes]

// The plaintext header section is only for client/host communication.
// It is host-specific (IDX and SIG).
// The client discards it after downloading and successfully decrypting the op.

// Client only needs to retain EID, CLK, CTR, BOD [36 + LEN bytes].
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

export interface IEnvelopeHeader extends ISigProof {
  hsh: Uint8Array;
  len: number;
}

export interface IEnvelope extends IEnvelopeHeader {
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
  dkm: Uint8Array,
  crypto: ICrypto,
): Promise<IEnvelope> {
  const keyPath = "";
  const keyPathBytesData = new TextEncoder().encode(keyPath.slice(0, 8));
  const msg = new Uint8Array(dkm.length + cipherOp.length);
  msg.set(dkm, 0);
  msg.set(cipherOp, dkm.length);
  const len = keyPathBytes + msg.length;

  const hashSrc = new Uint8Array(len);
  hashSrc.set(keyPathBytesData.slice(0, 8), 0);
  hashSrc.set(msg, keyPathBytes);
  const hash = await crypto.sha256Hash(hashSrc);

  const sig = await crypto.signEd25519(hash, keyPair.privateKey);
  return {
    keyPath,
    idx,
    pubKey: keyPair.publicKey,
    sig,
    hsh: hash,
    len,
    msg,
  };
}

export function decodeEnvelopeHeader(
  encodedHeader: Uint8Array,
): IEnvelopeHeader {
  if (encodedHeader.length < msgOffset) {
    throw new Error("Envelope header too short");
  }

  const view = new DataView(encodedHeader.buffer, encodedHeader.byteOffset);

  // keyPath
  const decoder = new TextDecoder();
  let keyPath = decoder
    .decode(encodedHeader.slice(keyPathOffset, idxOffset))
    .replace(/\0+$/, "");

  const idx = Number(view.getBigUint64(idxOffset, false));
  const pubKey = encodedHeader.slice(pubKeyOffset, sigOffset);
  const sig = encodedHeader.slice(sigOffset, hshOffset);
  const hsh = encodedHeader.slice(hshOffset, lenOffset);
  const len = Number(view.getBigUint64(lenOffset, false));

  return { keyPath, idx, pubKey, sig, hsh, len };
}

export function decodeEnvelope(encoded: EncodedEnvelope): IEnvelope {
  if (encoded.length < msgOffset) {
    throw new Error("Envelope too short");
  }

  const header = decodeEnvelopeHeader(encoded.slice(0, msgOffset));

  // msg
  const msg = encoded.slice(msgOffset);

  return { ...header, msg };
}
