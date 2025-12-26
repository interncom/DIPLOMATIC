// Envelope is the encrypted message, wrapped with data to support the relay protocol across untrusted hosts.

// The envelope includes a fixed-size header: signature (64), kdm (8), totaling 72 bytes.
// The ciphertext follows without an embedded length field, as its length is part of the encrypted message header.

import type { ICrypto, KeyPair } from "./types.ts";
import { EncryptedMessage, EncodedMessage } from "./message.ts";
import {
  sigBytes,
  hashBytes,
  lenBytes,
  pubKeyBytes,
  kdmBytes,
} from "./consts.ts";
import { Decoder, Encoder } from "./codec.ts";

export interface IEnvelopeHeader {
  sig: Uint8Array;
  kdm: Uint8Array;
  lenCipherHead: number;
  lenCipherBody: number;
}

export interface IEnvelope extends IEnvelopeHeader {
  cipherhead: Uint8Array;
  cipherbody: Uint8Array;
}

export type EncodedEnvelope = Uint8Array;

export function encodeEnvelope(env: IEnvelope): Uint8Array {
  const enc = new Encoder();
  enc.writeBytes(env.sig);
  enc.writeBytes(env.kdm);
  enc.writeVarInt(env.lenCipherHead);
  enc.writeVarInt(env.lenCipherBody);
  enc.writeBytes(env.cipherhead);
  enc.writeBytes(env.cipherbody);
  return enc.result();
}

export async function makeEnvelope(
  keyPair: KeyPair,
  cipherhead: Uint8Array,
  cipherbody: Uint8Array,
  kdm: Uint8Array,
  crypto: ICrypto,
): Promise<IEnvelope> {
  const sig = await crypto.signEd25519(cipherhead, keyPair.privateKey);
  return {
    sig,
    kdm,
    lenCipherHead: cipherhead.length,
    lenCipherBody: cipherbody.length,
    cipherhead,
    cipherbody,
  };
}

export function decodeEnvelopeHeader(encoded: Uint8Array): IEnvelopeHeader {
  const dec = new Decoder(encoded);
  const sig = dec.readBytes(sigBytes);
  const kdm = dec.readBytes(kdmBytes);
  const lenCipherHead = dec.readVarInt();
  const lenCipherBody = dec.readVarInt();
  return { sig, kdm, lenCipherHead, lenCipherBody };
}

export function decodeEnvelope(dec: Decoder): IEnvelope {
  const sig = dec.readBytes(sigBytes);
  const kdm = dec.readBytes(kdmBytes);
  const lenCipherHead = dec.readVarInt();
  const lenCipherBody = dec.readVarInt();
  const cipherhead = dec.readBytes(lenCipherHead);
  const cipherbody = dec.readBytes(lenCipherBody);
  return {
    sig,
    kdm,
    lenCipherHead,
    lenCipherBody,
    cipherhead,
    cipherbody,
  };
}
