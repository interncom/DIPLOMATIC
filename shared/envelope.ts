// Envelope is the encrypted message, wrapped with data to support the relay protocol across untrusted hosts.

// The envelope includes a fixed-size header: signature (64), dkm (32), totaling 96 bytes.
// The ciphertext follows without an embedded length field, as its length is part of the encrypted message header.

import type { ICrypto, KeyPair } from "./types.ts";
import { EncryptedMessage, EncodedMessage } from "./message.ts";
import {
  sigBytes,
  hashBytes,
  lenBytes,
  pubKeyBytes,
  dkmBytes,
} from "./consts.ts";
import { encode_varint, decode_varint } from "./varint.ts";
import { Decoder } from "./codec.ts";

export interface IEnvelopeHeader {
  sig: Uint8Array;
  dkm: Uint8Array;
  lenCipherHead: number;
  lenCipherBody: number;
}

export interface IEnvelope extends IEnvelopeHeader {
  cipherhead: Uint8Array;
  cipherbody: Uint8Array;
}

export type EncodedEnvelope = Uint8Array;

export function encodeEnvelope(env: IEnvelope): Uint8Array {
  const lenHeadVarint = encode_varint(env.lenCipherHead);
  const lenBodyVarint = encode_varint(env.lenCipherBody);
  const total =
    sigBytes +
    dkmBytes +
    lenHeadVarint.length +
    lenBodyVarint.length +
    env.cipherhead.length +
    env.cipherbody.length;
  const encoded = new Uint8Array(total);
  encoded.set(env.sig, 0);
  encoded.set(env.dkm, sigBytes);
  encoded.set(lenHeadVarint, sigBytes + dkmBytes);
  encoded.set(lenBodyVarint, sigBytes + dkmBytes + lenHeadVarint.length);
  encoded.set(
    env.cipherhead,
    sigBytes + dkmBytes + lenHeadVarint.length + lenBodyVarint.length,
  );
  encoded.set(
    env.cipherbody,
    sigBytes +
      dkmBytes +
      lenHeadVarint.length +
      lenBodyVarint.length +
      env.cipherhead.length,
  );
  return encoded;
}

export async function makeEnvelope(
  keyPair: KeyPair,
  cipherhead: Uint8Array,
  cipherbody: Uint8Array,
  dkm: Uint8Array,
  crypto: ICrypto,
): Promise<IEnvelope> {
  const sig = await crypto.signEd25519(cipherhead, keyPair.privateKey);
  return {
    sig,
    dkm,
    lenCipherHead: cipherhead.length,
    lenCipherBody: cipherbody.length,
    cipherhead,
    cipherbody,
  };
}

export function decodeEnvelopeHeader(encoded: Uint8Array): IEnvelopeHeader {
  const decoder = new Decoder(encoded);
  const sig = decoder.readBytes(sigBytes);
  const dkm = decoder.readBytes(dkmBytes);
  const lenCipherHead = decoder.readVarInt();
  const lenCipherBody = decoder.readVarInt();
  return { sig, dkm, lenCipherHead, lenCipherBody };
}

export function decodeEnvelope(encoded: Uint8Array): {
  envelope: IEnvelope;
  consumed: number;
} {
  const decoder = new Decoder(encoded);
  const sig = decoder.readBytes(sigBytes);
  const dkm = decoder.readBytes(dkmBytes);
  const lenCipherHead = decoder.readVarInt();
  const lenCipherBody = decoder.readVarInt();
  const cipherhead = decoder.readBytes(lenCipherHead);
  const cipherbody = decoder.readBytes(lenCipherBody);
  return {
    envelope: {
      sig,
      dkm,
      lenCipherHead,
      lenCipherBody,
      cipherhead,
      cipherbody,
    },
    consumed: decoder.consumed(),
  };
}
