// Envelope is the encrypted message, wrapped with data to support the relay protocol across untrusted hosts.

// === Implicit data (client identifies with host using pubkey, so it already knows this data is implicit in any response to that pubkey) ===
// If relayed indirectly, this data must also be included with the envelope.
// KEYPATH - host keypair derivation keypath [8 bytes]
// IDX - host keypair derivation index (0 until rotated) [8 bytes]
// PUBKEY - host keypair pubkey [32 bytes] (removed, implicit from tsAuth)

// === Envelope Section [104 bytes] ===
// SIG - Ed25519 signature of MSGHASH, using keypair implied by pubkey client authenticates to host with [64 bytes]
// MSGHASH - Blake3 hash of MSGLEN ++ MSGKEYPATH ++ CIPHERHEAD [32 bytes]
// MSGLEN - Byte length of KEYPATH + CIPHERHEAD + CIPHERTEXT [8 bytes]

// The signed hash and sigproof allow an envelope to be trusted by the client
// regardless of whether it was transmitted over a trusted channel. The envelope
// itself contains its own bona fides.

// === Message Section [44 + LEN bytes + 16 bytes encryption overhead] ===
// MSGKEYPATH - Derivation path for encryption key (truncated Blake3 hash of EID ++ CLK ++ CTR ++ LEN) [8 bytes]
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
import { EncryptedMessage, EncodedMessage } from "./message.ts";
import { sigBytes, hashBytes, lenBytes, pubKeyBytes } from "./consts.ts";

// Offsets for encoding/decoding
const sigOffset = 0;
const hshOffset = sigOffset + sigBytes;
const lenOffset = hshOffset + hashBytes;
const msgOffset = lenOffset + lenBytes;

export interface IEnvelopeHeader {
  sig: Uint8Array;
  hsh: Uint8Array;
  len: number;
}

export interface IEnvelope extends IEnvelopeHeader {
  msg: EncryptedMessage;
}

export type EncodedEnvelope = Uint8Array;

const fixedBytes = msgOffset;

export async function encodeEnvelope(op: IEnvelope): Promise<EncodedMessage> {
  const encoded = new Uint8Array(fixedBytes + op.msg.length);

  const view = new DataView(encoded.buffer, encoded.byteOffset);

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
  keyPair: KeyPair, // Based on hostIdx (for rotation)
  cipherOp: EncryptedMessage,
  kdm: Uint8Array,
  crypto: ICrypto,
): Promise<IEnvelope> {
  const msg = new Uint8Array(kdm.length + cipherOp.length);
  msg.set(kdm, 0);
  msg.set(cipherOp, kdm.length);

  const len = msg.length;
  const hash = await crypto.blake3(msg);
  const sig = await crypto.signEd25519(hash, keyPair.privateKey);
  return {
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

  const sig = encodedHeader.slice(sigOffset, hshOffset);
  const hsh = encodedHeader.slice(hshOffset, lenOffset);
  const len = Number(view.getBigUint64(lenOffset, false));

  return { sig, hsh, len };
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
