// Envelope is the encrypted message, wrapped with data to support the relay protocol across untrusted hosts.

// The envelope includes a fixed-size header: signature (64), kdm (8), totaling 72 bytes.
// The ciphertext follows without an embedded length field, as its length is part of the encrypted message header.

import { Decoder } from "./codec.ts";
import { kdmBytes, sigBytes } from "./consts.ts";
import type {
  ICrypto,
  IEnvelope,
  IEnvelopeHeader,
  IHostCrypto,
  KeyPair,
  PublicKey,
} from "./types.ts";

export async function makeEnvelope(
  keyPair: KeyPair,
  headCph: Uint8Array,
  bodyCph: Uint8Array,
  kdm: Uint8Array,
  crypto: ICrypto,
): Promise<IEnvelope> {
  const sig = await crypto.signEd25519(headCph, keyPair.privateKey);
  return {
    sig,
    kdm,
    lenHeadCph: headCph.length,
    lenBodyCph: bodyCph.length,
    headCph,
    bodyCph,
  };
}

export function decodeEnvelopeHeader(encoded: Uint8Array): IEnvelopeHeader {
  const dec = new Decoder(encoded);
  const sig = dec.readBytes(sigBytes);
  const kdm = dec.readBytes(kdmBytes);
  const lenHeadCph = dec.readVarInt();
  const lenBodyCph = dec.readVarInt();
  return { sig, kdm, lenHeadCph, lenBodyCph };
}

export function envSigValid(
  env: IEnvelope,
  pubKey: PublicKey,
  crypto: IHostCrypto,
): Promise<boolean> {
  return crypto.checkSigEd25519(env.sig, env.headCph, pubKey);
}
